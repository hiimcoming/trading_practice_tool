# -*- coding: utf-8 -*-
"""
每月更新 + 完整性检查（规格书 3.3 节）：下载缺少的完整月份，检查后写入按月 Parquet，并核对已有文件没有损坏。

流程（每个品种）：
  1. 要有的月份 = 品种档案里的 chart_history_start（没有就用 history_start；D74：更早的月份只当图表背景）到「上一个完整的 UTC 月份」（当月还没结束，不下载）；
  2. 已完整的月份：重新计算文件校验值（sha256），与说明卡里记录的一致就跳过；不一致说明文件损坏或被改动，重新下载；
  3. 缺少的月份：调用对应来源的下载器取 1m → 结构检查（有问题直接不写入，记为失败）→ 完整性检查（缺口分类、
     根数是否正常；有疑问的写入但标记 warnings，交给人看）→ 写入正式文件 → 记录行数、校验值、检查结果到 meta.json；
  4. 最后打印汇总表。中途出错只影响当前月份，重新运行会从断点继续（Dukascopy 已下的天不用重下）。

运行（项目根目录）：
  .venv/bin/python -m python_backend.market_data_downloader.monthly_update_and_check                  # 全部品种
  .venv/bin/python -m python_backend.market_data_downloader.monthly_update_and_check --symbols BTCUSDT
  .venv/bin/python -m python_backend.market_data_downloader.monthly_update_and_check --verify-only    # 只核对，不下载
  .venv/bin/python -m python_backend.market_data_downloader.monthly_update_and_check --symbols XAUUSD --only-months 2026-09
"""

from __future__ import annotations

import argparse
import logging
from datetime import datetime, timezone

import pandas as pd

from python_backend import backend_settings
from python_backend.market_data_downloader import binance_downloader, download_common, dukascopy_downloader
from python_backend.trading_rules import kline_data

FETCHERS = {
    binance_downloader.SOURCE: binance_downloader.fetch_month,
    dukascopy_downloader.SOURCE: dukascopy_downloader.fetch_month,
}
# 「其他」类缺口（不是周末、不是每日休市）超过这么多分钟就标记 warnings 交人看
OTHER_GAP_WARN_MINUTES = 30
# Dukascopy 黄金：每个工作日正常约 1380 根 1m；平均低于这个数就标记 warnings
MIN_ROWS_PER_WEEKDAY = 1000

logger = download_common.setup_logger("monthly")


# ============================================================
# 月份范围
# ============================================================

