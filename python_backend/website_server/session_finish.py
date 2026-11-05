# -*- coding: utf-8 -*-
"""
结束本轮之后的工作（规格书 15.5、15.6 节，第 5a 阶段）：服务器复算 → 单轮简报，排队进行、可查进度。

流程（网页上显示成三步进度）：
  ① 保存记录：「结束本轮」接口（practice_sessions.finish_session）先把原始记录存好，本轮记为完成；
  ② 服务器复算：按这一轮的事件日志和同一份 1m K 线，用 Python 交易规则把全部成交和盈亏重新算一遍——
     开局参数取自 session_start 事件；起点前最后一根 1m 的收盘价作初始价格（与浏览器开局时相同）；
     逐根 1m 推进，每根之前先执行「回放时刻 ≤ 这根开盘」的操作（浏览器的操作发生在两根 1m 之间，
     记下的回放时刻正是下一根的开盘），账户不在进行中（强平后暂停）就跳过这根；最后执行剩下的操作（结束时的全部平仓）。
     复算顺带记下：每根 1m 收盘后的总资产和交易账户净值（资产曲线、最大回撤）、每笔开仓时的止损、
     开仓后的真实杠杆、每次改止损的前后价位（纪律违规清单用）。
     与浏览器保存的结果逐笔比对（笔数、平仓时刻、出场原因、盈亏），不一致就在简报上标出并记日志；
     trades 表改写成服务器的结果（之后的统计以服务器为准）。
  ③ 生成简报：practice_reports/performance_reports.py + discipline_review.py。
排队：后台只有一个工作线程，一次做一个（小内存 VPS，规格书 8.2 节）。任务状态存在 reports 表（kind = round_brief），
  内容 {status: queued / running / done / failed, step, error, report}；服务器重启后还停在排队或进行中的任务视为中断，
  页面上显示「重新生成」。只有带交易账户的轮次（第 4 阶段以后开的）能生成简报。
"""

from __future__ import annotations

import json
import logging
import threading
from collections import deque

import numpy as np

from python_backend import backend_settings
from python_backend.market_data_downloader import download_common
from python_backend.practice_reports import discipline_review, performance_reports
from python_backend.trading_rules import kline_data
from python_backend.trading_rules import margin_and_liquidation as ml
from python_backend.trading_rules import order_fills_and_costs as of
from python_backend.website_server import practice_sessions, segment_picker, user_database
from python_backend.website_server.practice_sessions import SessionError
from python_backend.website_server.user_database import now_text

logger = logging.getLogger("session_finish")

REPORT_KIND = "round_brief"
STEPS = ["保存记录", "服务器复算成本和盈亏", "生成简报"]
PNL_TOLERANCE = 0.005  # 浏览器与服务器盈亏差在半分钱以内算一致（只是浮点误差）

_lock = threading.Condition()
_queue: deque[tuple[str, str]] = deque()
_running: tuple[str, str] | None = None
_worker: threading.Thread | None = None


# ============================================================
# 复算
# ============================================================

def _load_round(username: str, session_id: str) -> tuple[dict, list[dict], dict]:
    """取这一轮的会话行、交易操作事件（按发生顺序）、开局参数。"""
    with user_database.user_db(username) as db:
        row = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            raise SessionError("找不到这一轮练习（可能已被清除）", 404)
        events = [dict(r) for r in db.execute(
            "SELECT replay_ms, type, payload FROM events WHERE session_id = ? AND type IN ('session_start', 'trade_action')"
            " ORDER BY id", (session_id,))]
    sess = dict(row)
    start = next((json.loads(e["payload"]) for e in events if e["type"] == "session_start"), None)
    if sess["status"] != "completed":
        raise SessionError("这一轮还没有结束", 409)
    if start is None or "leverage" not in start or "account" not in json.loads(sess["state"] or "{}"):
        raise SessionError("这一轮是第 4 阶段之前开的（没有交易账户记录），不能生成简报", 422)
    actions = [{"replay_ms": e["replay_ms"], **json.loads(e["payload"])} for e in events if e["type"] == "trade_action"]
    return sess, actions, start


