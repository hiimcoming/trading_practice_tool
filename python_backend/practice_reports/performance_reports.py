# -*- coding: utf-8 -*-
"""
练习报告的数字（规格书第 7 节）。第 5a 阶段做「单轮简报」（7.1 节：只列事实，不算胜率、盈亏比这类比率）；
第 5b 阶段加「统计与审查」页的 MT4 式统计表（range_stats，D68：取代原「每 5 轮一份阶段报告」，范围由页面选）。

单轮简报的内容（结果是一个可直接存成 JSON 的字典，由网页负责画图和排版）：
  1. 揭晓信息：品种、真实时间段（UTC）、经历天数、走了多少根、从开局到结束的真实时长、结束方式；
  2. 总资产曲线（另附交易账户净值）和本轮最大回撤（金额和百分比，按总资产算）；
  3. 基本数字：笔数、盈利笔数（盈亏 > 0）、亏损笔数、净盈亏、交易成本合计（点差 + 滑点 + 手续费）、出入金、强平次数；
  4. 纪律违规清单（discipline_review.py）；
  5. 逐笔交易：进出场时刻、方向、手数、进出场价、第一次止损和平仓时的止盈止损、出场原因、盈亏、R、进场方式。
  另附「服务器复算与浏览器结果是否一致」（规格书 15.6 节）。
全部数字来自服务器复算后的交易账户（website_server/session_finish.py），这里只做汇总、不碰数据库，按架构铁律只依赖 trading_rules。
最大回撤的算法来源：CryptoTrade/backtest/analyzer.py 的 _drawdown（2026-10-22 复制后改为直接用资产序列）。
统计表的胜率、利润因子、赔率（这里叫盈亏比）、最大回撤、最长连亏：来源 CryptoTrade/backtest/analyzer.py 的 metrics、_drawdown、
_longest_streak（2026-10-22 复制，算法不变；测试里与 CryptoTrade 原函数逐项对账）。名称约定（D68）：
  盈亏比 = 平均盈利 ÷ |平均亏损|（analyzer 的「赔率」）；利润因子 = 总盈利 ÷ |总亏损|（analyzer 的 PF，规格书 7.2 节原写作「盈亏比」）。
"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np

from python_backend.trading_rules import order_fills_and_costs as of

MAX_CURVE_POINTS = 1500  # 资产曲线最多存这么多个点（网页画图足够，避免报告过大）


def max_drawdown(values: np.ndarray) -> tuple[float, float]:
    """最大回撤（金额、百分比）：从前高回落的最大金额，百分比 = 回落 ÷ 当时的前高。"""
    if len(values) == 0:
        return 0.0, 0.0
    peak = np.maximum.accumulate(values)
    dd = peak - values
    k = int(np.argmax(dd))
    return float(dd[k]), float(dd[k] / peak[k]) if peak[k] > 0 else 0.0


def thin_curve(ms: np.ndarray, total: np.ndarray, trading: np.ndarray) -> list[list]:
    """资产曲线抽稀到最多 MAX_CURVE_POINTS 个点，首尾和总资产最低点一定保留（回撤在图上看得见）。"""
    n = len(ms)
    if n == 0:
        return []
    keep = set(np.linspace(0, n - 1, min(n, MAX_CURVE_POINTS)).astype(int).tolist())
    keep.add(int(np.argmin(total)))
    return [[int(ms[i]), round(float(total[i]), 2), round(float(trading[i]), 2)] for i in sorted(keep)]


def _utc(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def _minutes_between(a: str | None, b: str | None) -> int | None:
    if not a or not b:
        return None
    fmt = "%Y-%m-%d %H:%M:%S"
    return int((datetime.strptime(b, fmt) - datetime.strptime(a, fmt)).total_seconds() // 60)


def trade_rows(trades: list[dict], spec: dict, facts: list[dict] | None = None) -> list[dict]:
    """逐笔交易（按开仓顺序编号，与练习页持仓编号 #N 一致）。facts 为纪律审查的每笔事实（带决策用时）。"""
    decision = {f["position_id"]: f["decision_ms"] for f in facts or []}
    rows = []
    for i, t in enumerate(sorted(trades, key=lambda x: x["position_id"])):
        rows.append({
            "no": i + 1, "position_id": t["position_id"], "direction": t["direction"], "qty": t["qty"],
            "source": t["source"], "open_ms": t["open_ms"], "close_ms": t["close_ms"],
            "entry_price": t["entry_price"], "exit_price": t["exit_price_avg"],
            "initial_sl": t.get("initial_sl"), "sl_at_close": t.get("sl_at_close"), "tp_at_close": t.get("tp_at_close"),
            "close_reason": t["close_reason"], "exits": len(t.get("exits", [])), "pnl": t["pnl"],
            "cost": t["spread_cost"] + t["slippage_cost"] + t["fees"],
            "r": of.r_multiple(t["pnl"], t["entry_price"], t.get("initial_sl"), t["qty"], spec),
            "decision_ms": decision.get(t["position_id"]),
        })
    return rows