def last_complete_month(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    year, month = (now.year - 1, 12) if now.month == 1 else (now.year, now.month - 1)
    return f"{year:04d}-{month:02d}"


# ============================================================
# 完整性检查（软性：有疑问就标记，交人看）
# ============================================================

def classify_gold_gaps(gaps: pd.DataFrame, month_start: pd.Timestamp, month_end: pd.Timestamp) -> pd.Series:
    """
    黄金缺口分类：
      周末休市：从周五 19 点（UTC）以后或周六开始，到周日 21 点以后或周一开始；月初、月末落在周末里的半截也算；
      每日休市：从 UTC 20–22 点开始、不超过 75 分钟（夏令时 21 点、冬令时 22 点休市约 1 小时）；
      其他：节假日、数据缺失等，需要人看。
    """
    if gaps.empty:
        return pd.Series(dtype=str)
    s, e = gaps["gap_start"], gaps["gap_end"]
    starts_weekend = ((s.dt.weekday == 4) & (s.dt.hour >= 19)) | (s.dt.weekday == 5) | \
                     ((s.dt.weekday == 6) & (s.dt.hour < 21)) | (s == month_start)
    ends_weekend = ((e.dt.weekday == 6) & (e.dt.hour >= 21)) | ((e.dt.weekday == 0) & (e.dt.hour <= 1)) | \
                   (e == month_end)
    weekend = starts_weekend & ends_weekend & (gaps["missing_minutes"] <= 60 * 60)
    daily = s.dt.hour.between(20, 22) & (gaps["missing_minutes"] <= 75)
    kinds = pd.Series("其他", index=gaps.index)
    kinds[daily] = "每日休市"
    kinds[weekend] = "周末休市"
    return kinds


def completeness_review(df: pd.DataFrame, spec: dict, month_key: str) -> tuple[list[str], dict]:
    """返回 (疑问清单, 缺口统计)。疑问清单为空表示完整。"""
    start_ms, end_ms = kline_data.month_bounds_ms(month_key)
    gaps = download_common.find_gaps(df["timestamp"], start_ms, end_ms)
    warnings = []
    if spec["platform"] == "binance":
        missing = int(gaps["missing_minutes"].sum()) if len(gaps) else 0
        stats = {"gaps": len(gaps), "missing_minutes": missing}
        if missing:
            worst = gaps.sort_values("missing_minutes").iloc[-1]
            warnings.append(f"7×24 品种缺 {missing} 分钟（{len(gaps)} 处），最长一处 {int(worst['missing_minutes'])} 分钟，"
                            f"从 {worst['gap_start']:%Y-%m-%d %H:%M} 开始")
        return warnings, stats
    kinds = classify_gold_gaps(gaps, pd.Timestamp(start_ms, unit="ms", tz="UTC"),
                               pd.Timestamp(end_ms, unit="ms", tz="UTC"))
    other = gaps[kinds == "其他"]
    big_other = other[other["missing_minutes"] >= OTHER_GAP_WARN_MINUTES]
    stats = {"weekend_gaps": int((kinds == "周末休市").sum()), "daily_breaks": int((kinds == "每日休市").sum()),
             "other_gaps": len(other), "other_missing_minutes": int(other["missing_minutes"].sum()) if len(other) else 0}
    for _, g in big_other.iterrows():
        warnings.append(f"「其他」缺口 {int(g['missing_minutes'])} 分钟：{g['gap_start']:%Y-%m-%d %H:%M}（周{'一二三四五六日'[g['gap_start'].weekday()]}）"
                        f" → {g['gap_end']:%Y-%m-%d %H:%M}")
    weekdays = sum(1 for d in pd.date_range(pd.Timestamp(start_ms, unit="ms"), periods=31, freq="D")
                   if d < pd.Timestamp(end_ms, unit="ms") and d.weekday() < 5)
    per_weekday = len(df) / weekdays if weekdays else 0
    stats["rows_per_weekday"] = round(per_weekday, 1)
    if per_weekday < MIN_ROWS_PER_WEEKDAY:
        warnings.append(f"平均每个工作日只有 {per_weekday:.0f} 根 1m（正常约 1380）")
    return warnings, stats


# ============================================================
# 单个月份
# ============================================================

def month_is_intact(meta: dict, path, month_key: str) -> bool:
    """说明卡里记录为已写入、文件存在、校验值一致 → 不用再下。"""
    info = meta["months"].get(month_key)
    if not info or info.get("status") not in ("complete", "warnings") or not path.exists():
        return False
    if download_common.file_sha256(path) != info.get("sha256"):
        logger.error(f"[损坏] {path.name} 的校验值与记录不一致（文件损坏或被改动），将重新下载")
        return False
    return True


def update_month(session, symbol: str, spec: dict, month_key: str, meta: dict) -> str:
    """下载、检查、写入一个月。返回结果：complete / warnings / failed。"""
    path = kline_data.month_file_path(backend_settings.KLINE_DIR, spec["data_source"], symbol, month_key)
    df, extra = FETCHERS[spec["data_source"]](session, spec, month_key, logger)
    try:
        kline_data.write_month_file(path, df, month_key)
    except ValueError as e:
        meta["months"][month_key] = {"status": "failed", "reason": str(e), "checked_at_utc": download_common.now_utc_text()}
        logger.error(f"[不写入] {symbol} {month_key}：{e}")
        return "failed"
    warnings, stats = completeness_review(df, spec, month_key)
    status = "warnings" if warnings else "complete"
    meta["months"][month_key] = {
        "status": status, "rows": int(len(df)),
        "first_bar_utc": download_common.fmt_ms(int(df["timestamp"].min())),
        "last_bar_utc": download_common.fmt_ms(int(df["timestamp"].max())),
        "sha256": download_common.file_sha256(path), "checked_at_utc": download_common.now_utc_text(),
        "gap_stats": stats, "warnings": warnings, **extra,
    }
    if spec["data_source"] == dukascopy_downloader.SOURCE:
        dukascopy_downloader.cleanup_month_tmp(spec, month_key)
    note = f"，疑问 {len(warnings)} 条" if warnings else ""
    logger.info(f"[写入] {symbol} {month_key}：{len(df)} 根，删假 K 线 {extra.get('fake_bars_dropped', 0)} 根{note}")
    for w in warnings:
        logger.warning(f"[疑问] {symbol} {month_key}：{w}")
    return status


def update_symbol(session, symbol: str, spec: dict, verify_only: bool, only_months: list[str] | None = None) -> dict:
    months = kline_data.month_range(spec.get("chart_history_start", spec["history_start"]), last_complete_month())
    if only_months:
        months = [m for m in months if m in only_months]
        if not months:
            raise ValueError(f"--only-months 指定的月份不在 {symbol} 的历史范围内")
    meta = download_common.read_meta(spec["data_source"], symbol)
    counts = {"complete": 0, "warnings": 0, "failed": 0, "missing": 0}
    logger.info(f"==== {symbol}（{spec['data_source']}）：{months[0]} 至 {months[-1]}，共 {len(months)} 个月 ====")
    for month_key in months:
        path = kline_data.month_file_path(backend_settings.KLINE_DIR, spec["data_source"], symbol, month_key)
        if month_is_intact(meta, path, month_key):
            counts[meta["months"][month_key]["status"]] += 1
            continue
        if verify_only:
            counts["missing"] += 1
            continue
        try:
            counts[update_month(session, symbol, spec, month_key, meta)] += 1
        except download_common.AccessDeniedError:
            download_common.write_meta(meta)
            raise
        except Exception as e:  # 单月出错不影响其他月份
            meta["months"][month_key] = {"status": "failed", "reason": f"{type(e).__name__}: {e}",
                                         "checked_at_utc": download_common.now_utc_text()}
            counts["failed"] += 1
            logger.error(f"[失败] {symbol} {month_key}：{e}。重新运行会从断点继续。")
        download_common.write_meta(meta)
    download_common.write_meta(meta)
    return {"品种": symbol, "应有月份": len(months), "完整": counts["complete"], "有疑问": counts["warnings"],
            "失败": counts["failed"], "未下载": counts["missing"], "总根数": meta.get("total_rows", 0),
            "首根": meta.get("first_bar_utc"), "末根": meta.get("last_bar_utc")}


# ============================================================
# 主程序
# ============================================================

def parse_args():
    specs = download_common.load_market_specs()
    p = argparse.ArgumentParser(description="每月更新 1m 行情 + 完整性检查")
    p.add_argument("--symbols", nargs="*", default=list(specs), help=f"品种，默认全部：{list(specs)}")
    p.add_argument("--verify-only", action="store_true", help="只核对已有文件的校验值，不下载")
    p.add_argument("--only-months", nargs="*", default=None, help="只处理这几个月（YYYY-MM），用于试跑或补下")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    specs = download_common.load_market_specs()
    download_common.lower_process_priority(logger)
    logger.info(f"[启动] 每月更新，品种 {args.symbols}，最新完整月份 {last_complete_month()}"
                f"{'（只核对）' if args.verify_only else ''}")
    session = download_common.make_session()
    rows = []
    for symbol in args.symbols:
        if symbol not in specs:
            logger.error(f"[跳过] 品种档案里没有 {symbol}，现有：{list(specs)}")
            continue
        try:
            rows.append(update_symbol(session, symbol, specs[symbol], args.verify_only, args.only_months))
        except download_common.AccessDeniedError as e:
            logger.error(f"[停止] {symbol} 数据源拒绝访问：{e}。通常是当前网络所在地区受限，换网络后重新运行即可"
                         f"（已写入的月份不受影响）。")
            break
    if rows:
        with pd.option_context("display.max_columns", None, "display.width", 250):
            logger.info("\n========== 汇总 ==========\n" + pd.DataFrame(rows).to_string(index=False))
    logger.info("[结束] 每月更新运行完毕")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.warning("[中断] 用户手动中断。已写入的月份不受影响，重新运行会从断点继续。")