def _initial_bid(spec: dict, symbol: str, start_ms: int):
    """起点之前最后一根 1m 的收盘价（浏览器开局时用它作初始价格）。"""
    df = kline_data.read_1m_range(backend_settings.KLINE_DIR, spec["data_source"], symbol,
                                  start_ms - 7 * kline_data.TIMEFRAME_MS["1d"], start_ms)
    return float(df["close"].iloc[-1]) if not df.empty else None


class _Recorder:
    """复算过程中顺带记下纪律审查要用的原始事实（第 5a 阶段四类违规，第 5b 阶段补全规格书 7.3 节各项）。
    风险类数字都按整个交易账户算（规格书 7.3 节「资金使用与风险」）：
      真实杠杆 = 全部持仓名义价值 ÷ 净值；保证金占用 = 已用保证金 ÷ 净值；
      止损风险 = 从现价起全部持仓的止损都被打到时还会亏多少（含止损滑点和平仓手续费）÷ 净值，有持仓没设止损记为 None（无上限）；
      强平距离 = |现价 − 强平价| ÷ 现价，没有强平价记为 None。"""

    def __init__(self, spec: dict):
        self.spec = spec
        self.seen: set[int] = set()
        self.open: dict[int, dict] = {}          # 开仓那一刻：止损、止盈、杠杆、保证金占用、止损风险、强平距离
        self.hold: dict[int, dict] = {}          # 持仓期间逐根 1m：最高杠杆及时刻、平均杠杆、最小强平距离、最大止损风险
        self.stop_changes: dict[int, list[dict]] = {}
        self.ever_sl: set[int] = set()
        self.ever_tp: set[int] = set()
        self.equity_before_stop: dict[int, float] = {}
        self.first_sl: dict[int, dict] = {}       # 开仓时没带止损、后来第一次设上止损：时刻和那一刻的止损风险（D72 宽限期用）
        self.decisions: dict[int, int | None] = {}  # 订单号 → 决策用时（毫秒，浏览器记录）
        self.bars_with_position = 0
        self.bars_total = 0
        self._trades_seen = 0

    def risk(self, acc: of.TradingAccount) -> dict:
        m = acc.metrics()
        eq, bid = m["equity"], acc.s["last_bid"]
        stop_loss = 0.0
        unlimited = False
        for p in acc.s["positions"]:
            if p["sl"] is None:
                unlimited = True
                continue
            d = p["direction"]
            fill = of.taker_fill(-d, p["sl"], self.spec)[0]
            stop_loss += (ml.close_price(d, bid, self.spec) - fill) * d * ml.units_of(p["qty"], self.spec)
            stop_loss += of.fill_fee(self.spec, p["qty"], fill, False)
        liq = m["liquidation_price"]
        return {
            "leverage": m["real_leverage"],
            "margin_usage": m["used_margin"] / eq if eq > 0 else None,
            "stop_risk": None if unlimited or eq <= 0 else max(stop_loss, 0.0) / eq,
            "liq_distance": None if liq is None or not bid else abs(bid - liq) / bid,
        }

    def _single_stop_risk(self, tr: dict):
        """同一根 1m 里开平的一笔：止损被打到的亏损（从开仓价起，含止损滑点和平仓手续费）÷ 这根之前的净值。"""
        sl, eq = tr.get("initial_sl"), getattr(self, "_eq_before", None)
        if sl is None or not eq or eq <= 0:
            return None
        d = tr["direction"]
        fill = of.taker_fill(-d, sl, self.spec)[0]
        loss = (tr["entry_price"] - fill) * d * ml.units_of(tr["qty"], self.spec) + of.fill_fee(self.spec, tr["qty"], fill, False)
        return max(loss, 0.0) / eq

    def before_bar(self, acc: of.TradingAccount):
        self.bars_total += 1
        # 止损触发前一刻的净值：这根 1m 处理之前的净值（同一根里成交又被止损的，没有持仓时净值就是余额）
        self._eq_before = acc.metrics()["equity"] if acc.s["positions"] else acc.s["balance"]

    def after_bar(self, acc: of.TradingAccount, t: int):
        """一根 1m 处理完：新开的持仓记开仓快照；持仓中的更新持仓期间的风险；刚被止损的记下触发前一刻的净值。"""
        positions = acc.s["positions"]
        if positions:
            self.bars_with_position += 1
            r = self.risk(acc)
            for p in positions:
                pid = p["id"]
                if pid not in self.seen:
                    self.seen.add(pid)
                    self.open[pid] = {"sl": p["sl"], "tp": p["tp"], **r}
                    if p["sl"] is not None:
                        self.ever_sl.add(pid)
                    if p["tp"] is not None:
                        self.ever_tp.add(pid)
                h = self.hold.setdefault(pid, {"max_leverage": None, "max_leverage_ms": None, "lev_sum": 0.0, "n": 0,
                                               "min_liq_distance": None, "max_stop_risk": 0.0, "stop_unlimited": False})
                lev = r["leverage"]
                if lev is not None:
                    if h["max_leverage"] is None or lev > h["max_leverage"]:
                        h["max_leverage"], h["max_leverage_ms"] = lev, t
                    h["lev_sum"] += lev
                    h["n"] += 1
                if r["liq_distance"] is not None and (h["min_liq_distance"] is None or r["liq_distance"] < h["min_liq_distance"]):
                    h["min_liq_distance"] = r["liq_distance"]
                if r["stop_risk"] is None:
                    h["stop_unlimited"] = True
                else:
                    h["max_stop_risk"] = max(h["max_stop_risk"], r["stop_risk"])
        trades = acc.s["trades"]
        for tr in trades[self._trades_seen:]:
            pid = tr["position_id"]
            if pid not in self.seen:  # 同一根 1m 里开了又平掉：开仓快照只有止损止盈，止损风险按这一笔从开仓价算（D72 重仓要用）
                self.seen.add(pid)
                self.open[pid] = {"sl": tr.get("initial_sl"), "tp": tr.get("tp_at_close"), "leverage": None,
                                  "margin_usage": None, "stop_risk": self._single_stop_risk(tr), "liq_distance": None}
                if tr.get("initial_sl") is not None:
                    self.ever_sl.add(pid)
                if tr.get("tp_at_close") is not None:
                    self.ever_tp.add(pid)
            if tr["close_reason"] in ("stop", "gap_stop") and getattr(self, "_eq_before", None) is not None:
                self.equity_before_stop[pid] = self._eq_before
        self._trades_seen = len(trades)

    def before_action(self, acc: of.TradingAccount, action: dict, ms: int):
        if action.get("op") != "set_stops":
            return
        p = next((x for x in acc.s["positions"] if x["id"] == action.get("position_id")), None)
        if p is None:
            return
        if action.get("sl") is not None:
            self.ever_sl.add(p["id"])
        if action.get("tp") is not None:
            self.ever_tp.add(p["id"])
        if p["sl"] != action.get("sl"):
            self.stop_changes.setdefault(p["id"], []).append({"ms": ms, "old": p["sl"], "new": action.get("sl")})

    def after_action(self, acc: of.TradingAccount, action: dict, returned, payload: dict):
        if action.get("op") in ("market", "pending") and isinstance(returned, int):
            self.decisions[returned] = payload.get("decision_ms")
        pid = action.get("position_id")
        if (action.get("op") == "set_stops" and action.get("sl") is not None and pid in self.open
                and self.open[pid]["sl"] is None and pid not in self.first_sl):
            self.first_sl[pid] = {"ms": payload["replay_ms"], "stop_risk": self.risk(acc)["stop_risk"]}

    def as_dict(self) -> dict:
        return {"open": self.open, "hold": self.hold, "stop_changes": self.stop_changes, "ever_sl": self.ever_sl,
                "ever_tp": self.ever_tp, "equity_before_stop": self.equity_before_stop, "decisions": self.decisions,
                "first_sl": self.first_sl,
                "bars_with_position": self.bars_with_position, "bars_total": self.bars_total}


