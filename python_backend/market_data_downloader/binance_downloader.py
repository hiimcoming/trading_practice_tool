# -*- coding: utf-8 -*-
"""
币安 U 本位永续合约 1 分钟 K 线下载（数据来源名：binance_um）：一次取一个完整的 UTC 自然月。

来源：CryptoTrade/data_downloader/binance_downloader.py，2026-10-20 复制后改造：
  - 保留：只用行情接口 /fapi/v1/klines 分页取数（不用 data.binance.vision：CryptoTrade 2026-10-04 实测
    其个别按月压缩包不完整，用户当时决定只用接口）、请求间隔、访问被拒立即停止、删假 K 线；
  - 改为：只取 1m、按月返回数据，由 monthly_update_and_check 负责检查和写入；
  - 去掉：多周期、整份 CSV 存储、安全截止（只下载已经结束的完整月份，不存在「正在走的那根」）。

本模块只负责「取」，不写文件。
"""

from __future__ import annotations

import json
import logging
import time

import pandas as pd

from python_backend.market_data_downloader import download_common
from python_backend.trading_rules import kline_data

SOURCE = "binance_um"
KLINES_URL = "https://fapi.binance.com/fapi/v1/klines"
LIMIT_PER_REQUEST = 1500           # 币安每次最多 1500 根
REQUEST_INTERVAL_SEC = 0.2         # 每次请求间隔，避免过快
RETRY = {"max_attempts": 6, "base_wait_sec": 2, "timeout_sec": 30, "max_wait_sec": 300}
# 币安接口返回的 K 线字段顺序
RAW_FIELDS = ["open_time", "open", "high", "low", "close", "volume", "close_time", "quote_volume",
              "count", "taker_buy_volume", "taker_buy_quote_volume", "ignore"]


def raw_to_standard(rows: list) -> pd.DataFrame:
    """把接口原始数据转成项目统一的 1m 格式。"""
    if not rows:
        return kline_data.empty_1m_frame()
    raw = pd.DataFrame(rows, columns=RAW_FIELDS)
    return pd.DataFrame({
        "timestamp": pd.to_numeric(raw["open_time"]).astype("int64"),
        "open": pd.to_numeric(raw["open"]).astype("float64"),
        "high": pd.to_numeric(raw["high"]).astype("float64"),
        "low": pd.to_numeric(raw["low"]).astype("float64"),
        "close": pd.to_numeric(raw["close"]).astype("float64"),
        "volume": pd.to_numeric(raw["volume"]).astype("float64"),
    })


def fetch_klines(session, symbol: str, interval: str, start_ms: int, end_ms: int,
                 logger: logging.Logger) -> pd.DataFrame:
    """分页取开盘时刻在 [start_ms, end_ms) 内的 K 线（interval 为币安周期写法，如 1m、4h、1d）。"""
    parts, cursor = [], start_ms
    step_ms = kline_data.TIMEFRAME_MS[interval]
    while cursor < end_ms:
        params = {"symbol": symbol, "interval": interval, "startTime": cursor, "endTime": end_ms - 1,
                  "limit": LIMIT_PER_REQUEST}
        content = download_common.http_get(session, KLINES_URL, RETRY, logger, params=params)
        rows = json.loads(content) if content else []
        if not rows:
            break
        part = raw_to_standard(rows)
        parts.append(part)
        cursor = int(part["timestamp"].max()) + step_ms
        time.sleep(REQUEST_INTERVAL_SEC)
    if not parts:
        return kline_data.empty_1m_frame()
    df = pd.concat(parts, ignore_index=True).drop_duplicates("timestamp")
    return df[(df["timestamp"] >= start_ms) & (df["timestamp"] < end_ms)].reset_index(drop=True)


def fetch_month(session, spec: dict, month_key: str, logger: logging.Logger) -> tuple[pd.DataFrame, dict]:
    """取一个完整月份的 1m（已删假 K 线）。返回 (数据, 附加信息)。"""
    start_ms, end_ms = kline_data.month_bounds_ms(month_key)
    symbol = spec["data_symbol"]
    df = fetch_klines(session, symbol, "1m", start_ms, end_ms, logger)
    df, dropped = download_common.drop_fake_bars(df, f"{symbol} {month_key}", logger)
    return df, {"fake_bars_dropped": dropped}
