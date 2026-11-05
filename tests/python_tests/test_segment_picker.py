# -*- coding: utf-8 -*-
"""
片段抽取规则的测试（规格书 5.2 节）：数据缺口、背景根数、20% 重叠上限、两种退路、复练、已走根数。
全部用人造的时间戳，不碰真实数据。
"""

import numpy as np

from python_backend.trading_rules import kline_data as kd
from python_backend.website_server import segment_picker as sp

RULES = {"completion_bars": 300, "max_overlap_ratio": 0.2, "max_random_draws": 500, "fallback_recent_segments": 6,
         "replay_flagged_probability": 0.35, "replay_min_completed_rounds": 5, "replay_shift_bars": 50}
M = kd.MINUTE_MS
T0 = 1_780_000_000_000 // (15 * M) * (15 * M)  # 对齐到 15 分钟


def continuous(n_minutes: int, start: int = T0) -> np.ndarray:
    return np.arange(start, start + n_minutes * M, M, dtype="int64")


def index_15m(ts: np.ndarray, max_gap_minutes: int = 120) -> sp.BarIndex:
    return sp.build_bar_index(ts, "15m", "utc_0", max_gap_minutes * M, RULES["completion_bars"])


def test_gap_blocks_candidates_and_tail_has_no_candidates():
    # 2000 根 15m，中间第 1000 根后面挖一个 3 小时的缺口
    ts = continuous(2000 * 15)
    gap_from, gap_to = T0 + 1000 * 15 * M, T0 + 1000 * 15 * M + 180 * M
    ts = ts[(ts < gap_from) | (ts >= gap_to)]
    idx = index_15m(ts)
    opens = idx.opens
    bad_bar = int(np.searchsorted(opens, gap_from)) - 1  # 缺口前最后一根
    # 以 bad_bar−299 为起点的 300 根正好在缺口前结束：合格；再往后一根起，300 根就跨过缺口：不合格
    assert idx.gap_ok_300[bad_bar - 299] == True   # noqa: E712
    assert idx.gap_ok_300[bad_bar - 298] == False  # noqa: E712
    assert not idx.gap_ok_300[bad_bar - 298: bad_bar + 1].any()
    # 最后 299 根后面不够 300 根，不合格
    assert not idx.gap_ok_300[-299:].any()
    assert idx.gap_ok_300[len(opens) - 300]


def test_background_bars_required():
    idx = index_15m(continuous(1200 * 15))
    cands = sp.candidate_positions(idx, background_bars=400)
    assert cands.min() == 400 + 97 and cands.max() == 1200 - 300   # 背景 400 根 + 一天（96 根 15m）+ 1


def test_random_pick_without_history():
    idx = index_15m(continuous(3000 * 15))
    r = sp.pick_segment(idx, 400, [], [], 0, RULES, np.random.default_rng(1))
    assert r.mode == "random" and r.max_overlap == 0.0
    assert (r.nominal_end_ms - r.start_ms) == 300 * 15 * M
    assert (r.start_ms - T0) % (15 * M) == 0  # 对齐到起始周期（D49）


def test_overlap_cap_respected():
    """已完成片段盖住前大半段，只剩后面一小段空着：抽到的片段与每个已完成片段的重叠都 ≤ 20%。"""
    idx = index_15m(continuous(5000 * 15))
    covered_end = int(idx.opens[3800])
    done = [{"start_ms": int(idx.opens[400]), "end_ms": covered_end}]
    for seed in range(20):
        r = sp.pick_segment(idx, 400, done, [], 1, RULES, np.random.default_rng(seed))
        assert r.mode == "random" and r.max_overlap <= 0.2
        inter = max(0, min(r.nominal_end_ms, covered_end) - max(r.start_ms, done[0]["start_ms"]))
        assert inter / (r.nominal_end_ms - r.start_ms) <= 0.2


