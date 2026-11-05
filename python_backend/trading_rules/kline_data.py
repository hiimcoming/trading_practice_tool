# -*- coding: utf-8 -*-
"""
K 线数据：按月读写 1 分钟 K 线、用 1 分钟合成各周期（规格书 3.2、3.4 节）。

存储约定：
  - 只存 1m：local_data/kline/{来源}/{品种}/1m/{YYYY-MM}.parquet，每个品种每月一个文件；
  - 列：timestamp（K 线开盘时刻，UTC 毫秒，int64）、open、high、low、close、volume（float64）；
  - 写文件时先写临时文件再替换，中途出错不会留下写了一半的坏文件。

切分规则（前端回放用 TypeScript 实现同一份规则，第 3 阶段逐根对账）：
  - 1m、5m、15m、30m、1h：按 UTC 整点向下取整；
  - 4h、1d 受「日线起点」day_anchor 影响：
      utc_0  日线从 UTC 0 点开始，4h 为 UTC 0/4/8/12/16/20 点；
      ny_17  日线从纽约 17:00 开始（标准时区库自动处理夏令时：夏令时为 UTC 21:00，冬令时为 UTC 22:00），
             4h 为纽约时间 17/21/1/5/9/13 点；夏令时切换那天的日线为 23 或 25 小时，属正常现象。
  - 1w（D74）：从品种档案 week_start 那天的 UTC 0 点开始（monday = 周一，sunday = 周日），不受日线起点影响；
  - 每根合成 K 线：开 = 第一根 1m 的开，高 = 最高，低 = 最低，收 = 最后一根 1m 的收，量 = 合计，
    minute_count = 由几根 1m 合成。

本模块属于 trading_rules/，不依赖项目内其他目录（目录位置由调用方传入）。
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

KLINE_COLUMNS = ["timestamp", "open", "high", "low", "close", "volume"]
PRICE_COLUMNS = ["open", "high", "low", "close"]

MINUTE_MS = 60_000
TIMEFRAME_MS = {
    "1m": MINUTE_MS,
    "5m": 5 * MINUTE_MS,
    "15m": 15 * MINUTE_MS,
    "30m": 30 * MINUTE_MS,
    "1h": 60 * MINUTE_MS,
    "4h": 240 * MINUTE_MS,
    "1d": 1440 * MINUTE_MS,
    "1w": 7 * 1440 * MINUTE_MS,
}
TIMEFRAMES = list(TIMEFRAME_MS)
DAY_ANCHORS = ("utc_0", "ny_17")
WEEK_STARTS = {"monday": 3, "sunday": 4}  # 1970-01-01 是周四：到周一隔 3 天、到周日隔 4 天，用来把天数对齐到周起点
NEW_YORK_TZ = "America/New_York"


# ============================================================
# 月份与路径
# ============================================================

def month_start_ms(year: int, month: int) -> int:
    """某月 1 日 UTC 0 点的毫秒时间戳。"""
    return int(datetime(year, month, 1, tzinfo=timezone.utc).timestamp() * 1000)


def next_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


def month_bounds_ms(month_key: str) -> tuple[int, int]:
    """'2026-09' → (当月开始, 下月开始)，都是 UTC 毫秒；区间含头不含尾。"""
    year, month = parse_month_key(month_key)
    return month_start_ms(year, month), month_start_ms(*next_month(year, month))


def parse_month_key(month_key: str) -> tuple[int, int]:
    try:
        year_text, month_text = month_key.split("-")
        year, month = int(year_text), int(month_text)
    except ValueError as e:
        raise ValueError(f"[K线] 月份格式应为 YYYY-MM，收到 {month_key!r}") from e
    if not 1 <= month <= 12:
        raise ValueError(f"[K线] 月份超出范围：{month_key!r}")
    return year, month


def month_key_of(ts_ms: int) -> str:
    d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    return f"{d.year:04d}-{d.month:02d}"


def months_between(start_ms: int, end_ms: int) -> list[str]:
    """[start_ms, end_ms) 覆盖到的全部月份（按时间顺序）。"""
    if end_ms <= start_ms:
        return []
    keys = []
    year, month = parse_month_key(month_key_of(start_ms))
    while month_start_ms(year, month) < end_ms:
        keys.append(f"{year:04d}-{month:02d}")
        year, month = next_month(year, month)
    return keys


def month_range(first_key: str, last_key: str) -> list[str]:
    """从 first_key 到 last_key（都含）的全部月份。"""
    start, _ = month_bounds_ms(first_key)
    _, end = month_bounds_ms(last_key)
    return months_between(start, end)


def symbol_dir(kline_dir: Path, source: str, symbol: str) -> Path:
    return Path(kline_dir) / source / symbol


def month_file_path(kline_dir: Path, source: str, symbol: str, month_key: str) -> Path:
    parse_month_key(month_key)
    return symbol_dir(kline_dir, source, symbol) / "1m" / f"{month_key}.parquet"


# ============================================================
# 读写
# ============================================================

def check_1m_frame(df: pd.DataFrame, month_key: str | None = None) -> list[str]:
    """
    检查一份 1m 数据是否「结构正确」（硬性问题，有任何一条就不能写入正式文件）：
    列齐全、无空值、时间按分钟对齐且严格递增（无重复）、高低价不矛盾、（给了月份时）全部落在该月内。
    返回问题清单，空表示通过。
    """
    problems = []
    missing = [c for c in KLINE_COLUMNS if c not in df.columns]
    if missing:
        return [f"缺少列 {missing}"]
    if df.empty:
        return ["没有任何 K 线"]
    if df[KLINE_COLUMNS].isna().any().any():
        problems.append(f"有空值 {int(df[KLINE_COLUMNS].isna().any(axis=1).sum())} 行")
    ts = df["timestamp"].to_numpy()
    if (ts % MINUTE_MS != 0).any():
        problems.append("有不在整分钟上的时间戳")
    if len(ts) > 1 and not (np.diff(ts) > 0).all():
        problems.append("时间不是严格递增（有重复或乱序）")
    bad_hl = (df["high"] < df[["open", "close"]].max(axis=1)) | (df["low"] > df[["open", "close"]].min(axis=1))
    if bad_hl.any():
        problems.append(f"高低价矛盾 {int(bad_hl.sum())} 行")
    if month_key is not None:
        start, end = month_bounds_ms(month_key)
        outside = (ts < start) | (ts >= end)
        if outside.any():
            problems.append(f"有 {int(outside.sum())} 行不属于 {month_key}")
    return problems


def normalize_1m_frame(df: pd.DataFrame) -> pd.DataFrame:
    """只保留标准列、统一类型、按时间排序。"""
    out = df[KLINE_COLUMNS].copy()
    out["timestamp"] = out["timestamp"].astype("int64")
    for c in PRICE_COLUMNS + ["volume"]:
        out[c] = out[c].astype("float64")
    return out.sort_values("timestamp").reset_index(drop=True)


def write_month_file(path: Path, df: pd.DataFrame, month_key: str) -> None:
    """检查通过后写入一个月的 1m 文件（先写临时文件再替换）。检查不通过直接报错，不写。"""
    df = normalize_1m_frame(df)
    problems = check_1m_frame(df, month_key)
    if problems:
        raise ValueError(f"[K线] {month_key} 数据有问题，不写入：{'；'.join(problems)}")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".parquet.tmp")
    try:
        df.to_parquet(tmp, index=False, compression="zstd")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def empty_1m_frame() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype="int64" if c == "timestamp" else "float64") for c in KLINE_COLUMNS})


def read_month_file(path: Path) -> pd.DataFrame:
    """读一个月的 1m 文件；文件不存在返回空表。"""
    path = Path(path)
    if not path.exists():
        return empty_1m_frame()
    return pd.read_parquet(path, columns=KLINE_COLUMNS)


def read_1m_range(kline_dir: Path, source: str, symbol: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    """读取 [start_ms, end_ms) 内的 1m K 线：只打开覆盖到的月份文件，不读整个品种。"""
    parts = [read_month_file(month_file_path(kline_dir, source, symbol, key))
             for key in months_between(start_ms, end_ms)]
    parts = [p for p in parts if not p.empty]
    if not parts:
        return empty_1m_frame()
    df = pd.concat(parts, ignore_index=True)
    df = df[(df["timestamp"] >= start_ms) & (df["timestamp"] < end_ms)]
    return df.sort_values("timestamp").reset_index(drop=True)


# ============================================================
# 合成
# ============================================================

def bucket_open_ms(ts_ms: pd.Series, timeframe: str, day_anchor: str = "utc_0", week_start: str = "monday") -> pd.Series:
    """每根 1m 属于哪根大周期 K 线：返回那根大周期 K 线的开盘时刻（UTC 毫秒）。week_start 只对 1w 起作用。"""
    if timeframe not in TIMEFRAME_MS:
        raise ValueError(f"[K线] 不支持的周期 {timeframe!r}，可选 {TIMEFRAMES}")
    if day_anchor not in DAY_ANCHORS:
        raise ValueError(f"[K线] 不支持的日线起点 {day_anchor!r}，可选 {DAY_ANCHORS}")
    ts_ms = pd.Series(ts_ms, dtype="int64")
    tf_ms = TIMEFRAME_MS[timeframe]
    if timeframe == "1w":
        if week_start not in WEEK_STARTS:
            raise ValueError(f"[K线] 不支持的周起点 {week_start!r}，可选 {list(WEEK_STARTS)}")
        day_ms = TIMEFRAME_MS["1d"]
        days = ts_ms // day_ms
        return (days - (days + WEEK_STARTS[week_start]) % 7) * day_ms
    if day_anchor == "utc_0" or timeframe not in ("4h", "1d"):
        return ts_ms // tf_ms * tf_ms
    return _new_york_17_bucket(ts_ms, "1D" if timeframe == "1d" else "4h")


def _new_york_17_bucket(ts_ms: pd.Series, period: str) -> pd.Series:
    """
    纽约 17:00 起算的 4h / 日线分桶：
    换成纽约当地钟表时间 → 往前挪 17 小时 → 按 1 天或 4 小时向下取整 → 再挪回 17 小时 → 换回 UTC。
    秋季回拨那天，凌晨 1 点的分桶起点出现两次，取第一次（夏令时那次），这根 4h 因此是 5 小时。
    """
    local = pd.to_datetime(ts_ms, unit="ms", utc=True).dt.tz_convert(NEW_YORK_TZ)
    wall = local.dt.tz_localize(None) - pd.Timedelta(hours=17)
    start_wall = wall.dt.floor(period) + pd.Timedelta(hours=17)
    start = start_wall.dt.tz_localize(NEW_YORK_TZ, ambiguous=np.ones(len(start_wall), dtype=bool),
                                      nonexistent="shift_forward")
    # 与时间精度无关的换算（pandas 3 默认保留毫秒精度，不能假设内部单位是纳秒）
    return ((start - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(milliseconds=1)).astype("int64")


def synthesize_by_month(kline_dir: Path, source: str, symbol: str, start_ms: int, end_ms: int, timeframe: str,
                        day_anchor: str = "utc_0", week_start: str = "monday") -> pd.DataFrame:
    """[start_ms, end_ms) 的 1m 逐月读、逐月合成，再把跨月的同一根 K 线拼起来（D74：周线、日线看很多年时，
    不一次把几百万根 1m 读进内存，小内存 VPS 也能跑）。结果与一次读完再 synthesize 完全相同。"""
    parts = []
    for key in months_between(start_ms, end_ms):
        m0, m1 = month_bounds_ms(key)
        df = read_1m_range(kline_dir, source, symbol, max(start_ms, m0), min(end_ms, m1))
        if not df.empty:
            parts.append(synthesize(df, timeframe, day_anchor, week_start))
    if not parts:
        return synthesize(empty_1m_frame(), timeframe, day_anchor, week_start)
    bars = pd.concat(parts, ignore_index=True)
    if not bars["timestamp"].duplicated().any():
        return bars
    out = bars.groupby("timestamp", sort=True).agg(open=("open", "first"), high=("high", "max"), low=("low", "min"),
                                                   close=("close", "last"), volume=("volume", "sum"),
                                                   minute_count=("minute_count", "sum"))
    return out.reset_index()[KLINE_COLUMNS + ["minute_count"]]


def synthesize(df_1m: pd.DataFrame, timeframe: str, day_anchor: str = "utc_0", week_start: str = "monday") -> pd.DataFrame:
    """用 1m 合成指定周期（含最后一根可能不完整的 K 线，由调用方决定要不要）。"""
    columns = KLINE_COLUMNS + ["minute_count"]
    if df_1m.empty:
        return pd.DataFrame({c: pd.Series(dtype="int64" if c in ("timestamp", "minute_count") else "float64")
                             for c in columns})
    df = df_1m.sort_values("timestamp")
    key = bucket_open_ms(df["timestamp"].reset_index(drop=True), timeframe, day_anchor, week_start)
    key.index = df.index
    out = df.groupby(key).agg(open=("open", "first"), high=("high", "max"), low=("low", "min"),
                              close=("close", "last"), volume=("volume", "sum"),
                              minute_count=("timestamp", "size"))
    out.index.name = "timestamp"
    return out.reset_index()[columns]
