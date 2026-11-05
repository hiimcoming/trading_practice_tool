# -*- coding: utf-8 -*-
"""
「统计与审查」页的数据（第 5b 阶段，D68；取代规格书 7.2 节原「每 5 轮一份阶段报告」）。每个用户、每个品种一页：
  ① 进步曲线：该品种全部已完成轮次，横轴为第几轮（discipline_review.progress_series）；
  ①b 每 5 轮一组的对比（第 5b-2 阶段，D71）：第 1–5 轮、第 6–10 轮……每组一行，最后不满 5 轮的一组照样列出并标「未满 5 轮」；
     和进步曲线一样看全部轮次，不受下面的范围影响；
  ② 范围：最近 5 轮 / 最近 10 轮 / 最近 30 天（按真实练习日期）/ 全部 / 自定义起止日期（第 5b-2 阶段，D71：按练习完成日期，
     「一天」按该用户设置页的显示时区划分，UTC 或 UTC+8），下面三块按范围算；
  ③ 问题提示、④ MT4 式统计表（performance_reports.range_stats）、⑤ 纪律审查表（discipline_review.review_tables）。
数字全部来自每轮的单轮简报（服务器复算的结果，含每笔事实和每轮数字）。第 5b 之前生成的简报没有这些事实，
打开统计页时自动重新复算一次（只缺浏览器记录的「决策用时」，显示无记录）；没有交易账户的旧轮次不计入。
「下载我的数据」（第 5c 阶段，D70）用同一份计算（export_markdown），所以导出文件里的数字和统计页一致。
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

from python_backend.practice_reports import discipline_review, export_markdown_html, performance_reports
from python_backend.website_server import practice_sessions, session_finish, user_database
from python_backend.website_server.practice_sessions import SessionError

logger = logging.getLogger("review_statistics")

RANGES = {"last5": "最近 5 轮", "last10": "最近 10 轮", "days30": "最近 30 天", "all": "全部", "custom": "自定义日期"}
GROUP_SIZE = 5  # 每几轮一组（规格书 7.3 节「每 5 轮一组的胜率」）


def _completed_rounds(username: str, symbol: str) -> list[dict]:
    with user_database.user_db(username) as db:
        rows = [dict(r) for r in db.execute(
            "SELECT s.id, s.finished_at, s.state, r.payload FROM sessions s"
            " LEFT JOIN reports r ON r.session_id = s.id AND r.kind = ?"
            " WHERE s.symbol = ? AND s.status = 'completed' ORDER BY s.finished_at, s.created_at, s.id",
            (session_finish.REPORT_KIND, symbol))]
    return rows


def _brief_of(username: str, row: dict) -> dict | None:
    """这一轮的简报（第 5b 版本）；旧版或没有就当场重新生成；不能生成（没有交易账户）返回 None。"""
    if "account" not in json.loads(row["state"] or "{}"):
        return None
    payload = json.loads(row["payload"]) if row["payload"] else {}
    brief = payload.get("report") if payload.get("status") == "done" else None
    if brief and brief.get("version", 1) >= performance_reports.REPORT_VERSION:
        return brief
    try:
        brief = session_finish.generate_report(username, row["id"])
    except SessionError as e:
        logger.warning("统计页跳过一轮：%s / %s：%s", username, row["id"], e)
        return None
    session_finish._save(username, row["id"], {"status": "done", "step": len(session_finish.STEPS) + 1, "report": brief})
    logger.info("统计页按新版本重新生成了简报：%s / %s", username, row["id"])
    return brief


def _custom_bounds(start: str | None, end: str | None, utc_offset_hours: int) -> tuple[str, str, str, str]:
    """自定义日期范围 → 完成时刻的 UTC 上下界（含下界、不含上界，格式同 sessions.finished_at），另返回规范写法的起止日期。
    start / end 是用户所在时区的日期（YYYY-MM-DD），结束日期当天整天都算。
    例：UTC+8、2026-10-22 至 2026-10-22 → UTC 2026-10-21 16:00:00 ≤ 完成时刻 < 2026-10-22 16:00:00。"""
    try:
        d0 = datetime.strptime(start or "", "%Y-%m-%d")
        d1 = datetime.strptime(end or "", "%Y-%m-%d")
    except ValueError:
        raise SessionError("请填写起止日期（格式 YYYY-MM-DD）", 422) from None
    if d0 > d1:
        raise SessionError("起始日期晚于结束日期，请重新选择", 422)
    shift = timedelta(hours=utc_offset_hours)
    fmt = "%Y-%m-%d %H:%M:%S"
    return (d0 - shift).strftime(fmt), (d1 + timedelta(days=1) - shift).strftime(fmt), d0.strftime("%Y-%m-%d"), d1.strftime("%Y-%m-%d")


def _in_range(range_key: str, rounds: list[dict], now: datetime, bounds: tuple[str, str] | None = None) -> list[dict]:
    if range_key == "last5":
        return rounds[-5:]
    if range_key == "last10":
        return rounds[-10:]
    if range_key == "days30":
        limit = (now - timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")
        return [r for r in rounds if (r["finished_at"] or "") >= limit]
    if range_key == "all":
        return rounds
    if range_key == "custom" and bounds:
        return [r for r in rounds if bounds[0] <= (r["finished_at"] or "") < bounds[1]]
    raise SessionError(f"不支持的范围 {range_key}", 422)


def _range_label(range_key: str, start: str | None, end: str | None, utc_offset_hours: int) -> str:
    if range_key != "custom":
        return RANGES[range_key]
    tz = f"UTC+{utc_offset_hours}" if utc_offset_hours else "UTC"
    return f"{start} 至 {end}（按练习完成日期，{tz}）"


def _groups(rounds: list[dict], facts_by_round: dict[int, list[dict]]) -> list[dict]:
    """每 5 轮一组（按该品种的第几轮：1–5、6–10……）：笔数、胜率、盈亏比、利润因子、守纪律占比、违规次数、净盈亏。
    胜率等直接用 MT4 式统计表的同一个函数算，所以只有一组时与「全部」完全相同。"""
    by_group: dict[int, list[dict]] = {}
    for r in rounds:
        by_group.setdefault((r["round_no"] - 1) // GROUP_SIZE, []).append(r)
    out = []
    for k, rs in sorted(by_group.items()):
        trades = [t for r in rs for t in sorted(r["trade_rows"], key=lambda t: (t["close_ms"], t["no"]))]
        facts = [f for r in rs for f in facts_by_round[r["round_no"]]]
        s = performance_reports.range_stats(trades, rs, 0.0)
        out.append({
            "first": k * GROUP_SIZE + 1, "last": (k + 1) * GROUP_SIZE, "round_nos": [r["round_no"] for r in rs],
            "complete": len(rs) == GROUP_SIZE,
            "trades": s["trades"], "win_rate": s["win_rate"], "payoff_ratio": s["payoff_ratio"], "profit_factor": s["profit_factor"],
            "disciplined_share": sum(1 for f in facts if f["disciplined"]) / len(facts) if facts else None,
            "violations": sum(r["violations_total"] for r in rs), "net_pnl": s["net_pnl"],
        })
    return out


def _page(username: str, symbol: str, range_key: str, now: datetime | None,
          start: str | None = None, end: str | None = None) -> tuple[dict, list[dict], dict]:
    """统计页的数据，另返回范围内各轮的简报（带 round_no、session_id）和每轮的交易事实，供导出用。
    range_key = custom 时用 start / end（用户所在时区的日期，含首尾两天）。"""
    practice_sessions.market_spec(symbol)  # 品种不存在时报错
    if range_key not in RANGES:
        raise SessionError(f"不支持的范围 {range_key}", 422)
    tz = user_database.utc_offset_hours(username)  # 与设置页一致：只有 UTC 和 UTC+8
    bounds = None
    if range_key == "custom":
        lo, hi, start, end = _custom_bounds(start, end, tz)
        bounds = (lo, hi)
        logger.info("统计范围：%s / %s 自定义 %s 至 %s（UTC+%d）→ 完成时刻 %s ≤ t < %s", username, symbol, start, end, tz, lo, hi)
    settings = practice_sessions.load_settings()
    rounds, facts_by_round, briefs = [], {}, {}
    for i, row in enumerate(_completed_rounds(username, symbol)):
        brief = _brief_of(username, row)
        if brief is None or brief.get("summary") is None:
            continue
        no = i + 1  # 该品种完成的第几轮（含不能统计的旧轮次，与简报里的 round_no 一致）
        rv = brief["reveal"]
        rounds.append({**brief["summary"], "round_no": no, "session_id": row["id"], "finished_at": row["finished_at"],
                       "start_utc": rv["start_utc"], "end_utc": rv["end_utc"], "days": rv["days"],
                       "initial_total": brief["equity"]["initial_total"], "trade_rows": brief["trades"]})
        facts_by_round[no] = [dict(f, round_no=no) for f in brief["facts"]]
        briefs[no] = dict(brief, round_no=no, session_id=row["id"], finished_at=row["finished_at"])
    progress = discipline_review.progress_series(rounds, facts_by_round, settings)
    chosen = _in_range(range_key, rounds, now or datetime.now(timezone.utc), bounds)
    facts = [f for r in chosen for f in facts_by_round[r["round_no"]]]
    trades = [dict(t, round_no=r["round_no"]) for r in chosen for t in sorted(r["trade_rows"], key=lambda t: (t["close_ms"], t["no"]))]
    capital = next((r["initial_total"] for r in chosen if r["initial_total"]), 0.0)
    review = discipline_review.review_tables(facts, chosen, settings)
    page = {
        "symbol": symbol, "rounds_total": len(rounds), "range": range_key,
        "range_label": _range_label(range_key, start, end, tz), "range_start": start if bounds else None, "range_end": end if bounds else None,
        "range_rounds": [r["round_no"] for r in chosen],
        "range_summary": _range_summary(chosen, tz),
        "currency": export_markdown_html.currency_of(practice_sessions.market_spec(symbol)),
        "progress": progress, "groups": _groups(rounds, facts_by_round), "group_size": GROUP_SIZE,
        "stats": performance_reports.range_stats(trades, chosen, capital),
        "review": review,
        "hints": discipline_review.hints(review, settings),
        "violation_kinds": discipline_review.VIOLATION_KINDS,
    }
    return page, [briefs[r["round_no"]] for r in chosen], facts_by_round


def _range_summary(chosen: list[dict], tz: int) -> dict | None:
    """标题用（D72）：所选范围是第几轮到第几轮、练习日期从哪天到哪天、跨了几天（首尾都算，按用户时区）。"""
    if not chosen:
        return None
    dates = sorted(d for d in (user_database.local_date(r["finished_at"], tz) for r in chosen) if d)
    days = None
    if dates:
        days = (datetime.strptime(dates[-1], "%Y-%m-%d") - datetime.strptime(dates[0], "%Y-%m-%d")).days + 1
    return {"first_round": chosen[0]["round_no"], "last_round": chosen[-1]["round_no"], "rounds": len(chosen),
            "from_date": dates[0] if dates else None, "to_date": dates[-1] if dates else None, "days": days}


def statistics_page(username: str, symbol: str, range_key: str = "last5", now: datetime | None = None,
                    start: str | None = None, end: str | None = None) -> dict:
    return _page(username, symbol, range_key, now, start, end)[0]


def export_markdown(username: str, symbol: str, range_key: str = "all", now: datetime | None = None,
                    start: str | None = None, end: str | None = None) -> tuple[str, str]:
    """「下载我的数据」：返回（文件名, Markdown 文字）。只含所选品种、所选范围的已完成轮次。"""
    now = now or datetime.now(timezone.utc)
    page, briefs, facts_by_round = _page(username, symbol, range_key, now, start, end)
    display = user_database.display_name(username)
    text = export_markdown_html.render_markdown(
        display, practice_sessions.market_spec(symbol), page, briefs, facts_by_round,
        practice_sessions.load_settings(), now)
    tag = f"{page['range_start']}_{page['range_end']}" if range_key == "custom" else range_key
    filename = f"trading_practice_{username}_{symbol}_{tag}_{now.strftime('%Y%m%d_%H%M')}.md"
    logger.info("导出我的数据：%s / %s / %s，%d 轮、%d 笔", username, symbol, tag, len(briefs), page["stats"]["trades"])
    return filename, text
