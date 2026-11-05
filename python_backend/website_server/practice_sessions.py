# -*- coding: utf-8 -*-
"""
练习轮次的一生（规格书 5.2、5.4、5.5、15.4 节）：开新一轮、取 K 线、保存进度、占用标签页、结束、过期清理。

数据怎么给浏览器（模拟全部在浏览器里算，D1）：
  - 开局：起始周期的背景 K 线（起点之前已收盘的 N 根）+「引子」1m（起点之前、所在日线开盘以来的 1m，
    切到大周期时用来合成正在形成的半根）+ 起点之后约 3 个交易日的 1m（「未来」，按需逐根揭开）；
  - 往后：浏览器剩余未来 1m 不足约 30% 时再要下一段 1m；切换周期或往左拖时，要某周期在某时刻之前已收盘的 K 线。
  - 时间戳是真实的（盲练只在界面上隐藏，规格书 5.3 节已知局限）。
同一用户同一时间只能有一轮进行中；同一轮只允许一个标签页操作：每次开局或「接管」都发一张新的占用凭证（lease），
旧标签页再保存时会被拒绝（HTTP 409），页面变只读并提示「已在别处打开」。
交易账户（第 4 阶段）：开局时按杠杆和两个账户的初始资金建好账户状态，存在 sessions.state["account"]；
之后由浏览器按交易规则推进并随进度一起保存（模拟在浏览器里算，D1）；结束本轮时把已平仓的交易写进 trades 表。
画线（第 4b 阶段，D64）：按轮次存在 drawings 表，有改动时随「保存进度」一起送来（共用占用凭证检查和断网重试），
断点续练时随初始数据一起返回；不满 300 根被丢弃的轮次连画线一起删除。
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from python_backend import backend_settings
from python_backend.market_data_downloader import download_common
from python_backend.trading_rules import kline_data
from python_backend.trading_rules import order_fills_and_costs
from python_backend.website_server import segment_picker, user_database
from python_backend.website_server.user_database import now_text

logger = logging.getLogger("practice_sessions")

MAX_HISTORY_BARS = 2000
MAX_ACCOUNT_AMOUNT = 10_000_000  # 初始资金上限（防止输错多打几个 0）
END_REASONS = ("normal", "liquidation", "latest_data", "auto_after_days")


class SessionError(Exception):
    """会话相关的业务错误；status 为建议的 HTTP 状态码。"""

    def __init__(self, message: str, status: int = 400, extra: dict | None = None):
        super().__init__(message)
        self.status = status
        self.extra = extra or {}


def load_settings() -> dict:
    with open(backend_settings.COMMON_SETTINGS_DIR / "default_settings.json", encoding="utf-8") as f:
        return json.load(f)


def market_spec(symbol: str) -> dict:
    specs = download_common.load_market_specs()
    if symbol not in specs:
        raise SessionError(f"没有这个品种：{symbol}", 404)
    return specs[symbol]


def data_end_ms(spec: dict, symbol: str) -> int:
    """已写入数据的终点（最后一个完整月份的月末，不含）。"""
    meta = download_common.read_meta(spec["data_source"], symbol)
    months = sorted(k for k, v in meta.get("months", {}).items() if v.get("status") in ("complete", "warnings"))
    if not months:
        raise SessionError(f"{symbol} 还没有任何行情数据", 409)
    return kline_data.month_bounds_ms(months[-1])[1]


def _row_to_dict(row) -> dict:
    d = dict(row)
    d["timeframes_used"] = json.loads(d["timeframes_used"])
    d["state"] = json.loads(d["state"])
    d.pop("lease_token", None)
    return d


def _event(db, session_id: str, replay_ms: int, kind: str, payload: dict | None = None) -> None:
    db.execute("INSERT INTO events(session_id, replay_ms, real_at, type, payload) VALUES (?, ?, ?, ?, ?)",
               (session_id, replay_ms, now_text(), kind, json.dumps(payload or {}, ensure_ascii=False)))


# ============================================================
# K 线
# ============================================================

def bars_to_json(df: pd.DataFrame, precision: int) -> list[list]:
    """紧凑格式：[开盘时刻(UTC 秒), 开, 高, 低, 收]，省流量。"""
    if df.empty:
        return []
    arr = df[["timestamp", "open", "high", "low", "close"]].to_numpy()
    return [[int(r[0] // 1000), round(float(r[1]), precision), round(float(r[2]), precision),
             round(float(r[3]), precision), round(float(r[4]), precision)] for r in arr]


def closed_bars_before(spec: dict, symbol: str, timeframe: str, day_anchor: str, end_ms: int, count: int) -> pd.DataFrame:
    """
    某周期在 end_ms 之前「已收盘」的最后 count 根（收盘时刻 = 开盘 + 周期 ≤ end_ms）。
    从 end_ms 往前按需扩大读取范围，只读覆盖到的月份文件。
    """
    tf_ms = kline_data.TIMEFRAME_MS[timeframe]
    week_start = spec.get("week_start", "monday")
    first_month_start = kline_data.month_bounds_ms(spec.get("chart_history_start", spec["history_start"]))[0]  # D74：背景可以往前看到这里
    span = max(count * tf_ms * 2, 4 * kline_data.TIMEFRAME_MS["1d"])
    while True:
        start = max(first_month_start, end_ms - span)
        # 从一根完整周期的开盘读起，避免第一根被截成半根
        start = int(kline_data.bucket_open_ms(pd.Series([start]), timeframe, day_anchor, week_start).iloc[0])
        bars = kline_data.synthesize_by_month(backend_settings.KLINE_DIR, spec["data_source"], symbol, start, end_ms,
                                              timeframe, day_anchor, week_start)
        bars = bars[(bars["timestamp"] >= start) & (bars["timestamp"] + tf_ms <= end_ms)]
        if len(bars) >= count or start <= first_month_start:
            return bars.tail(count).reset_index(drop=True)
        span *= 2


def one_minute_from(spec: dict, symbol: str, from_ms: int, max_bars: int, data_end: int) -> tuple[pd.DataFrame, bool]:
    """从 from_ms 起最多 max_bars 根 1m（按月往后读）。返回 (数据, 是否已到数据终点)。"""
    parts, got, cursor = [], 0, from_ms
    while got < max_bars and cursor < data_end:
        month_end = kline_data.month_bounds_ms(kline_data.month_key_of(cursor))[1]
        part = kline_data.read_1m_range(backend_settings.KLINE_DIR, spec["data_source"], symbol, cursor, min(month_end, data_end))
        parts.append(part)
        got += len(part)
        cursor = month_end
    df = pd.concat(parts, ignore_index=True).head(max_bars) if parts else kline_data.empty_1m_frame()
    reached_end = len(df) < max_bars
    return df, reached_end


def future_chunk_bars(spec: dict, settings: dict) -> int:
    """「约 3 个交易日」换算成 1m 根数：7×24 品种每天 1440 根，黄金按 1380 根。"""
    per_day = 1440 if spec["platform"] == "binance" else 1380
    return settings["replay"]["prefetch_trading_days"] * per_day


# ============================================================
# 开局
# ============================================================

def active_session(username: str) -> dict | None:
    with user_database.user_db(username) as db:
        row = db.execute("SELECT * FROM sessions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").fetchone()
    return _row_to_dict(row) if row else None


def account_params(spec: dict, account: dict | None) -> tuple[float, float, float]:
    """检查开局的杠杆和两个账户初始资金（规格书 5.1 节），缺的用默认值。返回 (杠杆, 交易账户, 资金账户)。"""
    account = account or {}
    lev_cfg = spec["leverage"]
    leverage = float(account.get("leverage") or lev_cfg["default"])
    if not lev_cfg["min"] <= leverage <= lev_cfg["max"]:
        raise SessionError(f"杠杆应在 {lev_cfg['min']}–{lev_cfg['max']} 倍之间", 422)
    defaults = load_settings()["practice_start"]["account"]
    trading = float(account.get("trading_balance", defaults["trading_balance"]))
    funding = float(account.get("funding_balance", defaults["funding_balance"]))
    if not 0 < trading <= MAX_ACCOUNT_AMOUNT:
        raise SessionError(f"交易账户初始资金应大于 0、不超过 {MAX_ACCOUNT_AMOUNT:,}", 422)
    if not 0 <= funding <= MAX_ACCOUNT_AMOUNT:
        raise SessionError(f"资金账户初始资金应在 0–{MAX_ACCOUNT_AMOUNT:,} 之间", 422)
    return leverage, trading, funding


def default_background_bars(start_cfg: dict, timeframe: str) -> int:
    """某起始周期的默认背景根数（D86：大周期给得少，没单独列出的周期用通用默认值）。"""
    cfg = start_cfg["background_bars"]
    return int(cfg.get("by_timeframe", {}).get(timeframe, cfg["default"]))


def create_session(username: str, symbol: str, start_timeframe: str, background_bars: int | None,
                   day_anchor: str | None, rng: np.random.Generator | None = None, account: dict | None = None) -> dict:
    settings = load_settings()
    spec = market_spec(symbol)
    leverage, trading, funding = account_params(spec, account)
    start_cfg = settings["practice_start"]
    if start_timeframe not in start_cfg["start_timeframes"]:
        raise SessionError(f"不支持的起始周期 {start_timeframe}", 422)
    bg = background_bars or default_background_bars(start_cfg, start_timeframe)
    if not start_cfg["background_bars"]["min"] <= bg <= start_cfg["background_bars"]["max"]:
        raise SessionError(f"背景根数应在 {start_cfg['background_bars']['min']}–{start_cfg['background_bars']['max']} 之间", 422)
    anchor = day_anchor or spec["day_anchor"]
    if anchor not in kline_data.DAY_ANCHORS:
        raise SessionError(f"不支持的日线起点 {anchor}", 422)

    cleanup_expired(username)
    existing = active_session(username)
    if existing:
        raise SessionError("你还有一轮练习没有结束，请先继续或结束它", 409, {"active_session_id": existing["id"]})

    rules = settings["segment_rules"]
    with user_database.user_db(username) as db:
        completed = [dict(r) for r in db.execute(
            "SELECT start_ms, end_ms FROM segments WHERE symbol = ? ORDER BY completed_at, id", (symbol,))]
        flagged = [dict(r) for r in db.execute(
            "SELECT id, start_ms FROM segments WHERE symbol = ? AND flagged = 1 ORDER BY flagged_at, id", (symbol,))]
        first_rounds = db.execute("SELECT COUNT(*) AS n FROM sessions WHERE symbol = ? AND status = 'completed' AND is_replay = 0",
                                  (symbol,)).fetchone()["n"]
    idx = segment_picker.get_bar_index(symbol, start_timeframe, anchor)
    pick = segment_picker.pick_segment(idx, bg, completed, flagged, first_rounds, rules, rng or np.random.default_rng())

    session_id = uuid.uuid4().hex
    lease = uuid.uuid4().hex
    now = now_text()
    state = {"account": order_fills_and_costs.new_account_state(symbol, leverage, trading, funding, pick.start_ms)}
    with user_database.user_db(username) as db:
        db.execute(
            "INSERT INTO sessions(id, symbol, start_timeframe, day_anchor, background_bars, segment_start_ms, replay_ms,"
            " bars_played, timeframes_used, status, is_replay, replay_of_segment_id, pick_mode, pick_overlap, state, lease_token,"
            " lease_at, initial_total_assets, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, symbol, start_timeframe, anchor, bg, pick.start_ms, pick.start_ms, json.dumps([start_timeframe]),
             int(pick.mode == "replay"), pick.replay_of_segment_id, pick.mode, pick.max_overlap,
             json.dumps(state, ensure_ascii=False), lease, now, trading + funding, now, now))
        _event(db, session_id, pick.start_ms, "session_start",
               {"symbol": symbol, "start_timeframe": start_timeframe, "pick_mode": pick.mode,
                "leverage": leverage, "trading_balance": trading, "funding_balance": funding})
    return {"session_id": session_id, "lease_token": lease, **session_payload(username, session_id)}


def session_payload(username: str, session_id: str) -> dict:
    """开局或断点续练时浏览器需要的全部初始数据。"""
    sess = get_session(username, session_id)
    settings = load_settings()
    spec = market_spec(sess["symbol"])
    end = data_end_ms(spec, sess["symbol"])
    start, now_ms = sess["segment_start_ms"], sess["replay_ms"]
    # 引子 1m：从「当前时刻所在周线」的开盘起（开局时还包括起点所在日线），最多往前 7 天；切到日线、周线时合成半根要用
    # （D74 加周线前是「当前日线、最多 3 天」；一周的 1m 约 1 万根）
    anchor = sess["day_anchor"]
    day_open = lambda ms: int(kline_data.bucket_open_ms(pd.Series([ms]), "1d", anchor).iloc[0])  # noqa: E731
    week_open = int(kline_data.bucket_open_ms(pd.Series([now_ms]), "1w", anchor, spec.get("week_start", "monday")).iloc[0])
    lead_from = max(min(week_open, day_open(start)), now_ms - 7 * kline_data.TIMEFRAME_MS["1d"])
    # 引子要从一根完整的起始周期 K 线开始；背景 K 线正好接在它前面（断点续练时，中间已练过的部分也在背景里）
    lead_from = int(kline_data.bucket_open_ms(pd.Series([lead_from]), sess["start_timeframe"], anchor).iloc[0])
    past_1m = kline_data.read_1m_range(backend_settings.KLINE_DIR, spec["data_source"], sess["symbol"], lead_from, now_ms)
    background = closed_bars_before(spec, sess["symbol"], sess["start_timeframe"], anchor, lead_from, sess["background_bars"])
    future, reached_end = one_minute_from(spec, sess["symbol"], now_ms, future_chunk_bars(spec, settings), end)
    precision = spec["price_precision"]
    return {
        "session": sess,
        "market": {k: v for k, v in spec.items() if not k.startswith("_")},
        "background_bars": bars_to_json(background, precision),
        "past_1m": bars_to_json(past_1m, precision),
        "future_1m": bars_to_json(future, precision),
        "future_reached_data_end": reached_end,
        "completion_bars": settings["segment_rules"]["completion_bars"],
        "drawings": load_drawings(username, session_id),
    }


# ============================================================
# 进行中
# ============================================================

def get_session(username: str, session_id: str) -> dict:
    with user_database.user_db(username) as db:
        row = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise SessionError("找不到这一轮练习（可能已被清除）", 404)
    return _row_to_dict(row)


def _check_lease(db, session_id: str, lease_token: str) -> dict:
    row = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise SessionError("找不到这一轮练习（可能已被清除）", 404)
    if row["status"] != "active":
        raise SessionError("这一轮已经结束", 409)
    if row["lease_token"] != lease_token:
        raise SessionError("这一轮已在别处打开，本页面已变为只读", 409, {"lease_lost": True})
    return dict(row)


def claim_session(username: str, session_id: str) -> dict:
    """接管：发新的占用凭证，旧标签页随后保存时会被拒绝。返回凭证和初始数据（断点续练）。"""
    lease = uuid.uuid4().hex
    with user_database.user_db(username) as db:
        row = db.execute("SELECT status FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None or row["status"] != "active":
            raise SessionError("这一轮已经结束或不存在", 409)
        db.execute("UPDATE sessions SET lease_token = ?, lease_at = ? WHERE id = ?", (lease, now_text(), session_id))
    return {"lease_token": lease, **session_payload(username, session_id)}


def history_bars(username: str, session_id: str, timeframe: str, end_ms: int, count: int) -> dict:
    sess = get_session(username, session_id)
    if timeframe not in kline_data.TIMEFRAME_MS:
        raise SessionError(f"不支持的周期 {timeframe}", 422)
    count = max(1, min(count, MAX_HISTORY_BARS))
    spec = market_spec(sess["symbol"])
    bars = closed_bars_before(spec, sess["symbol"], timeframe, sess["day_anchor"], end_ms, count)
    return {"timeframe": timeframe, "bars": bars_to_json(bars, spec["price_precision"])}


def future_bars(username: str, session_id: str, from_ms: int) -> dict:
    sess = get_session(username, session_id)
    if from_ms < sess["segment_start_ms"]:
        raise SessionError("只能取起点之后的 1m", 422)
    spec = market_spec(sess["symbol"])
    settings = load_settings()
    df, reached_end = one_minute_from(spec, sess["symbol"], from_ms, future_chunk_bars(spec, settings), data_end_ms(spec, sess["symbol"]))
    return {"future_1m": bars_to_json(df, spec["price_precision"]), "future_reached_data_end": reached_end}


def load_drawings(username: str, session_id: str) -> list:
    """这一轮的画线（画线库 B 导出的 JSON 列表，第 4b 阶段 D64）；还没画过返回空列表。"""
    with user_database.user_db(username) as db:
        row = db.execute("SELECT json FROM drawings WHERE session_id = ?", (session_id,)).fetchone()
    if row is None:
        return []
    try:
        data = json.loads(row["json"])
    except ValueError:
        logger.warning("轮次 %s 的画线数据损坏，按没有画线处理", session_id)
        return []
    return data if isinstance(data, list) else []


def _parse_drawings(text: str) -> str:
    """检查浏览器送来的画线：必须是 JSON 列表、每项是对象。返回规范化后的文字。"""
    try:
        data = json.loads(text)
    except ValueError:
        raise SessionError("画线数据格式不对", 422)
    if not isinstance(data, list) or not all(isinstance(d, dict) for d in data):
        raise SessionError("画线数据格式不对", 422)
    return json.dumps(data, ensure_ascii=False)


def save_state(username: str, session_id: str, lease_token: str, replay_ms: int, timeframes_used: list[str],
               state: dict, events: list[dict], drawings: str | None = None) -> dict:
    """保存进度（定时自动保存、每次操作后保存、关页面前保存）。已走根数由服务器按 K 线表重新计算。
    drawings：画线有改动时才送（整份 JSON 列表，覆盖这一轮原来的画线）；None = 画线没变。"""
    drawings_text = _parse_drawings(drawings) if drawings is not None else None
    with user_database.user_db(username) as db:
        row = _check_lease(db, session_id, lease_token)
        if replay_ms < row["segment_start_ms"]:
            raise SessionError("回放时刻早于起点", 422)
        idx = segment_picker.get_bar_index(row["symbol"], row["start_timeframe"], row["day_anchor"])
        played = segment_picker.bars_completed(idx, row["segment_start_ms"], replay_ms)
        used = sorted(set(json.loads(row["timeframes_used"])) | set(t for t in timeframes_used if t in kline_data.TIMEFRAME_MS))
        db.execute("UPDATE sessions SET replay_ms = ?, bars_played = ?, timeframes_used = ?, state = ?, updated_at = ?,"
                   " lease_at = ? WHERE id = ?",
                   (replay_ms, played, json.dumps(used), json.dumps(state, ensure_ascii=False), now_text(), now_text(), session_id))
        for ev in events[:500]:
            _event(db, session_id, int(ev.get("replay_ms", replay_ms)), str(ev.get("type", "unknown"))[:40], ev.get("payload", {}))
        if drawings_text is not None:
            db.execute("INSERT INTO drawings(session_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id)"
                       " DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
                       (session_id, drawings_text, now_text()))
    return {"bars_played": played}


# ============================================================
# 结束与清理
# ============================================================

def finish_session(username: str, session_id: str, lease_token: str | None, replay_ms: int, reason: str = "normal",
                   final_total_assets: float | None = None) -> dict:
    """
    结束本轮：满 300 根（或因强平、播到最新数据而结束）→ 记为已完成，写入练过的片段，更新首页汇总；
    未满 300 根的正常结束 → 整轮丢弃，不计入任何统计和防重复记录（规格书 5.2 节）。
    lease_token 为 None 表示服务器自己结束（5 天后自动结束）。
    """
    if reason not in END_REASONS:
        raise SessionError(f"未知的结束方式 {reason}", 422)
    settings = load_settings()
    with user_database.user_db(username) as db:
        if lease_token is None:
            row = dict(db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone())
        else:
            row = _check_lease(db, session_id, lease_token)
        replay_ms = max(replay_ms, row["replay_ms"]) if lease_token is None else replay_ms
        idx = segment_picker.get_bar_index(row["symbol"], row["start_timeframe"], row["day_anchor"])
        played = segment_picker.bars_completed(idx, row["segment_start_ms"], replay_ms)
        enough = played >= settings["segment_rules"]["completion_bars"]
        if not enough and reason not in ("liquidation", "latest_data"):
            db.execute("DELETE FROM events WHERE session_id = ?", (session_id,))
            db.execute("DELETE FROM trades WHERE session_id = ?", (session_id,))
            db.execute("DELETE FROM drawings WHERE session_id = ?", (session_id,))
            db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            return {"result": "discarded", "bars_played": played}
        now = now_text()
        account = json.loads(row["state"]).get("account")
        if account is not None:
            final_total_assets = account["balance"] + account["funding"]
            _write_trades(db, session_id, row["symbol"], account)
        db.execute("UPDATE sessions SET status = 'completed', end_reason = ?, replay_ms = ?, bars_played = ?,"
                   " final_total_assets = COALESCE(?, final_total_assets), finished_at = ?, updated_at = ?, lease_token = NULL"
                   " WHERE id = ?", (reason, replay_ms, played, final_total_assets, now, now, session_id))
        db.execute("INSERT INTO segments(session_id, symbol, start_ms, end_ms, completed_at, is_replay) VALUES (?, ?, ?, ?, ?, ?)",
                   (session_id, row["symbol"], row["segment_start_ms"], replay_ms, now, row["is_replay"]))
        if row["is_replay"] and row["replay_of_segment_id"]:
            # 复练完成：原标记取消（规格书 5.2 节；是否重新标记在第 5 阶段按本轮表现判断）
            db.execute("UPDATE segments SET flagged = 0 WHERE id = ?", (row["replay_of_segment_id"],))
        _event(db, session_id, replay_ms, "session_finish", {"reason": reason, "bars_played": played})
    user_database.refresh_user_symbol_stats(username, row["symbol"])
    return {"result": "completed", "bars_played": played, "end_reason": reason,
            "reveal": {"start_utc": download_common.fmt_ms(row["segment_start_ms"]), "end_utc": download_common.fmt_ms(replay_ms)}}


def _write_trades(db, session_id: str, symbol: str, account: dict) -> None:
    """把这一轮已平仓的交易写进 trades 表（首页指标、第 5 阶段报告用）。结束前浏览器已按现价平掉全部持仓。"""
    spec = market_spec(symbol)
    db.execute("DELETE FROM trades WHERE session_id = ?", (session_id,))
    for t in account.get("trades", []):
        r = order_fills_and_costs.r_multiple(t["pnl"], t["entry_price"], t.get("initial_sl"), t["qty"], spec)
        db.execute("INSERT INTO trades(session_id, symbol, direction, lots, entry_ms, exit_ms, entry_price, exit_price, pnl,"
                   " r_multiple, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (session_id, symbol, "long" if t["direction"] == 1 else "short", t["qty"], t["open_ms"], t["close_ms"],
                    t["entry_price"], t["exit_price_avg"], t["pnl"], r, json.dumps(t, ensure_ascii=False)))


def cleanup_expired(username: str, now: datetime | None = None) -> list[dict]:
    """超过 5 天没动的进行中轮次：满 300 根的自动结束，不满的删除（规格书 5.2 节）。"""
    settings = load_settings()
    limit = (now or datetime.now(timezone.utc)) - timedelta(days=settings["segment_rules"]["unfinished_keep_days"])
    limit_text = limit.strftime("%Y-%m-%d %H:%M:%S")
    with user_database.user_db(username) as db:
        stale = [dict(r) for r in db.execute(
            "SELECT id, replay_ms FROM sessions WHERE status = 'active' AND updated_at < ?", (limit_text,))]
    return [{"session_id": s["id"], **finish_session(username, s["id"], None, s["replay_ms"], "auto_after_days")} for s in stale]


def list_sessions(username: str) -> list[dict]:
    """历史练习列表：每轮附上交易笔数（trades 表，结束后才有）和第几轮（round_no，进行中为 None）。"""
    with user_database.user_db(username) as db:
        rows = db.execute("SELECT * FROM sessions ORDER BY created_at DESC").fetchall()
        counts = {r["session_id"]: r["n"] for r in db.execute("SELECT session_id, COUNT(*) AS n FROM trades GROUP BY session_id")}
    numbers = _round_numbers(rows)
    return [{**_row_to_dict(r), "trade_count": counts.get(r["id"], 0), "round_no": numbers.get(r["id"])} for r in rows]


def _round_numbers(rows) -> dict[str, int]:
    """第几轮（D77）：同一品种的已完成轮次按结束先后数，排序与统计页、简报的 round_no 相同
    （review_statistics._completed_rounds：finished_at、created_at、id）。"""
    done = sorted((r for r in rows if r["status"] == "completed"),
                  key=lambda r: (r["symbol"], r["finished_at"] or "", r["created_at"], r["id"]))
    numbers, seen = {}, {}
    for r in done:
        seen[r["symbol"]] = seen.get(r["symbol"], 0) + 1
        numbers[r["id"]] = seen[r["symbol"]]
    return numbers