REPORT_VERSION = 5  # 2 起带每笔事实和每轮数字（第 5b 阶段，统计与审查页用）；3 = 修正同一根 1m 内开平仓的止盈记录。4 = 止损宽限 3 根、重仓改按止损风险（D72）。5 = 重仓线改为 10%（D73）。旧版本在统计页打开时自动重新生成


def round_brief(sess: dict, account: dict, curve_ms: np.ndarray, curve_total: np.ndarray, curve_trading: np.ndarray,
                violations: list[dict], mismatches: list[str], spec: dict, facts: list[dict] | None = None,
                summary: dict | None = None, round_no: int | None = None) -> dict:
    """单轮简报。sess 为 sessions 表的一行；account 为服务器复算后的交易账户；curve_* 为每根 1m 收盘后的资产。
    facts / summary 为纪律审查的每笔事实和每轮数字（第 5b 阶段，存进简报供统计页汇总）；round_no = 该品种的第几轮。"""
    trades = account["trades"]
    pnls = np.array([t["pnl"] for t in trades], dtype=float)
    dd_amt, dd_pct = max_drawdown(curve_total)
    start, end = sess["segment_start_ms"], sess["replay_ms"]
    return {
        "reveal": {
            "symbol": sess["symbol"], "start_timeframe": sess["start_timeframe"],
            "start_utc": _utc(start), "end_utc": _utc(end), "days": round((end - start) / 86_400_000, 1),
            "bars_played": sess["bars_played"], "end_reason": sess["end_reason"],
            "real_minutes": _minutes_between(sess.get("created_at"), sess.get("finished_at")),
        },
        "equity": {
            "points": thin_curve(curve_ms, curve_total, curve_trading),
            "initial_total": sess.get("initial_total_assets"),
            "final_total": account["balance"] + account["funding"],
            "max_drawdown": dd_amt, "max_drawdown_pct": dd_pct,
        },
        "basics": {
            "trades": len(trades), "wins": int((pnls > 0).sum()), "losses": int((pnls <= 0).sum()),
            "net_pnl": float(pnls.sum()),
            "spread_cost": sum(t["spread_cost"] for t in trades), "slippage_cost": sum(t["slippage_cost"] for t in trades),
            "fees": sum(t["fees"] for t in trades),
            "cost_total": sum(t["spread_cost"] + t["slippage_cost"] + t["fees"] for t in trades),
            "liquidations": len(account.get("liquidations", [])),
            "transfers": account.get("transfers", []),
        },
        "violations": violations,
        "trades": trade_rows(trades, spec, facts),
        "check": {"consistent": not mismatches, "differences": mismatches},
        "version": REPORT_VERSION, "round_no": round_no, "facts": facts or [], "summary": summary,
    }


# ============================================================
# 统计与审查页的 MT4 式统计表（第 5b 阶段）
# ============================================================

def _longest_streak(losing: np.ndarray) -> int:
    """来源 CryptoTrade/backtest/analyzer.py（原样复制）。"""
    best = cur = 0
    for x in losing:
        cur = cur + 1 if x else 0
        best = max(best, cur)
    return best


def _drawdown(pnl: np.ndarray, capital: float) -> tuple[float, float]:
    """最大回撤（金额、百分比）。余额序列从初始资金开始。来源 CryptoTrade/backtest/analyzer.py（原样复制）。"""
    equity = capital + np.concatenate([[0.0], np.cumsum(pnl)])
    peak = np.maximum.accumulate(equity)
    dd = peak - equity
    k = int(np.argmax(dd))
    return float(dd[k]), float(dd[k] / peak[k]) if peak[k] > 0 else np.nan


def _streak_amount(pnl: np.ndarray, want_win: bool) -> tuple[int, float]:
    """最长连赢（或连亏）的笔数和合计金额（笔数相同取金额绝对值大的）。"""
    best = (0, 0.0)
    cnt, amt = 0, 0.0
    for x in pnl:
        hit = x > 0 if want_win else x <= 0
        cnt, amt = (cnt + 1, amt + x) if hit else (0, 0.0)
        if cnt > best[0] or (cnt == best[0] and abs(amt) > abs(best[1])):
            best = (cnt, amt)
    return best


def _runs(pnl: np.ndarray, want_win: bool) -> list[tuple[int, float]]:
    """所有连赢（或连亏，盈亏 ≤ 0）段：每段（笔数, 合计金额），按发生先后。"""
    out: list[tuple[int, float]] = []
    cnt, amt = 0, 0.0
    for x in list(pnl) + [None]:
        hit = x is not None and (x > 0 if want_win else x <= 0)
        if hit:
            cnt, amt = cnt + 1, amt + x
        elif cnt:
            out.append((cnt, amt))
            cnt, amt = 0, 0.0
    return out