def recompute(username: str, session_id: str) -> dict:
    """按事件日志重放这一轮，返回服务器的交易账户、资产曲线、纪律审查用的事实、与浏览器的差异。"""
    sess, actions, start = _load_round(username, session_id)
    symbol = sess["symbol"]
    spec = practice_sessions.market_spec(symbol)
    s0, end = sess["segment_start_ms"], sess["replay_ms"]
    acc = of.TradingAccount(of.new_account_state(symbol, start["leverage"], start["trading_balance"],
                                                 start["funding_balance"], s0), spec)
    acc.s["last_bid"] = _initial_bid(spec, symbol, s0)
    bars = kline_data.read_1m_range(backend_settings.KLINE_DIR, spec["data_source"], symbol, s0, end)
    logger.info("复算开始：%s / %s，%d 根 1m，%d 个操作", username, session_id, len(bars), len(actions))
    rec = _Recorder(spec)
    errors: list[str] = []
    n = len(bars)
    curve_ms, curve_total, curve_trading = np.empty(n + 1, dtype=np.int64), np.empty(n + 1), np.empty(n + 1)
    m0 = acc.metrics()
    curve_ms[0], curve_total[0], curve_trading[0] = s0, m0["equity"] + acc.s["funding"], m0["equity"]
    k, ai = 1, 0

    def run_actions(until_ms: int | None):
        nonlocal ai
        while ai < len(actions) and (until_ms is None or actions[ai]["replay_ms"] <= until_ms):
            a = actions[ai]
            ai += 1
            action = a.get("action") or {}
            rec.before_action(acc, action, a["replay_ms"])
            try:
                rec.after_action(acc, action, of.apply_action(acc, action), a)
            except of.TradingRuleError as e:
                errors.append(f"回放时刻 {download_common.fmt_ms(a['replay_ms'])} 的操作 {action.get('op')} 在服务器上被拒绝：{e}")

    ts, o, h, l, c = (bars[col].to_numpy() for col in ("timestamp", "open", "high", "low", "close"))
    for i in range(n):
        t = int(ts[i])
        run_actions(t)
        if acc.s["status"] != "active":
            continue
        rec.before_bar(acc)
        acc.process_bar({"t": t, "o": float(o[i]), "h": float(h[i]), "l": float(l[i]), "c": float(c[i])})
        rec.after_bar(acc, t)
        m = acc.metrics()
        curve_ms[k], curve_total[k], curve_trading[k] = t + kline_data.MINUTE_MS, m["equity"] + acc.s["funding"], m["equity"]
        k += 1
    run_actions(None)
    rec.after_bar(acc, end)
    m = acc.metrics()  # 结束时的全部平仓会扣掉平仓成本，最后一个点按平仓后的资产
    curve_total[k - 1], curve_trading[k - 1] = m["equity"] + acc.s["funding"], m["equity"]
    browser = json.loads(sess["state"]).get("account") or {}
    differences = errors + compare_with_browser(acc.s, browser)
    if differences:
        logger.warning("复算与浏览器结果不一致：%s / %s：%s", username, session_id, "；".join(differences[:5]))
    else:
        logger.info("复算完成且与浏览器一致：%s / %s，%d 笔", username, session_id, len(acc.s["trades"]))
    return {"sess": sess, "spec": spec, "account": acc.s, "curve": (curve_ms[:k], curve_total[:k], curve_trading[:k]),
            "recorder": rec, "differences": differences}


