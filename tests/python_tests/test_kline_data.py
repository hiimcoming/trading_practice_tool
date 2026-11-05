# -*- coding: utf-8 -*-
"""
kline_data 的测试：按月读写、K 线合成、日线起点（含纽约夏令时切换日）。
运行（项目根目录）：.venv/bin/python -m pytest tests/python_tests -q
"""

from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

from python_backend.trading_rules import kline_data as kd


def utc_ms(text: str) -> int:
    return int(datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp() * 1000)


def minutes(start: str, end: str) -> pd.DataFrame:
    """[start, end) 之间每分钟一根的假数据：开 = 序号，高 = 序号 + 0.5，低 = 序号 − 0.5，收 = 序号 + 0.1，量 = 1。"""
    ts = np.arange(utc_ms(start), utc_ms(end), kd.MINUTE_MS, dtype="int64")
    i = np.arange(len(ts), dtype="float64")
    return pd.DataFrame({"timestamp": ts, "open": i, "high": i + 0.5, "low": i - 0.5, "close": i + 0.1,
                         "volume": np.ones(len(ts))})


def bars_by_start(df: pd.DataFrame) -> dict:
    return {datetime.fromtimestamp(t / 1000, tz=timezone.utc).strftime("%m-%d %H:%M"): int(n)
            for t, n in zip(df["timestamp"], df["minute_count"])}


# ---------------- 合成数值 ----------------

def test_5m_values_from_1m():
    df = minutes("2026-09-01 00:00", "2026-09-01 00:10")
    out = kd.synthesize(df, "5m")
    assert list(out["timestamp"]) == [utc_ms("2026-09-01 00:00"), utc_ms("2026-09-01 00:05")]
    first = out.iloc[0]
    # 第一根由序号 0..4 合成：开 0、高 4.5、低 -0.5、收 4.1、量 5
    assert (first["open"], first["high"], first["low"], first["close"], first["volume"], first["minute_count"]) == \
        (0.0, 4.5, -0.5, 4.1, 5.0, 5)


def test_gap_keeps_partial_bucket():
    """1m 有缺口时，大周期 K 线只用实际存在的 1m 合成，不补假数据。"""
    df = minutes("2026-09-01 00:00", "2026-09-01 00:15")
    df = df[~df["timestamp"].between(utc_ms("2026-09-01 00:06"), utc_ms("2026-09-01 00:08"))]
    out = kd.synthesize(df, "5m")
    assert list(out["minute_count"]) == [5, 2, 5]


# ---------------- 日线起点 ----------------

def test_utc0_4h_and_1d():
    df = minutes("2026-09-01 00:00", "2026-09-03 00:00")
    h4 = kd.synthesize(df, "4h", "utc_0")
    assert [datetime.fromtimestamp(t / 1000, tz=timezone.utc).hour for t in h4["timestamp"][:6]] == [0, 4, 8, 12, 16, 20]
    d1 = kd.synthesize(df, "1d", "utc_0")
    assert list(d1["minute_count"]) == [1440, 1440]


def test_ny17_4h_summer_and_winter():
    summer = kd.synthesize(minutes("2026-07-01 00:00", "2026-07-02 00:00"), "4h", "ny_17")
    winter = kd.synthesize(minutes("2026-01-05 00:00", "2026-01-06 00:00"), "4h", "ny_17")
    hours = lambda df: sorted({datetime.fromtimestamp(t / 1000, tz=timezone.utc).hour for t in df["timestamp"]})
    assert hours(summer) == [1, 5, 9, 13, 17, 21]   # 纽约 21/1/5/9/13/17 点 = UTC +4
    assert hours(winter) == [2, 6, 10, 14, 18, 22]  # 冬令时 UTC +5


def test_ny17_daily_spring_forward_is_23_hours():
    """2026-03-08 美国进入夏令时：3/7 纽约 17:00（UTC 22:00）开始的日线只有 23 小时。"""
    d1 = bars_by_start(kd.synthesize(minutes("2026-03-06 00:00", "2026-03-10 00:00"), "1d", "ny_17"))
    assert d1["03-06 22:00"] == 1440
    assert d1["03-07 22:00"] == 23 * 60
    assert d1["03-08 21:00"] == 1440


def test_ny17_daily_fall_back_is_25_hours():
    """2026-11-01 美国回到冬令时：10/31 纽约 17:00（UTC 21:00）开始的日线有 25 小时。"""
    d1 = bars_by_start(kd.synthesize(minutes("2026-10-30 00:00", "2026-11-03 00:00"), "1d", "ny_17"))
    assert d1["10-30 21:00"] == 1440
    assert d1["10-31 21:00"] == 25 * 60
    assert d1["11-01 22:00"] == 1440


def test_ny17_4h_fall_back_bar_is_5_hours():
    """回拨那天纽约凌晨 1 点出现两次，从第一次 1 点（UTC 05:00）开始的 4h 一直到纽约 5 点（UTC 10:00），共 5 小时。"""
    h4 = bars_by_start(kd.synthesize(minutes("2026-11-01 00:00", "2026-11-01 12:00"), "4h", "ny_17"))
    assert h4["11-01 05:00"] == 300
    assert h4["11-01 10:00"] == 120


