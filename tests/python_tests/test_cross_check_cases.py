# -*- coding: utf-8 -*-
"""
对账用例文件必须和当前 Python 规则一致：重新算一遍和 kline_synthesis_cases.json 比。
规则改了却没重新生成用例时，这里会失败，提醒先运行 generate_kline_synthesis_cases（前端会读同一个文件对账）。
"""

import json

import pandas as pd

from python_backend.trading_rules import kline_data as kd
from tests.cross_check_cases import generate_kline_synthesis_cases as gen


def test_cases_file_matches_current_python_rules():
    data = json.loads(gen.OUT_FILE.read_text(encoding="utf-8"))
    inputs = {c["window"]: c["input_1m"] for c in data["cases"] if "input_1m" in c}
    checked = 0
    for c in data["cases"]:
        if "expected" not in c:
            continue
        m1 = pd.DataFrame(inputs[c["window"]], columns=["timestamp", "open", "high", "low", "close"])
        m1["timestamp"] = m1["timestamp"].astype("int64")
        m1["volume"] = 1.0
        got = kd.synthesize(m1, c["timeframe"], c["day_anchor"], c.get("week_start", "monday"))[["timestamp", "open", "high", "low", "close", "minute_count"]]
        assert got.to_numpy().tolist() == c["expected"], c["name"]
        checked += 1
    assert checked == 48