def _mt4_streaks(pnl: np.ndarray) -> dict:
    """MT4 报告里另外三项（D73）：金额最大的连赢 / 连亏段（金额和笔数）、平均每段连赢 / 连亏几笔。"""
    out = {}
    for name, win in (("win", True), ("loss", False)):
        runs = _runs(pnl, win)
        best = max(runs, key=lambda r: abs(r[1]), default=(0, 0.0))
        out[f"max_{name}_streak_amount"] = {"count": best[0], "amount": best[1]}
        out[f"avg_{name}_streak"] = sum(r[0] for r in runs) / len(runs) if runs else None
    return out


def range_stats(trades: list[dict], rounds: list[dict], capital: float) -> dict:
    """一段范围的 MT4 式统计表。trades：各轮逐笔（按轮次、再按平仓先后），每条有 pnl、direction、cost、round_no；
    rounds：各轮 {round_no, start_utc, end_utc, days, bars_played}；capital：单轮的初始总资产（用来换算回撤占比）。
    盈亏 ≤ 0 算亏损单（规格书 15.1 节）；最长连亏按 analyzer 的口径只数盈亏 < 0。
    曲线是「累计盈亏」（用户 2026-10-22 定）：把各轮逐笔盈亏首尾相接、从 0 开始，round_marks 标出每轮从第几笔开始。
    每轮都从初始资金重新开始，所以不能当成一条净值曲线（否则强平过的轮次会把它压到负的本金以下，回撤超过 100%）；
    最大回撤 = 累计盈亏从前高回落的最大金额，另给「相当于单轮初始资金的百分比」。
    D73 照 MT4 报告补：绝对回撤 = 累计盈亏最低跌到 0 以下多少（MT4 原意：跌破起始资金多少，没跌破为 0）；
    金额最大的连赢 / 连亏段、平均每段连赢 / 连亏几笔；相对回撤不做（各轮重开，没有连续账户可算百分比）。"""
    pnl = np.array([t["pnl"] for t in trades], dtype=float)
    wins, losses = pnl[pnl > 0], pnl[pnl <= 0]
    n = len(pnl)
    dd_amt = _drawdown(pnl, capital)[0] if n else 0.0  # 金额与起点无关，和 analyzer 的算法相同
    marks, seen = [], set()
    for i, t in enumerate(trades):
        if t.get("round_no") not in seen:
            seen.add(t.get("round_no"))
            marks.append({"index": i + 1, "round_no": t.get("round_no")})
    longs = [t for t in trades if t["direction"] == 1]
    shorts = [t for t in trades if t["direction"] == -1]
    rate = lambda xs: sum(1 for t in xs if t["pnl"] > 0) / len(xs) if xs else None  # noqa: E731
    win_streak, loss_streak = _streak_amount(pnl, True), _streak_amount(pnl, False)
    return {
        "periods": [{"round_no": r["round_no"], "start_utc": r["start_utc"], "end_utc": r["end_utc"]} for r in rounds],
        "rounds": len(rounds), "days": round(sum(r["days"] for r in rounds), 1), "bars": sum(r["bars_played"] for r in rounds),
        "trades": n, "net_pnl": float(pnl.sum()), "gross_profit": float(wins.sum()), "gross_loss": float(losses.sum()),
        "wins": len(wins), "losses": len(losses), "win_rate": len(wins) / n if n else None,
        "profit_factor": float(wins.sum() / -losses.sum()) if losses.sum() < 0 else None,
        "payoff_ratio": float(wins.mean() / -losses[losses < 0].mean()) if len(wins) and (losses < 0).any() else None,
        "longs": len(longs), "long_win_rate": rate(longs), "shorts": len(shorts), "short_win_rate": rate(shorts),
        "avg_pnl": float(pnl.mean()) if n else None,
        "largest_win": float(pnl.max()) if n and pnl.max() > 0 else None,
        "largest_loss": float(pnl.min()) if n and pnl.min() < 0 else None,
        "avg_win": float(wins.mean()) if len(wins) else None, "avg_loss": float(losses.mean()) if len(losses) else None,
        "max_drawdown": dd_amt, "max_drawdown_of_round_capital": dd_amt / capital if capital else None,
        "cost_total": sum(t["cost"] for t in trades),
        "longest_win_streak": {"count": win_streak[0], "amount": win_streak[1]},
        "longest_loss_streak": {"count": loss_streak[0], "amount": loss_streak[1]},
        "longest_loss_streak_analyzer": _longest_streak(pnl < 0),
        "absolute_drawdown": float(max(0.0, -np.cumsum(pnl).min())) if n else 0.0,
        **_mt4_streaks(pnl),
        "cum_pnl": [round(float(x), 2) for x in np.concatenate([[0.0], np.cumsum(pnl)])],
        "round_marks": marks, "round_capital": capital,
        # 单轮内的最大回撤（按该轮总资产曲线算，真实账户意义上的回撤，不会超过 100%）：取最严重的一轮
        "worst_round_drawdown": max(({"round_no": r["round_no"], "pct": r["max_drawdown_pct"]} for r in rounds
                                     if r.get("max_drawdown_pct") is not None), key=lambda x: x["pct"], default=None),
    }
