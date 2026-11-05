# -*- coding: utf-8 -*-
"""
交易纪律审查（规格书 7.3 节；第 5a 阶段做每轮违规清单，第 5b 阶段做各项比率、问题提示和进步曲线，D67、D68）。
按架构铁律只依赖 trading_rules、不碰数据库；输入来自服务器复算（website_server/session_finish.py 的 _Recorder）。

一、每笔交易的事实（trade_facts）——「一笔」= 一个持仓从开到平（D66），编号 = 本轮第几笔开出的持仓（与练习页 #N 一致）：
  止损止盈：进场时有没有止损 / 止盈、全程有没有设过；往不利方向挪止损（离进场价更远或取消）次数、往有利方向挪次数。
            「按时设了止损」= 成交时就带止损，或开仓后 stop_grace_bars（默认 3）根起始周期 K 线内补上（2026-10-25 用户定，D72）；
            字段名仍叫 sl_at_entry（统计页、导出都用它），sl_set_bars 记补上止损时隔了几根（成交时就有 = 0，没补 = None）。
  止损后行为：本笔若是某次止损出场后的第一笔开仓，记下隔了几根起始周期 K 线（同一根 = 0）和真实分钟数；
             快速再入场 = 隔的根数 ≤ quick_reentry_bars；亏损后放大仓位 = 上一笔（开仓前最近平掉的一笔）亏损且本笔手数更大。
  风险：开仓那一刻的真实杠杆、保证金占用、止损风险（无止损 = 无上限）、强平距离；持仓期间最高杠杆（及时刻）、平均杠杆、
        最小强平距离、最大止损风险；被动加杠杆 = 持仓中最高杠杆比开仓时高出 passive_leverage_rise（默认 50%）以上；
        止损风险（open_stop_risk）按「设上止损那一刻」算：成交时就有止损按成交时，宽限期内补上的按补上那一刻；
        重仓 = 止损风险 > heavy_stop_risk（默认 10%，D73 由 2% 放宽；D72 取代原「真实杠杆 ≥ 3 倍」：黄金最小手数的真实杠杆就超过 3 倍，
        杠杆衡量不了风险）；没按时设止损的不算重仓（已记「进场没设止损」，不重复扣）；
        实际止损占权益 = 止损出场的亏损 ÷ 止损触发前一刻的交易账户净值（只算亏钱的止损）。
  其他：计划 R =（止盈 − 进场）÷（进场 − 止损），开仓时两者都设了才算；实际 R = 盈亏 ÷ 第一次止损的风险；
        拿不住 = 设了止盈、手动平掉的盈利单；持仓根数；时段按进场时刻（UTC 固定时段，D68）；决策用时（浏览器记录）。
  守纪律 = 同时满足：按时设了止损、没往不利方向挪止损、不是快速再入场、不是重仓、不是亏损后放大仓位。
二、每轮违规清单（round_violations）：五类——进场没设止损、往不利方向挪止损、止损后快速再开仓、重仓、亏损后放大仓位。
三、一段范围的审查表（review_tables）和问题提示（hints）：每项给笔数、占比、该组胜率，与全部交易的胜率对照；
    样本少于 hint_min_samples 笔的项目不出提示。连续亏损段只在一轮之内算，不跨轮。
    D75 统计页三层排版另给两份：behaviors = 六种犯错行为各自「犯了的 vs 没犯的」两组（统计页第一层卡片）；
    entry_compare = 市价 vs 挂单（限价 + 止损挂单合并）两组（第二层）。
四、进步曲线（progress_series，D68）：横轴为该品种的第几轮；胜率、盈亏比（平均盈利 ÷ 平均亏损）、守纪律占比、平均 R
    按「截至这一轮的最近 rolling_trades 笔」算（不足时标样本少）；违规次数、最长连亏、止损后再开仓间隔、最高杠杆、
    实际止损占权益等按该轮自己的数，没有数据的轮次留空（不画成 0）。
"""

from __future__ import annotations

import statistics

import numpy as np

from python_backend.trading_rules import order_fills_and_costs as of

