# -*- coding: utf-8 -*-
"""
下载器公共工具（Dukascopy、币安两个下载器共用；不含任何某个来源专属的逻辑）。

来源：CryptoTrade/data_downloader/common.py，2026-10-20 复制后改造：
  - 保留：日志（控制台 + 文件）、失败重试（等待逐次翻倍）、访问被拒立即停止、去假 K 线、缺口统计；
  - 去掉：整份 CSV 的读写和安全截止（本项目按月存 Parquet、只下完整月份，见 kline_data 和 monthly_update_and_check）；
  - 新增：品种档案读取、数据说明卡（meta.json，按月记录行数、校验值、检查结果）、文件校验值、降低运行优先级。

依赖：只依赖 trading_rules 和 backend_settings（CLAUDE.md 架构铁律 1）。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

from python_backend import backend_settings
from python_backend.trading_rules import kline_data

META_FILE_NAME = "meta.json"


# ============================================================
# 1. 日志
# ============================================================

def setup_logger(name: str) -> logging.Logger:
    """建立同时写控制台和日志文件（local_data/logs/download_YYYYMMDD.log）的 logger。"""
    logger = logging.getLogger(f"downloader.{name}")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    logger.propagate = False
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%H:%M:%S")
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    logger.addHandler(console)
    try:
        backend_settings.LOG_DIR.mkdir(parents=True, exist_ok=True)
        log_path = backend_settings.LOG_DIR / f"download_{datetime.now(timezone.utc):%Y%m%d}.log"
        file_handler = logging.FileHandler(log_path, encoding="utf-8")
        file_handler.setFormatter(fmt)
        logger.addHandler(file_handler)
    except OSError as e:
        logger.warning(f"[日志] 无法创建日志文件，只输出到控制台：{e}")
    return logger


def lower_process_priority(logger: logging.Logger) -> None:
    """把下载进程设为低优先级（Mac / Linux），不和网站后端抢 CPU（规格书 3.3 节）。"""
    if hasattr(os, "nice"):
        try:
            os.nice(10)
        except OSError as e:
            logger.warning(f"[优先级] 无法降低运行优先级：{e}")


# ============================================================
# 2. 网络请求
# ============================================================

class AccessDeniedError(RuntimeError):
    """服务器拒绝访问（HTTP 403/451，如地区限制）。重试没有意义，下载器应整体停止。"""


def make_session() -> requests.Session:
    """建立带浏览器标识的会话（部分数据源拒绝无标识的请求）。"""
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0 (trading practice tool data downloader)"})
    return session


def http_get(session: requests.Session, url: str, retry_cfg: dict, logger: logging.Logger,
             params: dict | None = None) -> bytes | None:
    """
    下载一个网址的内容。返回内容字节；服务器明确回答 404（没有这个文件）时返回 None。
    多次重试仍失败时抛出 RuntimeError；访问被拒（403/451）立即抛出 AccessDeniedError。
    """
    max_attempts = retry_cfg["max_attempts"]
    for attempt in range(1, max_attempts + 1):
        try:
            resp = session.get(url, params=params, timeout=retry_cfg["timeout_sec"])
            if resp.status_code == 404:
                return None
            if resp.status_code == 200:
                return resp.content
            if resp.status_code in (403, 451):
                raise AccessDeniedError(f"访问被拒 HTTP {resp.status_code}：{resp.text[:120]!r}")
            reason = f"HTTP {resp.status_code} {resp.text[:120]!r}"
        except requests.exceptions.RequestException as e:
            reason = f"网络异常 {type(e).__name__}: {e}"
        wait = min(retry_cfg["base_wait_sec"] * 2 ** (attempt - 1), retry_cfg.get("max_wait_sec", 300))
        logger.warning(f"[重试] 第 {attempt}/{max_attempts} 次失败（{reason}），{wait} 秒后重试：{url}")
        time.sleep(wait)
    raise RuntimeError(f"多次重试仍失败，放弃：{url}")


# ============================================================
# 3. 清洗与缺口
# ============================================================

def drop_fake_bars(df: pd.DataFrame, label: str, logger: logging.Logger) -> tuple[pd.DataFrame, int]:
    """
    删除假 K 线：成交量为 0 且开高低收全相同（休市、停机或无成交时数据源塞入的占位 K 线）。
    成交量为 0 但价格有变动的，保留并报警。返回 (清洗后的数据, 删除的根数)。
    """
    if df.empty:
        return df, 0
    zero_vol = df["volume"] == 0
    flat = (df["open"] == df["high"]) & (df["high"] == df["low"]) & (df["low"] == df["close"])
    odd = int((zero_vol & ~flat).sum())
    if odd:
        logger.warning(f"[{label}] 发现 {odd} 根「成交量为 0 但价格有变动」的 K 线，已保留，请留意")
    fake = zero_vol & flat
    return df[~fake].reset_index(drop=True), int(fake.sum())


def find_gaps(ts_ms: pd.Series, start_ms: int, end_ms: int) -> pd.DataFrame:
    """
    找出 [start_ms, end_ms) 内 1m 数据的全部缺口（含月初、月末两头）。
    返回表：gap_start（缺口里第一根缺失 K 线的开盘时刻，UTC）、gap_end（缺口后第一根存在的 K 线，或区间终点）、
    missing_minutes（缺了几分钟）。
    """
    ts = pd.Series(ts_ms, dtype="int64").sort_values().to_numpy()
    bounds_before = [start_ms - kline_data.MINUTE_MS, *ts]
    bounds_after = [*ts, end_ms]
    rows = []
    for prev, nxt in zip(bounds_before, bounds_after):
        missing = (nxt - prev) // kline_data.MINUTE_MS - 1
        if missing > 0:
            rows.append((prev + kline_data.MINUTE_MS, nxt, int(missing)))
    gaps = pd.DataFrame(rows, columns=["gap_start", "gap_end", "missing_minutes"])
    for c in ("gap_start", "gap_end"):
        gaps[c] = pd.to_datetime(gaps[c], unit="ms", utc=True)
    return gaps


# ============================================================
# 4. 品种档案与数据说明卡
# ============================================================

def load_market_specs() -> dict:
    """读 common_settings/market_specs.json，返回 {品种: 档案}。"""
    with open(backend_settings.MARKET_SPECS_FILE, encoding="utf-8") as f:
        return json.load(f)["markets"]


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def meta_path(source: str, symbol: str) -> Path:
    return kline_data.symbol_dir(backend_settings.KLINE_DIR, source, symbol) / META_FILE_NAME


def read_meta(source: str, symbol: str) -> dict:
    """读品种的数据说明卡；不存在或读不了返回空白说明卡。"""
    path = meta_path(source, symbol)
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    return {"source": source, "symbol": symbol, "timezone": "UTC+0",
            "time_column_meaning": "K 线开盘时刻（UTC 毫秒）", "months": {}}


def write_meta(meta: dict) -> None:
    """写数据说明卡（先写临时文件再替换）。会重新汇总首末根时间和总行数。"""
    months = meta.get("months", {})
    done = sorted(k for k, v in months.items() if v.get("status") in ("complete", "warnings"))
    meta["months_ok"] = len(done)
    meta["total_rows"] = int(sum(months[k]["rows"] for k in done))
    meta["first_bar_utc"] = months[done[0]]["first_bar_utc"] if done else None
    meta["last_bar_utc"] = months[done[-1]]["last_bar_utc"] if done else None
    meta["updated_at_utc"] = now_utc_text()
    path = meta_path(meta["source"], meta["symbol"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2, sort_keys=False), encoding="utf-8")
    os.replace(tmp, path)


def now_utc_text() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def fmt_ms(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
