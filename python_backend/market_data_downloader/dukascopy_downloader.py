# -*- coding: utf-8 -*-
"""
Dukascopy 1 分钟 K 线下载（数据来源名：dukascopy），当前用于现货黄金 XAUUSD：一次取一个完整的 UTC 自然月。

背景：Dukascopy 只提供按天打包的 1 分钟 K 线（.bi5 格式，LZMA 压缩），价格是整数，除以 price_divisor 才是真实价格。
只下买价（BID）：Exness 点差按规格书 D46 固定 0.25，不需要卖价。

来源：CryptoTrade/data_downloader/dukascopy_downloader.py，2026-10-20 复制后改造：
  - 保留：网址规则（月份从 0 开始数）、.bi5 解码、按天临时文件断点续传、跳过周六、请求间隔、耐心的重试参数、删假 K 线；
  - 改为：1m 就是正式数据（不再合成 5m–4h 后删掉 1m）；按月返回数据，由 monthly_update_and_check 负责检查和写入；
  - 临时文件改存 Parquet，放在 local_data/kline/dukascopy/{品种}/_tmp_1m/，该月写入正式文件后再删。

本模块只负责「取」，不写正式文件。
"""

from __future__ import annotations

import logging
import lzma
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from python_backend import backend_settings
from python_backend.market_data_downloader import download_common
from python_backend.trading_rules import kline_data

SOURCE = "dukascopy"
DATAFEED_BASE_URL = "https://datafeed.dukascopy.com/datafeed"
PRICE_SIDE = "BID"
REQUEST_INTERVAL_SEC = 1.0  # Dukascopy 有频率限制，太快会返回 429/503
# Dukascopy 服务器经常很慢、偶发 503，重试要更有耐心
RETRY = {"max_attempts": 12, "base_wait_sec": 5, "max_wait_sec": 120, "timeout_sec": 90}
# .bi5 蜡烛记录：距当天 0 点的秒数、开、收、低、高（整数价格）、成交量（大端字节序）
BI5_DTYPE = np.dtype([("sec", ">u4"), ("open", ">u4"), ("close", ">u4"),
                      ("low", ">u4"), ("high", ">u4"), ("volume", ">f4")])


def day_url(symbol: str, day: date) -> str:
    """某天 1 分钟买价 K 线文件的网址（Dukascopy 的月份从 0 开始数：9 月写作 08）。"""
    return (f"{DATAFEED_BASE_URL}/{symbol}/{day.year}/{day.month - 1:02d}/"
            f"{day.day:02d}/{PRICE_SIDE}_candles_min_1.bi5")


def decode_bi5(content: bytes, day: date, divisor: int) -> pd.DataFrame:
    """解码 .bi5 内容为 1 分钟 K 线表（价格已换算成真实价格）。空内容返回空表。"""
    if not content:
        return kline_data.empty_1m_frame()
    arr = np.frombuffer(lzma.decompress(content), dtype=BI5_DTYPE)
    day_start_ms = int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1000)
    return pd.DataFrame({
        "timestamp": day_start_ms + arr["sec"].astype("int64") * 1000,
        "open": arr["open"] / divisor,
        "high": arr["high"] / divisor,
        "low": arr["low"] / divisor,
        "close": arr["close"] / divisor,
        "volume": arr["volume"].astype("float64"),
    })


def tmp_dir(symbol: str) -> Path:
    return kline_data.symbol_dir(backend_settings.KLINE_DIR, SOURCE, symbol) / "_tmp_1m"


def days_of_month(month_key: str, skip_saturday: bool) -> list[date]:
    year, month = kline_data.parse_month_key(month_key)
    d, days = date(year, month, 1), []
    while d.month == month:
        if not (skip_saturday and d.weekday() == 5):
            days.append(d)
        d += timedelta(days=1)
    return days


def get_day(session, spec: dict, day: date, logger: logging.Logger) -> tuple[pd.DataFrame, bool]:
    """取某天的 1m：已有临时文件就直接读（断点续传），否则下载并存临时文件。返回 (数据, 是否来自临时文件)。"""
    symbol = spec["data_symbol"]
    path = tmp_dir(symbol) / f"{day.isoformat()}.parquet"
    if path.exists():
        return pd.read_parquet(path), True
    content = download_common.http_get(session, day_url(symbol, day), RETRY, logger)
    df = decode_bi5(content or b"", day, spec["price_divisor"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".parquet.tmp")
    df.to_parquet(tmp, index=False)
    os.replace(tmp, path)
    time.sleep(REQUEST_INTERVAL_SEC)
    return df, False


def fetch_month(session, spec: dict, month_key: str, logger: logging.Logger) -> tuple[pd.DataFrame, dict]:
    """取一个完整月份的 1m（已删假 K 线）。返回 (数据, 附加信息)。"""
    days = days_of_month(month_key, spec.get("skip_saturday", False))
    parts, reused = [], 0
    for i, d in enumerate(days, 1):
        df_day, from_tmp = get_day(session, spec, d, logger)
        parts.append(df_day)
        reused += from_tmp
        if i % 10 == 0:
            logger.info(f"[{spec['data_symbol']} {month_key}] 已取 {i}/{len(days)} 天")
    df = pd.concat([p for p in parts if not p.empty], ignore_index=True) if any(not p.empty for p in parts) \
        else kline_data.empty_1m_frame()
    df, dropped = download_common.drop_fake_bars(df, f"{spec['data_symbol']} {month_key}", logger)
    return df, {"fake_bars_dropped": dropped, "days_requested": len(days), "days_from_resume_files": reused}


def cleanup_month_tmp(spec: dict, month_key: str) -> None:
    """该月正式文件写入并检查通过后，删掉它的按天临时文件。"""
    for d in days_of_month(month_key, skip_saturday=False):
        (tmp_dir(spec["data_symbol"]) / f"{d.isoformat()}.parquet").unlink(missing_ok=True)
    folder = tmp_dir(spec["data_symbol"])
    if folder.exists() and not any(folder.iterdir()):
        folder.rmdir()