VIOLATION_KINDS = {
    "no_stop_at_entry": "进场没设止损",
    "stop_moved_against": "往不利方向挪止损",
    "quick_reentry": "止损后快速再开仓",
    "heavy_position": "重仓",
    "size_up_after_loss": "亏损后放大仓位",
}


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _median(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


# ============================================================
# 一、每笔交易的事实
# ============================================================

def _bar_no(opens: np.ndarray, ms: int) -> int:
    """ms 所在的起始周期 K 线序号（opens 为各根开盘时刻，升序）。"""
    return int(np.searchsorted(opens, ms, side="right")) - 1


def _against(direction: int, old, new) -> bool:
    """止损往不利方向挪（离进场价更远）或被取消；从没有止损到设上止损不算。"""
    if old is None:
        return False
    if new is None:
        return True
    return (new - old) * direction < 0


def _favorable(direction: int, old, new) -> bool:
    return old is not None and new is not None and (new - old) * direction > 0


def session_of(ms: int, sessions: list) -> str:
    hour = (ms // 3_600_000) % 24
    return next(name for lo, hi, name in sessions if lo <= hour < hi)


def entry_type(source: str) -> str:
    return "market" if source == "market" else ("limit" if source.endswith("limit") else "stop")


def _stop_timing(sl0, op: dict, first_sl: dict | None, bar_opens: np.ndarray, open_ms: int) -> tuple:
    """止损是开仓后第几根起始周期 K 线设上的（成交时就有 = 0，一直没设 = None），以及设上那一刻的止损风险。"""
    if sl0 is not None:
        return 0, op.get("stop_risk")
    if first_sl is None:
        return None, None
    return max(0, _bar_no(bar_opens, first_sl["ms"]) - _bar_no(bar_opens, open_ms)), first_sl["stop_risk"]


def trade_facts(trades: list[dict], rec: dict, bar_opens: np.ndarray, spec: dict, settings: dict) -> list[dict]:
    """把复算记下的原始事实整理成每笔交易的事实（按开仓顺序）。"""
    cfg = settings["discipline_review"]
    ordered = sorted(trades, key=lambda t: t["position_id"])
    no_of = {t["position_id"]: i + 1 for i, t in enumerate(ordered)}
    out: list[dict] = []
    for i, t in enumerate(ordered):
        pid, d = t["position_id"], t["direction"]
        op = rec["open"].get(pid, {})
        hold = rec["hold"].get(pid, {})
        changes = rec["stop_changes"].get(pid, [])
        sl0, tp0 = op.get("sl"), op.get("tp")
        sl_set_bars, stop_risk = _stop_timing(sl0, op, rec["first_sl"].get(pid), bar_opens, t["open_ms"])
        sl_in_time = sl_set_bars is not None and sl_set_bars <= cfg["stop_grace_bars"]
        if not sl_in_time:
            stop_risk = None
        open_lev = op.get("leverage")
        max_lev = hold.get("max_leverage")
        # 止损后的第一笔：开仓前最近一次止损出场，且这次止损之后、本笔之前没有别的开仓
        prev_closed = [x for x in ordered[:i] if x["close_ms"] <= t["open_ms"]]
        last_stop = max((x for x in prev_closed if x["close_reason"] in ("stop", "gap_stop")),
                        key=lambda x: (x["close_ms"], x["position_id"]), default=None)
        after_stop_bars = after_stop_minutes = None
        if last_stop is not None and not any(x["open_ms"] >= last_stop["close_ms"] and x["position_id"] > last_stop["position_id"]
                                             for x in ordered[:i]):
            after_stop_bars = max(0, _bar_no(bar_opens, t["open_ms"]) - _bar_no(bar_opens, last_stop["close_ms"]))
            after_stop_minutes = (t["open_ms"] - last_stop["close_ms"]) / 60_000
        prev = max(prev_closed, key=lambda x: (x["close_ms"], x["position_id"]), default=None)
        size_up = prev is not None and prev["pnl"] <= 0 and t["qty"] > prev["qty"] + 1e-12
        eq_before = rec["equity_before_stop"].get(pid)
        stop_exit = t["close_reason"] in ("stop", "gap_stop")
        planned_r = None
        if sl0 is not None and tp0 is not None and (t["entry_price"] - sl0) * d > 0:
            planned_r = (tp0 - t["entry_price"]) * d / ((t["entry_price"] - sl0) * d)
        f = {
            "no": i + 1, "position_id": pid, "direction": d, "qty": t["qty"], "entry_type": entry_type(t["source"]),
            "open_ms": t["open_ms"], "close_ms": t["close_ms"], "close_reason": t["close_reason"], "pnl": t["pnl"],
            "win": t["pnl"] > 0, "r": of.r_multiple(t["pnl"], t["entry_price"], t.get("initial_sl"), t["qty"], spec),
            "planned_r": planned_r,
            "sl_at_entry": sl_in_time, "sl_set_bars": sl_set_bars, "ever_sl": pid in rec["ever_sl"],
            "tp_at_entry": tp0 is not None, "ever_tp": pid in rec["ever_tp"],
            "moves_against": sum(1 for c in changes if _against(d, c["old"], c["new"])),
            "moves_favorable": sum(1 for c in changes if _favorable(d, c["old"], c["new"])),
            "first_move_against_ms": next((c["ms"] for c in changes if _against(d, c["old"], c["new"])), None),
            "open_leverage": open_lev, "open_margin_usage": op.get("margin_usage"),
            "open_stop_risk": stop_risk, "open_liq_distance": op.get("liq_distance"),
            "max_leverage": max_lev, "max_leverage_ms": hold.get("max_leverage_ms"),
            "avg_leverage": hold["lev_sum"] / hold["n"] if hold.get("n") else None,
            "min_liq_distance": hold.get("min_liq_distance"),
            "max_stop_risk": None if hold.get("stop_unlimited") else hold.get("max_stop_risk"),
            "passive_leverage": bool(open_lev and max_lev and max_lev >= open_lev * (1 + cfg["passive_leverage_rise"])),
            "heavy": stop_risk is not None and stop_risk > cfg["heavy_stop_risk"],
            "stop_exit": stop_exit,
            "stop_pct": (-t["pnl"] / eq_before) if stop_exit and eq_before and t["pnl"] < 0 else None,
            "hold_bars": max(0, _bar_no(bar_opens, t["close_ms"]) - _bar_no(bar_opens, t["open_ms"])),
            "after_stop_bars": after_stop_bars, "after_stop_minutes": after_stop_minutes,
            "after_stop_of": no_of[last_stop["position_id"]] if after_stop_bars is not None else None,
            "quick_reentry": after_stop_bars is not None and after_stop_bars <= cfg["quick_reentry_bars"],
            "size_up_after_loss": size_up,
            "manual_profit_before_tp": t["close_reason"] == "manual" and t["pnl"] > 0 and t.get("tp_at_close") is not None,
            "session": session_of(t["open_ms"], cfg["sessions_utc"]),
            "decision_ms": rec["decisions"].get(t.get("order_id")),
        }
        f["disciplined"] = f["sl_at_entry"] and f["moves_against"] == 0 and not f["quick_reentry"] and not f["heavy"] and not size_up
        out.append(f)
    return out


# ============================================================
# 二、每轮违规清单、连续亏损段、每轮数字
# ============================================================

def round_violations(facts: list[dict], cfg: dict) -> list[dict]:
    """每轮的违规事件列表（按笔的顺序），每条 {no, position_id, kind, ms, text}。cfg = 设置里的 discipline_review。"""
    out: list[dict] = []
    for f in facts:
        no, pid = f["no"], f["position_id"]
        if not f["sl_at_entry"]:
            out.append({"no": no, "position_id": pid, "kind": "no_stop_at_entry", "ms": f["open_ms"], "text": f"第 {no} 笔：开仓后 {cfg['stop_grace_bars']} 根 K 线内没设止损"})
        if f["moves_against"]:
            out.append({"no": no, "position_id": pid, "kind": "stop_moved_against", "ms": f["first_move_against_ms"],
                        "text": f"第 {no} 笔：持仓中把止损往不利方向挪了 {f['moves_against']} 次（含取消止损）"})
        if f["heavy"]:
            out.append({"no": no, "position_id": pid, "kind": "heavy_position", "ms": f["open_ms"],
                        "text": f"第 {no} 笔：止损风险 {f['open_stop_risk'] * 100:.1f}%（重仓，止损被打到会亏掉净值的 {f['open_stop_risk'] * 100:.1f}%，"
                                f"超过 {cfg['heavy_stop_risk'] * 100:g}%）"})
        if f["quick_reentry"]:
            when = "同一根 K 线内" if f["after_stop_bars"] == 0 else f" {f['after_stop_bars']} 根 K 线内"
            out.append({"no": no, "position_id": pid, "kind": "quick_reentry", "ms": f["open_ms"],
                        "text": f"第 {no} 笔：第 {f['after_stop_of']} 笔止损后{when}再次开仓"})
        if f["size_up_after_loss"]:
            out.append({"no": no, "position_id": pid, "kind": "size_up_after_loss", "ms": f["open_ms"],
                        "text": f"第 {no} 笔：上一笔亏损后放大了仓位"})
    out.sort(key=lambda v: (v["no"], v["ms"]))
    return out


def loss_streaks(facts: list[dict], bar_opens: np.ndarray, min_len: int) -> list[dict]:
    """一轮内的连续亏损段（≥ min_len 笔，按平仓先后）：几笔、跨了多少根 K 线、每笔之间隔几根、手数有没有变大、合计盈亏和 R、时段。"""
    out, cur = [], []
    for f in sorted(facts, key=lambda x: (x["close_ms"], x["no"])) + [None]:
        if f is not None and not f["win"]:
            cur.append(f)
            continue
        if len(cur) >= min_len:
            gaps = [max(0, _bar_no(bar_opens, b["open_ms"]) - _bar_no(bar_opens, a["close_ms"])) for a, b in zip(cur, cur[1:])]
            out.append({"count": len(cur), "nos": [x["no"] for x in cur], "start_ms": cur[0]["open_ms"], "end_ms": cur[-1]["close_ms"],
                        "span_bars": _bar_no(bar_opens, cur[-1]["close_ms"]) - _bar_no(bar_opens, cur[0]["open_ms"]),
                        "gaps_bars": gaps, "size_up": any(b["qty"] > a["qty"] + 1e-12 for a, b in zip(cur, cur[1:])),
                        "total_pnl": sum(x["pnl"] for x in cur),
                        "total_r": sum(x["r"] for x in cur) if all(x["r"] is not None for x in cur) else None,
                        "sessions": sorted({x["session"] for x in cur})})
        cur = []
    return out


def longest_loss_run(facts: list[dict]) -> int:
    best = cur = 0
    for f in sorted(facts, key=lambda x: (x["close_ms"], x["no"])):
        cur = 0 if f["win"] else cur + 1
        best = max(best, cur)
    return best


def round_summary(facts: list[dict], streaks: list[dict], bars_played: int, rec: dict, cfg: dict,
                  ret: float | None, max_dd_pct: float | None) -> dict:
    """进步曲线和范围统计用的每轮数字（该轮自己的数，没有数据的为 None）。"""
    counts = {k: 0 for k in VIOLATION_KINDS}
    for v in round_violations(facts, cfg):
        counts[v["kind"]] += 1
    return {
        "trades": len(facts), "bars_played": bars_played,
        "violations": counts, "violations_total": sum(counts.values()),
        "longest_loss_run": longest_loss_run(facts) if facts else None,
        "loss_streaks": streaks,
        "after_stop_bars_median": _median([f["after_stop_bars"] for f in facts]),
        "max_leverage": max((f["max_leverage"] for f in facts if f["max_leverage"] is not None), default=None),
        "stop_pct_median": _median([f["stop_pct"] for f in facts]),
        "trades_per_100_bars": len(facts) / bars_played * 100 if bars_played else None,
        "hold_bars_win": _mean([f["hold_bars"] for f in facts if f["win"]]),
        "hold_bars_loss": _mean([f["hold_bars"] for f in facts if not f["win"]]),
        "planned_r_avg": _mean([f["planned_r"] for f in facts]), "actual_r_avg": _mean([f["r"] for f in facts]),
        "return": ret, "max_drawdown_pct": max_dd_pct,
        "holding_time_share": rec["bars_with_position"] / rec["bars_total"] if rec["bars_total"] else None,
    }


# ============================================================
# 三、一段范围的审查表和问题提示
# ============================================================

def _group(label: str, sub: list[dict], total: int, extra: dict | None = None) -> dict:
    n = len(sub)
    return {"label": label, "count": n, "share": n / total if total else None,
            "win_rate": sum(1 for f in sub if f["win"]) / n if n else None,
            "avg_r": _mean([f["r"] for f in sub]), **(extra or {})}


def _ranges(edges: list) -> list[tuple[float, float]]:
    """把 edges 切成 (下限, 上限] 的若干段，首段下限为 −∞、末段上限为 +∞。"""
    bounds = [-np.inf] + list(edges) + [np.inf]
    return list(zip(bounds, bounds[1:]))


def _range_label(lo: float, hi: float, unit: str, scale: float = 1.0) -> str:
    if lo == -np.inf:
        return f"≤ {hi * scale:g}{unit}"
    if hi == np.inf:
        return f"> {lo * scale:g}{unit}"
    return f"{lo * scale:g}–{hi * scale:g}{unit}"


def _quantiles(xs: list) -> dict | None:
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    q = np.quantile(xs, [0.25, 0.5, 0.75])
    return {"min": xs[0], "q1": float(q[0]), "median": float(q[1]), "q3": float(q[2]), "max": xs[-1], "count": len(xs)}


def _behaviors(facts: list[dict], n: int, cfg: dict) -> list[dict]:
    """六种犯错行为（D75 统计页第一层）：bad = 犯了的那组，good = 对照组（一般是其余交易；
    快速再入场的对照是「止损后隔得更久才开的」，这样比的都是止损后的第一笔）。"""
    def pair(key, label, bad_cond, good_cond, extra=None):
        bad = [f for f in facts if bad_cond(f)]
        good = [f for f in facts if good_cond(f)]
        return {"key": key, "label": label, "bad": _group(label, bad, n), "good": _group("对照", good, n), **(extra or {})}

    after = lambda f: f["after_stop_bars"] is not None  # noqa: E731
    return [
        pair("no_stop", f"开仓后 {cfg['stop_grace_bars']} 根内没设止损", lambda f: not f["sl_at_entry"], lambda f: f["sl_at_entry"],
             {"good_label": "设了止损的", "note_count": sum(1 for f in facts if not f["ever_sl"]), "note": "其中全程没设过止损"}),
        pair("stop_moved_against", "往不利方向挪止损", lambda f: f["moves_against"] > 0, lambda f: f["moves_against"] == 0,
             {"good_label": "从没挪过的", "times": sum(f["moves_against"] for f in facts)}),
        pair("quick_reentry", f"止损后 {cfg['quick_reentry_bars']} 根内再开仓", lambda f: f["quick_reentry"],
             lambda f: after(f) and not f["quick_reentry"], {"good_label": "止损后隔得更久才开的"}),
        pair("size_up_after_loss", "亏损后放大仓位", lambda f: f["size_up_after_loss"], lambda f: not f["size_up_after_loss"],
             {"good_label": "其余交易"}),
        pair("heavy", f"重仓（止损风险 > {cfg['heavy_stop_risk'] * 100:g}%）", lambda f: f["heavy"], lambda f: not f["heavy"],
             {"good_label": "非重仓"}),
        pair("passive", f"扛单（持仓中杠杆升高 {cfg['passive_leverage_rise'] * 100:g}% 以上）", lambda f: f["passive_leverage"],
             lambda f: not f["passive_leverage"], {"good_label": "其余交易"}),
    ]


def review_tables(facts: list[dict], rounds: list[dict], settings: dict) -> dict:
    """一段范围（若干轮）的纪律审查表。facts 为这些轮的全部交易事实（每条带 round_no），rounds 为这些轮的 round_summary（带 round_no）。"""
    cfg = settings["discipline_review"]
    n = len(facts)
    overall = sum(1 for f in facts if f["win"]) / n if n else None

    def g(label, cond, extra=None):
        return _group(label, [f for f in facts if cond(f)], n, extra)

    def bucketed(key, edges, unit, scale=1.0, value=lambda x: x):
        return [g(_range_label(lo, hi, unit, scale), lambda f, lo=lo, hi=hi: f[key] is not None and lo < value(f[key]) <= hi)
                for lo, hi in _ranges(edges)]

    moved = [f for f in facts if f["moves_against"]]
    never = [f for f in facts if not f["moves_against"]]
    after = [f for f in facts if f["after_stop_bars"] is not None]
    gap_rows = []
    for lo, hi in _ranges(cfg["after_stop_gap_buckets"]):
        start = 0 if lo == -np.inf else int(lo) + 1
        label = f"{start}–{int(hi)} 根" if hi != np.inf else f"{start} 根以上"
        sub = [f for f in after if (lo == -np.inf or f["after_stop_bars"] > lo) and f["after_stop_bars"] <= hi]
        gap_rows.append(_group(label, sub, len(after), {"median_minutes": _median([f["after_stop_minutes"] for f in sub])}))
    # 交易频率：开仓频率最高的三分之一轮次 vs 其余（至少 3 轮才比）
    freq = sorted((r for r in rounds if r["trades_per_100_bars"] is not None), key=lambda r: -r["trades_per_100_bars"])
    top = {r["round_no"] for r in freq[: max(1, len(freq) // 3)]} if len(freq) >= 3 else set()
    risk_rows = bucketed("open_stop_risk", cfg["stop_risk_buckets"], "%", 100)
    risk_rows.append(g("未设止损", lambda f: not f["sl_at_entry"]))
    dec_rows = bucketed("decision_ms", cfg["decision_seconds_buckets"], " 秒", value=lambda ms: ms / 1000)
    dec_rows.append(g("无记录", lambda f: f["decision_ms"] is None))
    # 连亏段带上各笔的持仓编号（第 5b-2 阶段，D71：静态 K 线图按它高亮这几笔；「第 N 笔」和持仓编号 #N 不是同一个数）
    pid_of = {(f["round_no"], f["no"]): f["position_id"] for f in facts}
    streaks = [dict(s, round_no=r["round_no"], session_id=r.get("session_id"),
                    position_ids=[pid_of.get((r["round_no"], no)) for no in s["nos"]])
               for r in rounds for s in r["loss_streaks"]]
    max_lev = max(((f["max_leverage"], f["round_no"], f["no"], f["max_leverage_ms"]) for f in facts if f["max_leverage"] is not None),
                  default=None)
    with_plan = [f for f in facts if f["planned_r"] is not None and f["r"] is not None]
    behaviors = _behaviors(facts, n, cfg)
    stops_hit = [f for f in facts if f["stop_pct"] is not None]
    return {
        "trades": n, "overall_win_rate": overall, "sample_small": n < cfg["sample_small_trades"],
        "min_samples": cfg["hint_min_samples"], "behaviors": behaviors,
        "entry_compare": [g("市价", lambda f: f["entry_type"] == "market"), g("挂单", lambda f: f["entry_type"] != "market")],
        "stops": [
            g(f"开仓后 {cfg['stop_grace_bars']} 根内没设止损", lambda f: not f["sl_at_entry"]),
            g("全程没设过止损", lambda f: not f["ever_sl"]),
            g("进场时没设止盈", lambda f: not f["tp_at_entry"]),
            g("全程没设过止盈", lambda f: not f["ever_tp"]),
            _group("往不利方向挪过止损", moved, n, {"times": sum(f["moves_against"] for f in moved),
                                            "compare": _group("从没往不利方向挪过", never, n)}),
            g("往有利方向挪过止损（跟进、保本，不扣分）", lambda f: f["moves_favorable"] > 0,
              {"times": sum(f["moves_favorable"] for f in facts)}),
        ],
        "after_stop": {
            "gaps": gap_rows,
            "quick_reentry": g(f"止损后 {cfg['quick_reentry_bars']} 根以内再开仓", lambda f: f["quick_reentry"]),
            "size_up_after_loss": g("亏损后放大仓位", lambda f: f["size_up_after_loss"]),
        },
        "loss_streaks": {"count": len(streaks), "longest": max((s["count"] for s in streaks), default=0), "items": streaks},
        "entry_types": [g(label, lambda f, k=k: f["entry_type"] == k)
                        for k, label in (("market", "市价单"), ("limit", "限价挂单"), ("stop", "止损挂单"))],
        "frequency": {"trades_per_100_bars": _mean([r["trades_per_100_bars"] for r in rounds]),
                      "busiest": g("开仓最频繁的三分之一轮次", lambda f: f["round_no"] in top) if top else None,
                      "others": g("其余轮次", lambda f: f["round_no"] not in top) if top else None},
        "plan": {"with_plan": len(with_plan),
                 "planned_r_avg": _mean([f["planned_r"] for f in with_plan]), "actual_r_avg": _mean([f["r"] for f in with_plan]),
                 "cut_winners": g("设了止盈、还没到就手动平掉的盈利单（拿不住）", lambda f: f["manual_profit_before_tp"])},
        "holding": {"win_bars": _mean([f["hold_bars"] for f in facts if f["win"]]),
                    "loss_bars": _mean([f["hold_bars"] for f in facts if not f["win"]])},
        "sessions": [g(name, lambda f, name=name: f["session"] == name) for _, _, name in cfg["sessions_utc"]],
        "directions": [g("做多", lambda f: f["direction"] == 1), g("做空", lambda f: f["direction"] == -1)],
        "risk": {
            "leverage_buckets": bucketed("open_leverage", cfg["leverage_buckets"], " 倍"),
            "stop_risk_buckets": risk_rows,
            "heavy": g(f"重仓（止损风险 > {cfg['heavy_stop_risk'] * 100:g}%）", lambda f: f["heavy"]),
            "not_heavy": g("非重仓（含没设止损的）", lambda f: not f["heavy"]),
            "passive": g(f"被动加杠杆（持仓中杠杆比开仓时高 {cfg['passive_leverage_rise'] * 100:g}% 以上）", lambda f: f["passive_leverage"]),
            "stop_pct": _quantiles([f["stop_pct"] for f in facts]),
            "stop_pct_by_round": [{"round_no": r["round_no"], "median": r["stop_pct_median"]} for r in rounds],
            "planned_vs_actual_stop": {"count": len(stops_hit),
                                       "planned_avg": _mean([f["open_stop_risk"] for f in stops_hit]),
                                       "actual_avg": _mean([f["stop_pct"] for f in stops_hit])},
            "max_leverage": None if max_lev is None else {"value": max_lev[0], "round_no": max_lev[1], "no": max_lev[2], "ms": max_lev[3]},
            "avg_leverage_holding": _mean([f["avg_leverage"] for f in facts]),
            "holding_time_share": _mean([r["holding_time_share"] for r in rounds]),
            "min_liq_distance": min((f["min_liq_distance"] for f in facts if f["min_liq_distance"] is not None), default=None),
            "max_stop_risk": max((f["max_stop_risk"] for f in facts if f["max_stop_risk"] is not None), default=None),
            "stop_unlimited_trades": sum(1 for f in facts if f["max_stop_risk"] is None),
        },
        "decision": dec_rows,
    }


def _pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def hints(review: dict, settings: dict) -> list[str]:
    """问题提示（放在最上面）：固定规则，样本少于 hint_min_samples 笔的项目不提示（D68）。"""
    cfg = settings["discipline_review"]
    h = cfg["hints"]
    k = cfg["hint_min_samples"]
    overall = review["overall_win_rate"]
    out: list[str] = []
    q = review["after_stop"]["quick_reentry"]
    if q["count"] >= k and overall is not None and q["win_rate"] <= overall - h["quick_reentry_winrate_gap"]:
        out.append(f"被止损后 {cfg['quick_reentry_bars']} 根内再开仓 {q['count']} 次，胜率 {_pct(q['win_rate'])}，低于你的整体胜率 {_pct(overall)}")
    m = review["stops"][4]
    if m["count"] >= k and m["compare"]["count"] and m["win_rate"] < m["compare"]["win_rate"]:
        out.append(f"往不利方向挪过止损的交易 {m['count']} 笔，胜率 {_pct(m['win_rate'])}，低于从没挪过的 {_pct(m['compare']['win_rate'])}")
    hv, nh = review["risk"]["heavy"], review["risk"]["not_heavy"]
    if hv["count"] >= k and nh["count"] and hv["win_rate"] < nh["win_rate"]:
        out.append(f"有 {hv['count']} 笔重仓交易，胜率 {_pct(hv['win_rate'])}，低于非重仓的 {_pct(nh['win_rate'])}")
    ls = review["loss_streaks"]
    if ls["count"]:
        out.append(f"出现了 {ls['count']} 段连续亏损（≥ {cfg['loss_streak_min']} 笔），最长一段 {ls['longest']} 笔")
    r = review["risk"]
    if r["max_leverage"] and r["max_leverage"]["value"] >= h["max_leverage"]:
        out.append(f"最高真实杠杆达到 {r['max_leverage']['value']:.1f} 倍（第 {r['max_leverage']['round_no']} 轮第 {r['max_leverage']['no']} 笔）")
    if r["min_liq_distance"] is not None and r["min_liq_distance"] < h["min_liq_distance"]:
        out.append(f"强平距离一度只剩 {r['min_liq_distance'] * 100:.2f}%")
    sp = r["stop_pct"]
    if sp and sp["count"] >= k and sp["median"] > h["stop_pct_median"]:
        out.append(f"实际止损占权益 {sp['min'] * 100:.1f}%–{sp['max'] * 100:.1f}%，中位数 {sp['median'] * 100:.1f}%，偏大")
    return out


# ============================================================
# 四、进步曲线
# ============================================================

def progress_series(rounds: list[dict], facts_by_round: dict[int, list[dict]], settings: dict) -> dict:
    """rounds 为该品种全部轮次的 round_summary（带 round_no，按完成顺序）。返回每轮一个点的各条曲线。"""
    w = settings["discipline_review"]["rolling_trades"]
    history: list[dict] = []
    points = []
    for r in rounds:
        history.extend(facts_by_round.get(r["round_no"], []))
        win = history[-w:]
        wins = [f["pnl"] for f in win if f["pnl"] > 0]
        losses = [-f["pnl"] for f in win if f["pnl"] < 0]
        points.append({
            "round_no": r["round_no"], "session_id": r.get("session_id"), "trades": r["trades"],
            "window_trades": len(win), "sample_small": len(win) < w,
            "win_rate": sum(1 for f in win if f["win"]) / len(win) if win else None,
            "payoff_ratio": (sum(wins) / len(wins)) / (sum(losses) / len(losses)) if wins and losses else None,
            "disciplined_share": sum(1 for f in win if f["disciplined"]) / len(win) if win else None,
            "avg_r": _mean([f["r"] for f in win]),
            "violations": r["violations"] if r["trades"] else None,
            "longest_loss_run": r["longest_loss_run"], "after_stop_bars_median": r["after_stop_bars_median"],
            "max_leverage": r["max_leverage"], "stop_pct_median": r["stop_pct_median"],
            "trades_per_100_bars": r["trades_per_100_bars"], "hold_bars_win": r["hold_bars_win"], "hold_bars_loss": r["hold_bars_loss"],
            "return": r["return"], "max_drawdown_pct": r["max_drawdown_pct"],
            "planned_r_avg": r["planned_r_avg"], "actual_r_avg": r["actual_r_avg"],
        })
    return {"rolling_trades": w, "points": points}