def compare_with_browser(server: dict, browser: dict) -> list[str]:
    """逐笔比对服务器和浏览器的交易（笔数、平仓时刻、出场原因、盈亏）和最终余额；返回差异说明。"""
    out: list[str] = []
    st = {t["position_id"]: t for t in server.get("trades", [])}
    bt = {t["position_id"]: t for t in browser.get("trades", [])}
    if len(st) != len(bt):
        out.append(f"交易笔数不同：服务器 {len(st)} 笔，浏览器 {len(bt)} 笔")
    for pid in sorted(set(st) & set(bt)):
        a, b = st[pid], bt[pid]
        if a["close_ms"] != b["close_ms"] or a["close_reason"] != b["close_reason"] or abs(a["pnl"] - b["pnl"]) > PNL_TOLERANCE:
            out.append(f"持仓 {pid}：服务器 {a['close_reason']} 盈亏 {a['pnl']:.2f}，浏览器 {b['close_reason']} 盈亏 {b['pnl']:.2f}")
    if browser and abs(server["balance"] - browser.get("balance", server["balance"])) > PNL_TOLERANCE:
        out.append(f"最终余额不同：服务器 {server['balance']:.2f}，浏览器 {browser['balance']:.2f}")
    return out


# ============================================================
# 生成简报
# ============================================================

