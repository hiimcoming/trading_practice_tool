# -*- coding: utf-8 -*-
"""
抽片段、防重复、复练（规格书 5.2 节、D24、D38、D49）。

候选起点：
  - 起点 = 起始周期某根 K 线的开盘时刻（D49：对齐到起始周期，开局最后一根是完整 K 线）；
  - 起点之前至少有「背景根数」根起始周期 K 线，起点之后至少还有 300 根；
  - 起点后 300 根之内，相邻两根 1m 的间隔不超过品种档案的 max_normal_gap_minutes（周末、节假日以内算正常，
    更长的视为数据缺口，不能出现在练习片段里）；不限时段、不避开节假日。
片段 = 起点 → 起点后第 300 根的收盘（用于判断重叠；完成后按实际播到的终点记录）。

抽取（按用户分别计算，重叠按时间算、不管周期）：
  1. 复练：该用户在该品种已完成至少 5 轮首次练习、且有「表现较差」标记的片段时，有 35% 概率抽最早标记的那个，
     起点在原起点前后随机挪最多 50 根起始周期 K 线（找最近的合格起点）；复练不受重叠上限限制；
  2. 随机抽候选，和每个已完成片段的重叠比例（交集时长 ÷ 本片段时长）都不超过 20% 就选它，最多抽 500 次；
  3. 退路一：只要求和最近 6 个已完成片段完全不重叠；
  4. 退路二：选抽到的候选里「最大重叠比例」最小的那个。

性能：候选起点表（每根起始周期 K 线的开盘时刻 + 是否合格）按 品种 × 周期 × 日线起点 算一次，存成小文件缓存；
数据说明卡更新后自动重算。1 核 1 GB 的服务器上也只占几 MB。

可练轮数（D86）：用同一张候选起点表，数出「按当前周期和背景根数，最多能放几个互不重叠的片段」，
连同可抽数据的月数，在用户页开局前显示，提醒数据少的品种 / 大周期会抽到练过的行情。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from python_backend import backend_settings
from python_backend.market_data_downloader import download_common
from python_backend.trading_rules import kline_data

CACHE_DIR_NAME = "segment_index_cache"


def load_segment_rules() -> dict:
    with open(backend_settings.COMMON_SETTINGS_DIR / "default_settings.json", encoding="utf-8") as f:
        return json.load(f)["segment_rules"]


# ============================================================
# 候选起点表
# ============================================================

@dataclass
class BarIndex:
    """某品种某周期全部 K 线的开盘时刻，以及每根作为起点是否合格（不含背景根数条件，那个按请求再判断）。"""
    opens: np.ndarray        # int64，UTC 毫秒，递增
    gap_ok_300: np.ndarray   # bool：从这根起 300 根之内没有数据缺口，且后面确实还有 300 根
    tf_ms: int


def _all_1m_timestamps(source: str, symbol: str, first_month: str) -> np.ndarray:
    """可抽练习片段的全部 1m 时刻：只用 first_month（品种档案的 history_start）及以后的月份——
    更早的月份（chart_history_start 起，D74）只当图表背景，不参与抽片段。"""
    meta = download_common.read_meta(source, symbol)
    months = sorted(k for k, v in meta.get("months", {}).items() if v.get("status") in ("complete", "warnings") and k >= first_month)
    parts = []
    for key in months:
        path = kline_data.month_file_path(backend_settings.KLINE_DIR, source, symbol, key)
        if path.exists():
            parts.append(pd.read_parquet(path, columns=["timestamp"])["timestamp"].to_numpy())
    return np.concatenate(parts) if parts else np.array([], dtype="int64")


def build_bar_index(ts_1m: np.ndarray, timeframe: str, day_anchor: str, max_gap_ms: int, completion_bars: int) -> BarIndex:
    """由全部 1m 时间戳算出起始周期的 K 线开盘表和合格标记（纯计算，便于测试）。"""
    tf_ms = kline_data.TIMEFRAME_MS[timeframe]
    ts = np.sort(ts_1m.astype("int64"))
    buckets = kline_data.bucket_open_ms(pd.Series(ts), timeframe, day_anchor).to_numpy()
    opens, first_idx = np.unique(buckets, return_index=True)
    n = len(opens)
    ok = np.zeros(n, dtype=bool)
    if n > completion_bars:
        # 每根 1m 与下一根的间隔超过上限 → 记为缺口；用累计计数判断某区间内有没有缺口
        bad = np.zeros(len(ts), dtype="int64")
        if len(ts) > 1:
            bad[:-1] = (np.diff(ts) > max_gap_ms).astype("int64")
        bad_cum = np.concatenate([[0], np.cumsum(bad)])
        # 第 i 根起 300 根：1m 范围是 first_idx[i] .. first_idx[i+300]-1（含最后一根内部，不含它和下一根之间）
        last_bar_end_idx = np.append(first_idx[1:], len(ts))  # 每根 K 线最后一根 1m 的下一个位置
        i = np.arange(n - completion_bars + 1)
        start_pos = first_idx[i]
        end_pos = last_bar_end_idx[i + completion_bars - 1] - 1  # 第 300 根的最后一根 1m（含）
        gaps_inside = bad_cum[end_pos] - bad_cum[start_pos]
        ok[i] = gaps_inside == 0
    return BarIndex(opens=opens, gap_ok_300=ok, tf_ms=tf_ms)


def _cache_path(symbol: str, timeframe: str, day_anchor: str) -> Path:
    return backend_settings.LOCAL_DATA_DIR / CACHE_DIR_NAME / f"{symbol}_{timeframe}_{day_anchor}.npz"


def get_bar_index(symbol: str, timeframe: str, day_anchor: str) -> BarIndex:
    """取候选起点表：有缓存且数据、完成根数、缺口上限都没变就直接读，否则重算并写缓存。"""
    spec = download_common.load_market_specs()[symbol]
    rules = load_segment_rules()
    # 数据更新时间 + 抽片段起点：两者有一个变了缓存就作废
    stamp = download_common.read_meta(spec["data_source"], symbol).get("updated_at_utc", "") + "|" + spec["history_start"]
    path = _cache_path(symbol, timeframe, day_anchor)
    if path.exists():
        try:
            z = np.load(path, allow_pickle=False)
            if (str(z["stamp"]) == stamp and int(z["completion_bars"]) == rules["completion_bars"]
                    and int(z["max_gap_minutes"]) == spec["max_normal_gap_minutes"]):
                return BarIndex(opens=z["opens"], gap_ok_300=z["ok"], tf_ms=kline_data.TIMEFRAME_MS[timeframe])
        except (OSError, ValueError, KeyError):
            pass
    idx = build_bar_index(_all_1m_timestamps(spec["data_source"], symbol, spec["history_start"]), timeframe, day_anchor,
                          spec["max_normal_gap_minutes"] * kline_data.MINUTE_MS, rules["completion_bars"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.stem + ".tmp.npz")
    np.savez(tmp, opens=idx.opens, ok=idx.gap_ok_300, stamp=np.array(stamp), completion_bars=np.array(rules["completion_bars"]),
             max_gap_minutes=np.array(spec["max_normal_gap_minutes"]))
    tmp.replace(path)
    return idx


# ============================================================
# 重叠与抽取
# ============================================================

def overlap_ratios(start: int, end: int, seg_starts: np.ndarray, seg_ends: np.ndarray) -> np.ndarray:
    """候选片段 [start, end) 与每个已完成片段的重叠比例（交集时长 ÷ 候选片段时长）。"""
    if len(seg_starts) == 0:
        return np.zeros(0)
    inter = np.clip(np.minimum(end, seg_ends) - np.maximum(start, seg_starts), 0, None)
    return inter / float(end - start)


@dataclass
class PickResult:
    start_ms: int
    nominal_end_ms: int      # 起点后第 300 根的收盘
    mode: str                # random / fallback_recent / fallback_min_overlap / replay
    max_overlap: float
    replay_of_segment_id: int | None = None


def segment_end(idx: BarIndex, i: int, completion_bars: int) -> int:
    return int(idx.opens[i + completion_bars - 1]) + idx.tf_ms


def candidate_positions(idx: BarIndex, background_bars: int) -> np.ndarray:
    """合格起点的位置。起点前要有「背景根数 + 一天」根 K 线：开局时起点所在日线的 1m 会另外发给浏览器，
    背景 K 线接在它前面，多留一天才保证背景根数够。"""
    day_bars = -(-kline_data.TIMEFRAME_MS["1d"] // idx.tf_ms) + 1
    pos = np.nonzero(idx.gap_ok_300)[0]
    return pos[pos >= background_bars + day_bars]


def pick_segment(idx: BarIndex, background_bars: int, completed: list[dict], flagged: list[dict],
                 first_time_rounds: int, rules: dict, rng: np.random.Generator) -> PickResult:
    """
    completed：该用户该品种全部已完成片段 [{start_ms, end_ms}]，按完成时间先后排序；
    flagged：带「表现较差」标记的片段 [{id, start_ms}]，按标记时间先后排序。
    """
    cands = candidate_positions(idx, background_bars)
    if len(cands) == 0:
        raise ValueError("数据不够：找不到满足「背景根数 + 300 根且中间没有数据缺口」的起点")
    n_bars = rules["completion_bars"]

    # 1. 复练
    if flagged and first_time_rounds >= rules["replay_min_completed_rounds"] and rng.random() < rules["replay_flagged_probability"]:
        target = flagged[0]
        base = int(np.searchsorted(idx.opens, target["start_ms"]))
        shift = int(rng.integers(-rules["replay_shift_bars"], rules["replay_shift_bars"] + 1))
        want = base + shift
        i = int(cands[np.argmin(np.abs(cands - want))])
        return PickResult(int(idx.opens[i]), segment_end(idx, i, n_bars), "replay", 0.0, target["id"])

    starts = np.array([s["start_ms"] for s in completed], dtype="int64")
    ends = np.array([s["end_ms"] for s in completed], dtype="int64")
    tried: list[tuple[float, int]] = []

    # 2. 正常随机：和每个已完成片段的重叠都不超过上限
    for i in rng.choice(cands, size=min(rules["max_random_draws"], len(cands)), replace=len(cands) < rules["max_random_draws"]):
        i = int(i)
        s, e = int(idx.opens[i]), segment_end(idx, i, n_bars)
        ratios = overlap_ratios(s, e, starts, ends)
        worst = float(ratios.max()) if len(ratios) else 0.0
        if worst <= rules["max_overlap_ratio"]:
            return PickResult(s, e, "random", worst)
        tried.append((worst, i))

    # 3. 退路一：只要求不和最近 6 个已完成片段重叠
    recent = rules["fallback_recent_segments"]
    r_starts, r_ends = starts[-recent:], ends[-recent:]
    for i in rng.choice(cands, size=min(rules["max_random_draws"], len(cands)), replace=len(cands) < rules["max_random_draws"]):
        i = int(i)
        s, e = int(idx.opens[i]), segment_end(idx, i, n_bars)
        if not (overlap_ratios(s, e, r_starts, r_ends) > 0).any():
            return PickResult(s, e, "fallback_recent", float(overlap_ratios(s, e, starts, ends).max()))
        tried.append((float(overlap_ratios(s, e, starts, ends).max()), i))

    # 4. 退路二：重叠最少的那个
    worst, i = min(tried)
    return PickResult(int(idx.opens[i]), segment_end(idx, i, n_bars), "fallback_min_overlap", worst)


def bars_completed(idx: BarIndex, start_ms: int, replay_ms: int) -> int:
    """从起点到当前回放时刻，已经走完（收盘）的起始周期 K 线根数；只计数据里实际存在的 K 线（规格书 15.1 节）。"""
    lo = int(np.searchsorted(idx.opens, start_ms))
    hi = int(np.searchsorted(idx.opens, replay_ms - idx.tf_ms, side="right"))
    return max(0, hi - lo)


# ============================================================
# 可练轮数与可抽数据长度（D86：用户页选品种、周期时显示，提醒数据少会抽到重复行情）
# ============================================================

def max_disjoint_rounds(idx: BarIndex, background_bars: int, completion_bars: int) -> int:
    """最多能抽出几个互不重叠的片段：从最早的合格起点开始，每轮结束后找下一个合格起点，数一共能放几轮。
    （每个片段都是 300 根，先结束的先选就是最多的放法；实际抽片段允许重叠 20%，能练的会比这略多。）"""
    cands = candidate_positions(idx, background_bars)
    if len(cands) == 0:
        return 0
    starts = idx.opens[cands]
    ends = idx.opens[cands + completion_bars - 1] + idx.tf_ms
    rounds, i = 0, 0
    while i < len(cands):
        rounds += 1
        i = int(np.searchsorted(starts, ends[i], side="left"))
    return rounds


def _next_month(key: str) -> str:
    y, m = int(key[:4]), int(key[5:7])
    return f"{y + m // 12}-{m % 12 + 1:02d}"


def usable_months(source: str, symbol: str, first_month: str) -> dict:
    """可抽片段的月份（history_start 起、状态完整或有疑问）：首尾月份、个数，以及首尾之间缺了哪几个月。"""
    meta = download_common.read_meta(source, symbol)
    ok = sorted(k for k, v in meta.get("months", {}).items() if v.get("status") in ("complete", "warnings") and k >= first_month)
    if not ok:
        return {"months": 0, "first_month": None, "last_month": None, "missing_months": []}
    missing, key, have = [], ok[0], set(ok)
    while key < ok[-1]:
        if key not in have:
            missing.append(key)
        key = _next_month(key)
    return {"months": len(ok), "first_month": ok[0], "last_month": ok[-1], "missing_months": missing}


def practice_capacity(symbol: str, timeframe: str, day_anchor: str, background_bars: int) -> dict:
    """某品种、起始周期、背景根数下：可抽数据有几个月，以及约可练几轮不重复。"""
    spec = download_common.load_market_specs()[symbol]
    out = usable_months(spec["data_source"], symbol, spec["history_start"])
    idx = get_bar_index(symbol, timeframe, day_anchor)
    out["rounds"] = max_disjoint_rounds(idx, background_bars, load_segment_rules()["completion_bars"])
    return out
