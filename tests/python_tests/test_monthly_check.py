# -*- coding: utf-8 -*-
"""
每月完整性检查的测试：缺口查找、黄金缺口分类（周末 / 每日休市 / 其他）、7×24 品种缺分钟。
运行（项目根目录）：.venv/bin/python -m pytest tests/python_tests -q
"""

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from python_backend.market_data_downloader import download_common
from python_backend.market_data_downloader import monthly_update_and_check as mu
from python_backend.trading_rules import kline_data as kd

GOLD = {"platform": "exness"}
CRYPTO = {"platform": "binance"}


def utc_ms(text: str) -> int:
    return int(datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp() * 1000)


def frame(ts: np.ndarray) -> pd.DataFrame:
    n = len(ts)
    return pd.DataFrame({"timestamp": ts.astype("int64"), "open": np.ones(n), "high": np.ones(n) * 2,
                         "low": np.zeros(n), "close": np.ones(n), "volume": np.ones(n)})


def full_month(month_key: str) -> np.ndarray:
    start, end = kd.month_bounds_ms(month_key)
    return np.arange(start, end, kd.MINUTE_MS, dtype="int64")


def drop(ts: np.ndarray, start: str, end: str) -> np.ndarray:
    """去掉 [start, end) 这段时间的分钟。"""
    return ts[(ts < utc_ms(start)) | (ts >= utc_ms(end))]


def test_find_gaps_includes_month_edges():
    start, end = utc_ms("2026-09-01 00:00"), utc_ms("2026-09-01 01:00")
    ts = np.arange(utc_ms("2026-09-01 00:10"), utc_ms("2026-09-01 00:50"), kd.MINUTE_MS)
    gaps = download_common.find_gaps(pd.Series(ts), start, end)
    assert list(gaps["missing_minutes"]) == [10, 10]


def test_crypto_full_month_has_no_warning():
    warnings, stats = mu.completeness_review(frame(full_month("2026-09")), CRYPTO, "2026-09")
    assert warnings == [] and stats["missing_minutes"] == 0


def test_crypto_missing_minutes_warned():
    ts = drop(full_month("2026-09"), "2026-09-10 03:00", "2026-09-10 03:07")
    warnings, stats = mu.completeness_review(frame(ts), CRYPTO, "2026-09")
    assert stats["missing_minutes"] == 7 and len(warnings) == 1


def gold_september() -> np.ndarray:
    """2026-09 的黄金：每天 21:00–22:00 休市；每周五 21:00 收盘、周日 22:00 开盘（夏令时）。"""
    ts = full_month("2026-09")
    t = pd.to_datetime(ts, unit="ms", utc=True)
    weekday, hour = t.weekday, t.hour
    closed = (hour == 21) | ((weekday == 4) & (hour >= 21)) | (weekday == 5) | ((weekday == 6) & (hour < 22))
    return ts[~np.asarray(closed)]


def test_gold_normal_month_only_weekends_and_daily_breaks():
    warnings, stats = mu.completeness_review(frame(gold_september()), GOLD, "2026-09")
    assert warnings == []
    assert stats["other_gaps"] == 0 and stats["weekend_gaps"] == 4 and stats["daily_breaks"] > 15


def test_gold_holiday_gap_is_flagged():
    """2026-09-07 劳动节提前收盘（真实数据里就是这样）：应该作为「其他」缺口交人看。"""
    ts = drop(gold_september(), "2026-09-07 18:30", "2026-09-07 21:00")
    warnings, stats = mu.completeness_review(frame(ts), GOLD, "2026-09")
    assert stats["other_gaps"] == 1 and len(warnings) == 1 and "2026-09-07 18:30" in warnings[0]


def test_gold_short_other_gap_counted_not_warned():
    ts = drop(gold_september(), "2026-09-15 10:00", "2026-09-15 10:05")
    warnings, stats = mu.completeness_review(frame(ts), GOLD, "2026-09")
    assert warnings == [] and stats["other_gaps"] == 1


def test_last_complete_month():
    assert mu.last_complete_month(datetime(2026, 10, 20, tzinfo=timezone.utc)) == "2026-09"
    assert mu.last_complete_month(datetime(2027, 1, 1, tzinfo=timezone.utc)) == "2026-12"