def test_fallback_recent_when_everything_practised_long_ago():
    """全部数据都被很早以前的片段盖住，但最近 6 个片段只占一小块：进入退路一，且不与最近 6 个重叠。"""
    idx = index_15m(continuous(4000 * 15))
    full = {"start_ms": int(idx.opens[0]), "end_ms": int(idx.opens[-1]) + 15 * M}
    recent = [{"start_ms": int(idx.opens[400 + k * 300]), "end_ms": int(idx.opens[400 + k * 300 + 299]) + 15 * M} for k in range(6)]
    r = sp.pick_segment(idx, 400, [full] + recent, [], 7, RULES, np.random.default_rng(3))
    assert r.mode == "fallback_recent"
    for s in recent:
        assert min(r.nominal_end_ms, s["end_ms"]) <= max(r.start_ms, s["start_ms"])


def test_fallback_min_overlap_when_recent_cover_everything():
    idx = index_15m(continuous(1000 * 15))
    full = [{"start_ms": int(idx.opens[0]), "end_ms": int(idx.opens[-1]) + 15 * M}] * 6
    r = sp.pick_segment(idx, 400, full, [], 6, RULES, np.random.default_rng(5))
    assert r.mode == "fallback_min_overlap" and r.max_overlap == 1.0


def test_replay_picks_flagged_segment_nearby():
    idx = index_15m(continuous(5000 * 15))
    target = {"id": 7, "start_ms": int(idx.opens[2000])}
    hits = 0
    for seed in range(200):
        r = sp.pick_segment(idx, 400, [], [target], 5, RULES, np.random.default_rng(seed))
        if r.mode == "replay":
            hits += 1
            assert r.replay_of_segment_id == 7
            assert abs(int(np.searchsorted(idx.opens, r.start_ms)) - 2000) <= 50
    assert 40 <= hits <= 100  # 约 35%


def test_no_replay_before_five_rounds():
    idx = index_15m(continuous(5000 * 15))
    target = {"id": 7, "start_ms": int(idx.opens[2000])}
    modes = {sp.pick_segment(idx, 400, [], [target], 4, RULES, np.random.default_rng(s)).mode for s in range(100)}
    assert modes == {"random"}


def test_bars_completed_counts_closed_existing_bars():
    ts = continuous(1000 * 15)
    idx = index_15m(ts)
    start = int(idx.opens[400])
    assert sp.bars_completed(idx, start, start) == 0
    assert sp.bars_completed(idx, start, start + 15 * M - M) == 0      # 第一根还差 1 分钟
    assert sp.bars_completed(idx, start, start + 15 * M) == 1
    assert sp.bars_completed(idx, start, start + 300 * 15 * M) == 300


def test_max_disjoint_rounds_counts_non_overlapping_segments():
    """D86：1200 根 15m、背景 400 根 → 合格起点是第 497–900 根；第一轮 497–796，第二轮从 797 起，第三轮放不下。"""
    idx = index_15m(continuous(1200 * 15))
    assert sp.max_disjoint_rounds(idx, 400, 300) == 2
    assert sp.max_disjoint_rounds(idx, 1000, 300) == 0   # 背景太多：一个合格起点都没有


def test_usable_months_counts_from_history_start_and_lists_missing(monkeypatch):
    """D86：只数 history_start 及以后、状态完整或有疑问的月份；首尾之间失败或缺失的月份列出来（含跨年）。"""
    meta = {"months": {"2021-09": {"status": "complete"}, "2021-10": {"status": "complete"}, "2021-11": {"status": "failed"},
                       "2021-12": {"status": "warnings"}, "2022-02": {"status": "complete"}}}
    monkeypatch.setattr(sp.download_common, "read_meta", lambda source, symbol: meta)
    r = sp.usable_months("x", "X", "2021-10")
    assert r == {"months": 3, "first_month": "2021-10", "last_month": "2022-02", "missing_months": ["2021-11", "2022-01"]}
