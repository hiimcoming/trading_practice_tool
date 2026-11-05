# -*- coding: utf-8 -*-
"""
用户数据存储（规格书 5.7、5.10 节）：每个用户一个 SQLite 文件 + 一个首页用的汇总索引。

  local_data/user_databases/{用户名小写}.db   该用户的全部记录：设置、练习轮次、事件日志、交易、练过的片段、报告、画线
  local_data/user_databases/_index.db         首页「最近练习」列表要用的汇总指标（每轮结束时更新，打开首页只读它）

用户名规则：只允许英文字母、数字、下划线，长度 2–20，不区分大小写（文件名一律小写，显示时用第一次输入的写法）。
用户名只用来拼本目录下的文件名，拼之前一定先校验，不进任何命令。
SQLite 的写入「要么全成功、要么全不写」；打开时启用 WAL 模式。后端同一时刻只有一个请求访问数据库（总锁 _DB_LOCK，见下方原因）。
"""

from __future__ import annotations

import json
import re
import sqlite3
import statistics
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

from python_backend import backend_settings

INDEX_DB_NAME = "_index.db"
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_]+$")

USER_SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    start_timeframe TEXT NOT NULL,
    day_anchor TEXT NOT NULL,
    background_bars INTEGER NOT NULL,
    segment_start_ms INTEGER NOT NULL,
    replay_ms INTEGER NOT NULL,           -- 当前回放时刻：开盘早于它的 1m 都已揭开（不含它）
    bars_played INTEGER NOT NULL DEFAULT 0,  -- 已走完的起始周期 K 线根数（按收盘计）
    timeframes_used TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,                  -- active 进行中 / completed 已完成
    end_reason TEXT,                       -- normal / liquidation / latest_data / auto_after_days
    is_replay INTEGER NOT NULL DEFAULT 0,  -- 是否复练（规格书 5.2 节）
    replay_of_segment_id INTEGER,
    pick_mode TEXT,                        -- 片段怎么抽到的：random / fallback_recent / fallback_min_overlap / replay
    pick_overlap REAL,
    state TEXT NOT NULL DEFAULT '{}',      -- 断点续练要恢复的其他状态（持仓、挂单等，第 4 阶段起使用）
    lease_token TEXT,                      -- 当前占用这一轮的浏览器标签页（同一用户只允许一个标签页操作）
    lease_at TEXT,
    initial_total_assets REAL,
    final_total_assets REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    replay_ms INTEGER NOT NULL,
    real_at TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_by_session ON events(session_id, id);
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    lots REAL NOT NULL,
    entry_ms INTEGER NOT NULL,
    exit_ms INTEGER NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL NOT NULL,
    pnl REAL NOT NULL,                     -- 扣除成本后的盈亏
    r_multiple REAL,
    payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS trades_by_session ON trades(session_id);
CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,               -- 实际播放到的终点（不含）
    completed_at TEXT NOT NULL,
    is_replay INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,    -- 「表现较差」标记（规格书 5.2 节复练）
    flag_reason TEXT,
    flagged_at TEXT
);
CREATE INDEX IF NOT EXISTS segments_by_symbol ON segments(symbol, completed_at);
CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS drawings (
    session_id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

INDEX_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,             -- 小写
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_symbol_stats (
    username TEXT NOT NULL,
    symbol TEXT NOT NULL,
    last_practice_at TEXT,
    completed_rounds INTEGER NOT NULL DEFAULT 0,
    total_trades INTEGER NOT NULL DEFAULT 0,
    winning_trades INTEGER NOT NULL DEFAULT 0,
    avg_round_return REAL,
    median_round_return REAL,
    profitable_round_ratio REAL,
    avg_r REAL,
    last10_returns TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (username, symbol)
);
"""


class UsernameError(ValueError):
    """用户名不合规。"""


def now_text() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def load_user_rules() -> dict:
    with open(backend_settings.COMMON_SETTINGS_DIR / "default_settings.json", encoding="utf-8") as f:
        return json.load(f)["user_rules"]


def validate_username(name: str) -> str:
    """校验用户名，返回小写形式（文件名用）。不合规抛 UsernameError（中文原因）。"""
    rules = load_user_rules()
    if not isinstance(name, str) or not name:
        raise UsernameError("请输入用户名")
    if not USERNAME_PATTERN.match(name):
        raise UsernameError("用户名只能包含英文字母、数字和下划线")
    if not rules["username_min_length"] <= len(name) <= rules["username_max_length"]:
        raise UsernameError(f"用户名长度应为 {rules['username_min_length']}–{rules['username_max_length']} 个字符")
    return name.lower()


def databases_dir() -> Path:
    path = backend_settings.USER_DATABASES_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def user_db_path(username: str) -> Path:
    return databases_dir() / f"{validate_username(username)}.db"


def _connect(path: Path, schema: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(schema)
    return conn


# 数据库总锁：后端同一时刻只让一个请求打开、读写、关闭数据库，其他请求排队（每次只要几毫秒）。
# 原因（2026-10-22 实测）：多个请求同时在同一个数据库文件上一边打开一边关闭时，Python 自带的 SQLite 卡死过
# （5 个线程停在打开文件、2 个停在关闭文件，互相等待，后端所有读用户数据的接口都不再返回，只能重启）。
# 用可重入锁：同一个请求里先后（或嵌套）打开用户库和汇总索引库不会自己卡住自己。
_DB_LOCK = threading.RLock()


@contextmanager
def user_db(username: str) -> Iterator[sqlite3.Connection]:
    """打开某用户的数据库（不存在就新建）。with 块正常结束才提交，出错整体回滚。"""
    with _DB_LOCK:
        conn = _connect(user_db_path(username), USER_SCHEMA)
        try:
            with conn:
                yield conn
        finally:
            conn.close()


@contextmanager
def index_db() -> Iterator[sqlite3.Connection]:
    with _DB_LOCK:
        conn = _connect(databases_dir() / INDEX_DB_NAME, INDEX_SCHEMA)
        try:
            with conn:
                yield conn
        finally:
            conn.close()


# ============================================================
# 用户
# ============================================================

def enter_user(name: str) -> dict:
    """输入用户名进入：不存在就新建。返回 {username, display_name, is_new}。"""
    key = validate_username(name)
    with index_db() as idx:
        row = idx.execute("SELECT display_name FROM users WHERE username = ?", (key,)).fetchone()
        if row is None:
            idx.execute("INSERT INTO users(username, display_name, created_at) VALUES (?, ?, ?)", (key, name, now_text()))
    with user_db(key):
        pass
    return {"username": key, "display_name": row["display_name"] if row else name, "is_new": row is None}


def user_exists(name: str) -> bool:
    return user_db_path(name).exists()


def display_name(name: str) -> str:
    key = validate_username(name)
    with index_db() as idx:
        row = idx.execute("SELECT display_name FROM users WHERE username = ?", (key,)).fetchone()
    return row["display_name"] if row else name


def delete_user_history(name: str) -> None:
    """清除该用户的全部练习历史（含防重复记录）：删除他的数据库文件和首页汇总。用户名本身保留。"""
    key = validate_username(name)
    base = user_db_path(key)
    for suffix in ("", "-wal", "-shm"):
        Path(f"{base}{suffix}").unlink(missing_ok=True)
    with index_db() as idx:
        idx.execute("DELETE FROM user_symbol_stats WHERE username = ?", (key,))


def get_settings(name: str) -> dict:
    with user_db(name) as db:
        return {r["key"]: json.loads(r["value"]) for r in db.execute("SELECT key, value FROM settings")}


def utc_offset_hours(name: str) -> int:
    """用户在设置页选的显示时区：只有 UTC（0）和 UTC+8（8）两种。"""
    return 8 if get_settings(name).get("utc_offset_hours") == 8 else 0


def local_date(utc_text: str | None, offset_hours: int) -> str | None:
    """服务器的 UTC 时间文字（YYYY-MM-DD HH:MM:SS）→ 用户时区的日期 YYYY-MM-DD。"""
    if not utc_text:
        return None
    try:
        return (datetime.strptime(utc_text, "%Y-%m-%d %H:%M:%S") + timedelta(hours=offset_hours)).strftime("%Y-%m-%d")
    except ValueError:
        return None


def put_settings(name: str, values: dict) -> dict:
    with user_db(name) as db:
        for k, v in values.items():
            db.execute("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                       (k, json.dumps(v, ensure_ascii=False)))
    return get_settings(name)


# ============================================================
# 首页汇总
# ============================================================

def refresh_user_symbol_stats(name: str, symbol: str) -> None:
    """
    重新计算某用户某品种的首页指标并写入汇总索引（每轮结束时调用；规格书 15.1 节：预先算好，打开首页只读）。
    只计已完成、非复练的轮次（规格书 5.2 节：用户列表的指标只计首次练习）。
    """
    key = validate_username(name)
    with user_db(key) as db:
        rounds = db.execute(
            "SELECT id, finished_at, initial_total_assets, final_total_assets FROM sessions "
            "WHERE symbol = ? AND status = 'completed' AND is_replay = 0 ORDER BY finished_at", (symbol,)).fetchall()
        last = db.execute("SELECT MAX(updated_at) AS t FROM sessions WHERE symbol = ?", (symbol,)).fetchone()["t"]
        ids = [r["id"] for r in rounds]
        trades = db.execute(f"SELECT pnl, r_multiple FROM trades WHERE session_id IN ({','.join('?' * len(ids))})",
                            ids).fetchall() if ids else []
    returns = [(r["final_total_assets"] - r["initial_total_assets"]) / r["initial_total_assets"]
               for r in rounds if r["initial_total_assets"] and r["final_total_assets"] is not None]
    rs = [t["r_multiple"] for t in trades if t["r_multiple"] is not None]
    stats = {
        "last_practice_at": last,
        "completed_rounds": len(rounds),
        "total_trades": len(trades),
        "winning_trades": sum(1 for t in trades if t["pnl"] > 0),
        "avg_round_return": statistics.fmean(returns) if returns else None,
        "median_round_return": statistics.median(returns) if returns else None,
        "profitable_round_ratio": (sum(1 for x in returns if x > 0) / len(returns)) if returns else None,
        "avg_r": statistics.fmean(rs) if rs else None,
        "last10_returns": json.dumps(returns[-10:]),
    }
    with index_db() as idx:
        idx.execute(
            "INSERT INTO user_symbol_stats(username, symbol, last_practice_at, completed_rounds, total_trades, winning_trades,"
            " avg_round_return, median_round_return, profitable_round_ratio, avg_r, last10_returns)"
            " VALUES (:u, :s, :last_practice_at, :completed_rounds, :total_trades, :winning_trades, :avg_round_return,"
            " :median_round_return, :profitable_round_ratio, :avg_r, :last10_returns)"
            " ON CONFLICT(username, symbol) DO UPDATE SET last_practice_at = excluded.last_practice_at,"
            " completed_rounds = excluded.completed_rounds, total_trades = excluded.total_trades,"
            " winning_trades = excluded.winning_trades, avg_round_return = excluded.avg_round_return,"
            " median_round_return = excluded.median_round_return, profitable_round_ratio = excluded.profitable_round_ratio,"
            " avg_r = excluded.avg_r, last10_returns = excluded.last10_returns",
            {"u": key, "s": symbol, **stats})


def recent_users(symbol: str, limit: int) -> list[dict]:
    """某品种的「最近练习」用户列表（按最后练习时间倒序）。"""
    with index_db() as idx:
        rows = idx.execute(
            "SELECT s.*, u.display_name FROM user_symbol_stats s JOIN users u ON u.username = s.username "
            "WHERE s.symbol = ? AND s.last_practice_at IS NOT NULL ORDER BY s.last_practice_at DESC LIMIT ?",
            (symbol, limit)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["last10_returns"] = json.loads(d["last10_returns"])
        d["win_rate"] = (d["winning_trades"] / d["total_trades"]) if d["total_trades"] else None
        out.append(d)
    return out