def test_lower_timeframes_ignore_day_anchor():
    df = minutes("2026-03-08 00:00", "2026-03-08 12:00")
    for tf in ("1m", "5m", "15m", "30m", "1h"):
        pd.testing.assert_frame_equal(kd.synthesize(df, tf, "utc_0"), kd.synthesize(df, tf, "ny_17"))


def test_bad_timeframe_or_anchor_rejected():
    df = minutes("2026-09-01 00:00", "2026-09-01 00:05")
    with pytest.raises(ValueError):
        kd.synthesize(df, "2h")
    with pytest.raises(ValueError):
        kd.synthesize(df, "1d", "tokyo_9")


# ---------------- 按月读写 ----------------

def test_write_read_roundtrip_and_range(tmp_path):
    aug = minutes("2026-08-31 23:50", "2026-09-01 00:00")
    sep = minutes("2026-09-01 00:00", "2026-09-01 00:10")
    kd.write_month_file(kd.month_file_path(tmp_path, "test_src", "XAUUSD", "2026-08"), aug, "2026-08")
    kd.write_month_file(kd.month_file_path(tmp_path, "test_src", "XAUUSD", "2026-09"), sep, "2026-09")
    got = kd.read_1m_range(tmp_path, "test_src", "XAUUSD", utc_ms("2026-08-31 23:55"), utc_ms("2026-09-01 00:05"))
    assert len(got) == 10
    assert got["timestamp"].iloc[0] == utc_ms("2026-08-31 23:55")
    assert got["timestamp"].iloc[-1] == utc_ms("2026-09-01 00:04")
    assert list(got.columns) == kd.KLINE_COLUMNS


def test_write_refuses_bad_month(tmp_path):
    path = kd.month_file_path(tmp_path, "test_src", "XAUUSD", "2026-09")
    wrong_month = minutes("2026-08-31 23:50", "2026-09-01 00:10")
    with pytest.raises(ValueError, match="不属于"):
        kd.write_month_file(path, wrong_month, "2026-09")
    dup = minutes("2026-09-01 00:00", "2026-09-01 00:05")
    with pytest.raises(ValueError, match="严格递增"):
        kd.write_month_file(path, pd.concat([dup, dup]), "2026-09")
    assert not path.exists()


def test_months_between():
    assert kd.months_between(utc_ms("2026-11-15 00:00"), utc_ms("2027-02-01 00:00")) == \
        ["2026-11", "2026-12", "2027-01"]
    assert kd.month_range("2026-11", "2027-01") == ["2026-11", "2026-12", "2027-01"]


# ---------------- 周线（D74） ----------------

def test_weekly_bucket_monday_and_sunday():
    """2026-10-25 是周日：按周一起算它属于 10-19 那周；按周日起算它是新一周的第一天。"""
    day = kd.TIMEFRAME_MS["1d"]
    sat, sun, mon = utc_ms("2026-10-24 23:59"), utc_ms("2026-10-25 22:00"), utc_ms("2026-10-26 00:00")
    b = lambda ms, ws: int(kd.bucket_open_ms(pd.Series([ms]), "1w", "utc_0", ws).iloc[0])  # noqa: E731
    assert [b(x, "monday") for x in (sat, sun, mon)] == [utc_ms("2026-10-19 00:00")] * 2 + [utc_ms("2026-10-26 00:00")]
    assert [b(x, "sunday") for x in (sat, sun, mon)] == [utc_ms("2026-10-18 00:00")] + [utc_ms("2026-10-25 00:00")] * 2
    assert b(mon, "monday") % day == 0 and b(sun, "sunday") % day == 0
    with pytest.raises(ValueError):
        b(mon, "friday")


def test_synthesize_by_month_equals_one_shot(tmp_path):
    """逐月读、逐月合成再拼接（跨月的那一周、那一天要拼成一根），结果和一次读完再合成完全相同。"""
    for key, start, end in (("2026-09", "2026-09-01 00:00", "2026-10-01 00:00"), ("2026-10", "2026-10-01 00:00", "2026-11-01 00:00")):
        kd.write_month_file(kd.month_file_path(tmp_path, "test_src", "BTCUSDT", key), minutes(start, end), key)
    s, e = utc_ms("2026-09-10 07:13"), utc_ms("2026-10-20 13:00")
    whole = kd.read_1m_range(tmp_path, "test_src", "BTCUSDT", s, e)
    for tf in ("1h", "1d", "1w"):
        for ws in ("monday", "sunday"):
            got = kd.synthesize_by_month(tmp_path, "test_src", "BTCUSDT", s, e, tf, "utc_0", ws)
            pd.testing.assert_frame_equal(got.reset_index(drop=True), kd.synthesize(whole, tf, "utc_0", ws).reset_index(drop=True))
    # 2026-09-28（周一）开始的那一周跨了 9、10 两个月：拼起来是 7 天 × 1440 根
    w = kd.synthesize_by_month(tmp_path, "test_src", "BTCUSDT", s, e, "1w", "utc_0", "monday")
    assert int(w.loc[w["timestamp"] == utc_ms("2026-09-28 00:00"), "minute_count"].iloc[0]) == 7 * 1440
