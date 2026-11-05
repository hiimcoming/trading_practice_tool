# -*- coding: utf-8 -*-
"""
生成前后端 K 线合成的对账用例（CLAUDE.md 架构铁律 3）：
用 Python 的 kline_data.synthesize 算出「标准答案」，写成 kline_synthesis_cases.json；
前端测试（web_frontend/src/trading_rules/kline_synthesis.test.ts）读同一个文件，用 TypeScript 再算一遍逐根比对；
Python 测试（tests/python_tests/test_cross_check_cases.py）检查这个文件和当前 Python 规则一致（规则改了没重新生成会报错）。

用例覆盖：8 个周期 × 两种日线起点（1w 另分周一 / 周日两种周起点，D74；各窗口都跨过周日→周一）；美国夏令时开始日（2026-03-08）、结束日（2026-11-01）；
黄金式的每日休市和周末缺口；零散缺分钟。数据是固定种子生成的假价格，结果可重复。
运行（项目根目录）：.venv/bin/python -m tests.cross_check_cases.generate_kline_synthesis_cases
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from python_backend.trading_rules import kline_data as kd

OUT_FILE = Path(__file__).resolve().parent / "kline_synthesis_cases.json"
M = kd.MINUTE_MS


def utc_ms(text: str) -> int:
    return int(datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp() * 1000)


def make_1m(start: str, end: str, seed: int, gold_like: bool) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    ts = np.arange(utc_ms(start), utc_ms(end), M, dtype="int64")
    t = pd.to_datetime(ts, unit="ms", utc=True)
    keep = np.ones(len(ts), dtype=bool)
    if gold_like:
        ny = t.tz_convert("America/New_York")
        # 纽约 17:00–18:00 每日休市；周五 17:00 到周日 18:00 周末休市
        keep &= ~np.asarray(ny.hour == 17)
        keep &= ~np.asarray(((ny.weekday == 4) & (ny.hour >= 17)) | (ny.weekday == 5) | ((ny.weekday == 6) & (ny.hour < 18)))
    keep &= rng.random(len(ts)) > 0.02  # 再随机缺 2% 的分钟
    ts = ts[keep]
    steps = rng.normal(0, 0.4, len(ts))
    close = np.round(4000 + np.cumsum(steps), 3)
    open_ = np.round(np.concatenate([[4000.0], close[:-1]]) + rng.normal(0, 0.05, len(ts)), 3)
    high = np.round(np.maximum(open_, close) + rng.random(len(ts)) * 0.5, 3)
    low = np.round(np.minimum(open_, close) - rng.random(len(ts)) * 0.5, 3)
    return pd.DataFrame({"timestamp": ts, "open": open_, "high": high, "low": low, "close": close, "volume": np.ones(len(ts))})


WINDOWS = [
    ("夏令时开始前后（黄金式休市）", "2026-03-05 00:00", "2026-03-11 00:00", 11, True),
    ("夏令时结束前后（7×24）", "2026-10-30 12:00", "2026-11-03 12:00", 12, False),
    ("普通夏季周（黄金式休市）", "2026-07-08 00:00", "2026-07-14 00:00", 13, True),
]


def main():
    cases = []
    for name, start, end, seed, gold in WINDOWS:
        m1 = make_1m(start, end, seed, gold)
        inp = m1[["timestamp", "open", "high", "low", "close"]].to_numpy().tolist()
        for anchor in kd.DAY_ANCHORS:
            for tf in kd.TIMEFRAMES:
                if tf == "1m":
                    continue
                for ws in (kd.WEEK_STARTS if tf == "1w" else ["monday"]):
                    exp = kd.synthesize(m1, tf, anchor, ws)
                    cases.append({
                        "name": f"{name} · {tf} · {anchor}" + (f" · 周起点 {ws}" if tf == "1w" else ""), "window": name,
                        "timeframe": tf, "day_anchor": anchor, "week_start": ws,
                        "expected": exp[["timestamp", "open", "high", "low", "close", "minute_count"]].to_numpy().tolist(),
                    })
        cases.append({"name": f"{name} · 输入", "window": name, "input_1m": inp})
    payload = {"_说明": "由 generate_kline_synthesis_cases.py 生成，勿手改。时间为 UTC 毫秒；价格保留 3 位小数。", "cases": cases}
    OUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_exp = sum(len(c.get("expected", [])) for c in cases)
    print(f"已写入 {OUT_FILE.name}：{len([c for c in cases if 'expected' in c])} 个用例，期望 K 线共 {n_exp} 根")


if __name__ == "__main__":
    main()