def generate_report(username: str, session_id: str, on_step=None) -> dict:
    """复算并生成单轮简报（同步执行；排队的工作线程和测试都调用它）。on_step(序号) 用于更新进度。"""
    if on_step:
        on_step(2)
    r = recompute(username, session_id)
    sess, spec, account = r["sess"], r["spec"], r["account"]
    with user_database.user_db(username) as db:
        practice_sessions._write_trades(db, session_id, sess["symbol"], account)  # 之后的统计以服务器结果为准
    user_database.refresh_user_symbol_stats(username, sess["symbol"])
    if on_step:
        on_step(3)
    settings = practice_sessions.load_settings()
    idx = segment_picker.get_bar_index(sess["symbol"], sess["start_timeframe"], sess["day_anchor"])
    rec = r["recorder"].as_dict()
    cfg = settings["discipline_review"]
    facts = discipline_review.trade_facts(account["trades"], rec, idx.opens, spec, settings)
    violations = discipline_review.round_violations(facts, cfg)
    streaks = discipline_review.loss_streaks(facts, idx.opens, settings["discipline_review"]["loss_streak_min"])
    curve_ms, curve_total, curve_trading = r["curve"]
    initial = sess.get("initial_total_assets")
    ret = (account["balance"] + account["funding"] - initial) / initial if initial else None
    summary = discipline_review.round_summary(facts, streaks, sess["bars_played"], rec, cfg, ret,
                                              performance_reports.max_drawdown(curve_total)[1])
    return performance_reports.round_brief(sess, account, curve_ms, curve_total, curve_trading, violations, r["differences"],
                                           spec, facts, summary, round_number(username, session_id, sess["symbol"]))


def round_number(username: str, session_id: str, symbol: str) -> int:
    """这一轮是该品种完成的第几轮（按完成时间；统计与审查页的横轴 #001…）。"""
    with user_database.user_db(username) as db:
        ids = [r["id"] for r in db.execute("SELECT id FROM sessions WHERE symbol = ? AND status = 'completed'"
                                           " ORDER BY finished_at, created_at, id", (symbol,))]
    return ids.index(session_id) + 1 if session_id in ids else len(ids) + 1


def _save(username: str, session_id: str, payload: dict) -> None:
    with user_database.user_db(username) as db:
        db.execute("DELETE FROM reports WHERE session_id = ? AND kind = ?", (session_id, REPORT_KIND))
        db.execute("INSERT INTO reports(session_id, kind, created_at, payload) VALUES (?, ?, ?, ?)",
                   (session_id, REPORT_KIND, now_text(), json.dumps(payload, ensure_ascii=False)))


def _run_job(username: str, session_id: str) -> None:
    def step(i: int):
        _save(username, session_id, {"status": "running", "step": i})
    try:
        report = generate_report(username, session_id, step)
        _save(username, session_id, {"status": "done", "step": len(STEPS) + 1, "report": report})
        logger.info("简报已生成：%s / %s", username, session_id)
    except SessionError as e:
        _save(username, session_id, {"status": "failed", "step": 0, "error": str(e)})
    except Exception as e:  # noqa: BLE001  任何意外都要落成「失败 + 原因」，不能让任务卡在进行中
        logger.exception("简报生成失败：%s / %s", username, session_id)
        _save(username, session_id, {"status": "failed", "step": 0, "error": f"生成失败：{e}"})


def _work_loop() -> None:
    global _running
    while True:
        with _lock:
            while not _queue:
                _lock.wait()
            _running = _queue.popleft()
        try:
            _run_job(*_running)
        finally:
            with _lock:
                _running = None


def request_report(username: str, session_id: str) -> dict:
    """把这一轮的简报排进队列（结束本轮后、或点「重新生成」时调用）。"""
    global _worker
    sess, _, _ = _load_round(username, session_id)  # 先检查能不能生成，不能就直接报原因
    key = (username, session_id)
    with _lock:
        if key == _running or key in _queue:
            return report_status(username, session_id)
        _save(username, session_id, {"status": "queued", "step": 1})
        _queue.append(key)
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work_loop, name="report-worker", daemon=True)
            _worker.start()
        _lock.notify()
    logger.info("简报排队：%s / %s（%s）", username, session_id, sess["symbol"])
    return report_status(username, session_id)


def report_status(username: str, session_id: str) -> dict:
    """进度和结果：status、step（1–3 进行到第几步，4 = 完成）、queue_ahead（前面还有几个任务）、error、report。"""
    with user_database.user_db(username) as db:
        row = db.execute("SELECT payload FROM reports WHERE session_id = ? AND kind = ?", (session_id, REPORT_KIND)).fetchone()
    if row is None:
        return {"status": "none", "steps": STEPS}
    payload = json.loads(row["payload"])
    key = (username, session_id)
    with _lock:
        alive = key == _running or key in _queue
        ahead = list(_queue).index(key) + (1 if _running else 0) if key in _queue else 0
    if payload["status"] in ("queued", "running") and not alive:
        payload = {"status": "failed", "step": 0, "error": "任务被中断（服务器重启过），请重新生成"}
    if payload["status"] == "done" and (payload.get("report") or {}).get("version", 1) < performance_reports.REPORT_VERSION:
        payload = _upgrade(username, session_id, payload)
    if payload["status"] == "done":
        payload = {**payload, "practice_date": _practice_date(username, session_id)}
    return {**payload, "queue_ahead": ahead, "steps": STEPS}


def _practice_date(username: str, session_id: str) -> str | None:
    """这一轮是哪天练完的（按用户设置页的显示时区；简报标题用，不存进简报，时区改了也跟着变）。"""
    with user_database.user_db(username) as db:
        row = db.execute("SELECT finished_at FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return user_database.local_date(row["finished_at"] if row else None, user_database.utc_offset_hours(username))


def _upgrade(username: str, session_id: str, payload: dict) -> dict:
    """旧版本的简报（纪律规则改过，如 D72）打开时当场按新规则重新生成；生成不了就照旧显示旧的。"""
    try:
        new = {"status": "done", "step": len(STEPS) + 1, "report": generate_report(username, session_id)}
    except SessionError as e:
        logger.warning("旧简报没能按新版本重新生成：%s / %s：%s", username, session_id, e)
        return payload
    _save(username, session_id, new)
    logger.info("打开简报时按新版本重新生成：%s / %s", username, session_id)
    return new


def report_states(username: str) -> dict[str, str]:
    """每一轮简报的状态（历史练习列表用，不含简报内容）。"""
    with user_database.user_db(username) as db:
        rows = db.execute("SELECT session_id, json_extract(payload, '$.status') AS s FROM reports WHERE kind = ?",
                          (REPORT_KIND,)).fetchall()
    return {r["session_id"]: r["s"] for r in rows}
