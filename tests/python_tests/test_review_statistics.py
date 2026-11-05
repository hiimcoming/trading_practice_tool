# -*- coding: utf-8 -*-
"""
第 5b 阶段：纪律审查各项比率、MT4 式统计表、进步曲线（规格书 7.3 节，D68）。

一、手工构造 6 笔交易（覆盖审查表每一项），逐项与手算比对。15m 起始周期，第 0 根 = 2026-01-05 00:00 UTC（周一），XAUUSD 1 手 = 100 盎司。
  #1 多 0.01 手 市价  第 0 根开、第 4 根止损  −10.50  开仓止损 1995、止盈 2020，持仓中把止损挪到 1990（不利 1 次）；
     开仓杠杆 4.0、止损风险 12%（重仓，> 10%），持仓最高 6.5（≥ 4×1.5，被动加杠杆）；止损前净值 1000；决策 20 秒
  #2 多 0.02 手 市价  第 5 根开、第 8 根止盈  +30.00  止损 1980、止盈 2030；上一笔亏损且手数更大（亏后放大）；
     #1 止损后隔 1 根（快速再入场）；杠杆 1.5；决策 5 秒
  #3 空 0.01 手 限价  第 20 根开、第 30 根手动 +5.00  进场没设止损（第 25 根才设，超过 3 根宽限）、设了止盈且手动平盈利单（拿不住）；杠杆 2.0；决策无记录
  #4 空 0.01 手 止损单 第 40 根开、第 41 根止损 −8.00  止损 2010、没止盈；杠杆 2.5；止损前净值 1015；决策 60 秒
  #5 多 0.01 手 市价  第 50 根开、第 60 根手动 −2.00  #4 止损后隔 9 根；止损 1990、没止盈；杠杆 1.0；决策 1 秒
  #6 多 0.01 手 市价  第 61 根开、第 62 根止损 −6.00  止损 1990；杠杆 1.2；止损前净值 1010；决策 200 秒
  手算：6 笔、赢 2 笔（#2 #3），整体胜率 1/3；#4 #5 #6 连亏 3 笔为一段；时段：#1–#3 亚洲、#4 #5 伦敦、#6 纽约。
二、MT4 统计表与 CryptoTrade/backtest/analyzer.py 的 metrics 逐项一致（本机有 CryptoTrade 时才比）。
三、进步曲线的滚动窗口；四、复算顺带记下决策用时和止损前净值（走一遍 test_session_finish 的模拟练习）。
"""

import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from python_backend.practice_reports import discipline_review as dr
from python_backend.practice_reports import performance_reports as pr
from python_backend.website_server import practice_sessions as ps
from python_backend.website_server import review_statistics as rs
from python_backend.website_server import session_finish as sf
from python_backend.website_server import user_database as udb
from tests.python_tests import test_session_finish as tsf
from tests.python_tests.test_practice_sessions import new_round, sandbox  # noqa: F401

T0 = 1767571200000  # 2026-01-05 00:00 UTC
M15 = 15 * 60_000
OPENS = np.arange(T0, T0 + 200 * M15, M15, dtype=np.int64)
SETTINGS = ps.load_settings()
SPEC = ps.market_spec("XAUUSD")


def bar(k: int, minute: int = 0) -> int:
    return T0 + k * M15 + minute * 60_000


def trade(pid, d, qty, src, ob, cb, reason, pnl, entry, sl0, tp_close):
    return {"position_id": pid, "order_id": 100 + pid, "source": src, "direction": d, "qty": qty, "entry_price": entry,
            "open_ms": bar(ob), "close_ms": bar(cb, 7), "close_reason": reason, "pnl": pnl, "initial_sl": sl0, "tp_at_close": tp_close}


TRADES = [
    trade(1, 1, 0.01, "market", 0, 4, "stop", -10.5, 2000, 1995, 2020),
    trade(2, 1, 0.02, "market", 5, 8, "tp", 30.0, 2000, 1980, 2030),
    trade(3, -1, 0.01, "sell_limit", 20, 30, "manual", 5.0, 2000, 2010, 1990),
    trade(4, -1, 0.01, "sell_stop", 40, 41, "stop", -8.0, 2000, 2010, None),
    trade(5, 1, 0.01, "market", 50, 60, "manual", -2.0, 2000, 1990, None),
    trade(6, 1, 0.01, "market", 61, 62, "stop", -6.0, 2000, 1990, None),
]


def snap(sl, tp, lev, stop_risk=0.01):
    return {"sl": sl, "tp": tp, "leverage": lev, "margin_usage": None, "stop_risk": stop_risk if sl else None, "liq_distance": 0.5}


REC = {
    "open": {1: snap(1995, 2020, 4.0, 0.12), 2: snap(1980, 2030, 1.5), 3: snap(None, 1990, 2.0), 4: snap(2010, None, 2.5),
             5: snap(1990, None, 1.0), 6: snap(1990, None, 1.2)},
    "hold": {1: {"max_leverage": 6.5, "max_leverage_ms": bar(3), "lev_sum": 20.0, "n": 4, "min_liq_distance": 0.3,
                 "max_stop_risk": 0.02, "stop_unlimited": False}},
    "stop_changes": {1: [{"ms": bar(2), "old": 1995, "new": 1990}]},
    "ever_sl": {1, 2, 3, 4, 5, 6}, "ever_tp": {1, 2, 3},
    "equity_before_stop": {1: 1000.0, 4: 1015.0, 6: 1010.0},
    "decisions": {101: 20_000, 102: 5_000, 104: 60_000, 105: 1_000, 106: 200_000},
    "bars_with_position": 30, "bars_total": 100,
    "first_sl": {3: {"ms": bar(25), "stop_risk": 0.005}},
}
CFG = SETTINGS["discipline_review"]


@pytest.fixture()
def review():
    facts = [dict(f, round_no=1) for f in dr.trade_facts(TRADES, REC, OPENS, SPEC, SETTINGS)]
    streaks = dr.loss_streaks(facts, OPENS, 3)
    summary = dict(dr.round_summary(facts, streaks, 300, REC, CFG, 0.01, 0.02), round_no=1)
    return facts, summary, dr.review_tables(facts, [summary], SETTINGS)


def row(rows, label_part):
    return next(r for r in rows if label_part in r["label"])


def test_trade_facts_match_hand_calc(review):
    facts, summary, _ = review
    f = {x["no"]: x for x in facts}
    assert [x["win"] for x in facts] == [False, True, True, False, False, False]
    assert f[1]["moves_against"] == 1 and f[1]["heavy"] and f[1]["passive_leverage"]
    assert f[2]["quick_reentry"] and f[2]["after_stop_bars"] == 1 and f[2]["after_stop_of"] == 1 and f[2]["size_up_after_loss"]
    assert not f[3]["sl_at_entry"] and f[3]["ever_sl"] and f[3]["manual_profit_before_tp"] and f[3]["entry_type"] == "limit"
    assert f[5]["after_stop_bars"] == 9 and not f[5]["quick_reentry"] and not f[5]["size_up_after_loss"]
    assert f[6]["after_stop_bars"] is None                     # #4 之后已经开过 #5，不算止损后的第一笔
    assert f[1]["planned_r"] == pytest.approx(20 / 5) and f[2]["planned_r"] == pytest.approx(30 / 20)
    assert f[1]["r"] == pytest.approx(-10.5 / (5 * 1)) and f[2]["r"] == pytest.approx(30 / (20 * 2))
    assert f[1]["stop_pct"] == pytest.approx(10.5 / 1000) and f[4]["stop_pct"] == pytest.approx(8 / 1015)
    assert [x["session"] for x in facts] == ["亚洲", "亚洲", "亚洲", "伦敦", "伦敦", "纽约"]
    assert [x["disciplined"] for x in facts] == [False, False, False, True, True, True]
    # 同一笔里按发生时刻排：#1 先重仓（开仓时）后挪止损（第 2 根）
    assert [v["kind"] for v in dr.round_violations(facts, CFG)] == [
        "heavy_position", "stop_moved_against", "quick_reentry", "size_up_after_loss", "no_stop_at_entry"]
    assert summary["longest_loss_run"] == 3 and summary["violations_total"] == 5
    assert summary["after_stop_bars_median"] == 5 and summary["max_leverage"] == 6.5
    assert summary["trades_per_100_bars"] == pytest.approx(2.0) and summary["holding_time_share"] == pytest.approx(0.3)


def test_review_tables_match_hand_calc(review):
    _, _, rv = review
    assert rv["trades"] == 6 and rv["overall_win_rate"] == pytest.approx(1 / 3) and rv["sample_small"]
    st = rv["stops"]
    assert (row(st, "根内没设止损")["count"], row(st, "根内没设止损")["win_rate"]) == (1, 1.0)
    assert row(st, "全程没设过止损")["count"] == 0
    assert (row(st, "进场时没设止盈")["count"], row(st, "进场时没设止盈")["win_rate"]) == (3, 0.0)
    moved = row(st, "往不利方向")
    assert (moved["count"], moved["times"], moved["win_rate"]) == (1, 1, 0.0)
    assert (moved["compare"]["count"], moved["compare"]["win_rate"]) == (5, pytest.approx(2 / 5))
    a = rv["after_stop"]
    assert [(r["label"], r["count"]) for r in a["gaps"]] == [("0–1 根", 1), ("2–3 根", 0), ("4–10 根", 1), ("11 根以上", 0)]
    assert a["gaps"][2]["median_minutes"] == pytest.approx((bar(50) - bar(41, 7)) / 60_000)
    assert (a["quick_reentry"]["count"], a["quick_reentry"]["win_rate"]) == (1, 1.0)
    assert a["size_up_after_loss"]["count"] == 1
    assert rv["loss_streaks"]["count"] == 1 and rv["loss_streaks"]["items"][0]["nos"] == [4, 5, 6]
    assert rv["loss_streaks"]["items"][0]["gaps_bars"] == [9, 1]
    assert [(r["label"], r["count"], r["win_rate"]) for r in rv["entry_types"]] == [
        ("市价单", 4, 0.25), ("限价挂单", 1, 1.0), ("止损挂单", 1, 0.0)]
    assert rv["plan"]["planned_r_avg"] == pytest.approx((4 + 1.5) / 2) and rv["plan"]["actual_r_avg"] == pytest.approx((-2.1 + 0.75) / 2)
    assert rv["plan"]["cut_winners"]["count"] == 1
    assert rv["holding"]["win_bars"] == pytest.approx((3 + 10) / 2) and rv["holding"]["loss_bars"] == pytest.approx((4 + 1 + 10 + 1) / 4)
    assert [(r["label"], r["count"], r["win_rate"]) for r in rv["sessions"]] == [
        ("亚洲", 3, pytest.approx(2 / 3)), ("伦敦", 2, 0.0), ("纽约", 1, 0.0), ("收盘后", 0, None)]
    assert [(r["label"], r["count"]) for r in rv["directions"]] == [("做多", 4), ("做空", 2)]
    r = rv["risk"]
    assert [x["count"] for x in r["leverage_buckets"]] == [1, 4, 1, 0, 0, 0]
    # 止损风险四档（D73）：#1 12% 在 > 10%；#2 #4 #5 #6 各 1% 在 ≤ 2%；#3 超过宽限才设止损，算「未设止损」
    assert [(x["label"], x["count"]) for x in r["stop_risk_buckets"]] == [
        ("≤ 2%", 4), ("2–5%", 0), ("5–10%", 0), ("> 10%", 1), ("未设止损", 1)]
    assert (r["heavy"]["count"], r["heavy"]["win_rate"], r["not_heavy"]["win_rate"]) == (1, 0.0, pytest.approx(2 / 5))
    assert r["passive"]["count"] == 1 and r["max_leverage"]["value"] == 6.5 and r["max_leverage"]["no"] == 1
    sp = r["stop_pct"]
    assert (sp["count"], sp["min"], sp["median"], sp["max"]) == (3, pytest.approx(6 / 1010), pytest.approx(8 / 1015), pytest.approx(10.5 / 1000))
    assert [x["count"] for x in rv["decision"]] == [2, 1, 1, 1, 1]   # ≤10 秒、10–30、30–120、>120、无记录
    tips = dr.hints(rv, SETTINGS)
    assert any("连续亏损" in t for t in tips)                        # 其余规则样本不足 5 笔，不出提示
    assert not any("重仓" in t for t in tips)


def test_range_stats_match_cryptotrade_analyzer():
    pnl = [-10.5, 30.0, 5.0, -8.0, -2.0, -6.0, 12.0, -3.0]
    trades = [{"pnl": x, "direction": 1 if i % 2 else -1, "cost": 0.35, "round_no": 1 if i < 5 else 2} for i, x in enumerate(pnl)]
    rounds = [{"round_no": 1, "start_utc": "a", "end_utc": "b", "days": 1.5, "bars_played": 300}]
    s = pr.range_stats(trades, rounds, 1000.0)
    assert (s["trades"], s["wins"], s["losses"]) == (8, 3, 5)
    assert s["profit_factor"] == pytest.approx(47 / 29.5) and s["payoff_ratio"] == pytest.approx((47 / 3) / (29.5 / 5))
    assert s["longest_loss_streak"] == {"count": 3, "amount": pytest.approx(-16.0)}
    assert s["longest_win_streak"] == {"count": 2, "amount": pytest.approx(35.0)}
    assert s["max_drawdown"] == pytest.approx(16.0) and s["max_drawdown_of_round_capital"] == pytest.approx(16 / 1000)
    # 累计盈亏从 0 开始；第 2 轮从第 6 笔开始
    assert s["cum_pnl"][:3] == [0.0, -10.5, 19.5] and s["cum_pnl"][-1] == pytest.approx(17.5)
    assert s["round_marks"] == [{"index": 1, "round_no": 1}, {"index": 6, "round_no": 2}]
    path = Path.home() / "python_projects" / "CryptoTrade" / "backtest" / "analyzer.py"
    if not path.exists():
        pytest.skip("本机没有 CryptoTrade，跳过与 analyzer.py 的对账")
    spec = importlib.util.spec_from_file_location("ct_analyzer", path)
    ct = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ct)
    m = ct.metrics(pd.Series(pnl), 1000.0)
    assert s["win_rate"] == pytest.approx(m["胜率"]) and s["profit_factor"] == pytest.approx(m["PF"])
    assert s["payoff_ratio"] == pytest.approx(m["赔率"]) and s["avg_pnl"] == pytest.approx(m["单笔期望"])
    assert s["max_drawdown"] == pytest.approx(m["最大回撤"])
    assert s["longest_loss_streak_analyzer"] == m["最长连亏"]


def test_progress_series_rolling_window():
    mk = lambda no, pnls: [{"pnl": p, "win": p > 0, "disciplined": p > 0, "r": None} for p in pnls]  # noqa: E731
    facts = {1: mk(1, [5, -5]), 2: mk(2, []), 3: mk(3, [10, -2, -2])}
    rounds = [{"round_no": i, "trades": len(facts[i]), "violations": {}, "longest_loss_run": None, "after_stop_bars_median": None,
               "max_leverage": None, "stop_pct_median": None, "trades_per_100_bars": None, "hold_bars_win": None,
               "hold_bars_loss": None, "return": None, "max_drawdown_pct": None, "planned_r_avg": None, "actual_r_avg": None}
              for i in (1, 2, 3)]
    settings = json.loads(json.dumps(SETTINGS))
    settings["discipline_review"]["rolling_trades"] = 4
    pts = dr.progress_series(rounds, facts, settings)["points"]
    assert [p["window_trades"] for p in pts] == [2, 2, 4]
    assert pts[2]["win_rate"] == pytest.approx(1 / 4)        # 最近 4 笔：−5、10、−2、−2
    assert pts[2]["payoff_ratio"] == pytest.approx(10 / 3)
    assert pts[1]["violations"] is None and pts[0]["sample_small"] and not pts[2]["sample_small"]


def test_recompute_records_decision_time_and_statistics_page(sandbox):  # noqa: F811
    udb.enter_user("Test_User_01")
    plan = dict(tsf.PLAN)
    plan[0] = [lambda a: {"op": "market", "direction": 1, "qty": 0.01, "sl": None, "tp": None, "_decision_ms": 1234}]
    tsf.play_round(new_round(), plan, 310 * 15)
    sid = ps.list_sessions(tsf.USER)[0]["id"]
    report = sf.generate_report(tsf.USER, sid)
    assert report["version"] == pr.REPORT_VERSION and report["round_no"] == 1
    f = {x["no"]: x for x in report["facts"]}
    assert f[1]["decision_ms"] == 1234 and f[2]["decision_ms"] is None
    assert f[1]["moves_against"] == 1 and f[2]["stop_pct"] is not None and f[2]["stop_pct"] > 0
    assert report["trades"][0]["decision_ms"] == 1234
    page = rs.statistics_page(tsf.USER, "BTCUSDT", "all")      # 简报还没存：统计页自动生成
    assert page["rounds_total"] == 1 and page["stats"]["trades"] == 3 and page["review"]["trades"] == 3
    assert page["progress"]["points"][0]["round_no"] == 1 and page["progress"]["points"][0]["sample_small"]
    rsum = page["range_summary"]   # 标题用（D72）：第 1–1 轮，今天练的，跨 1 天；币安金额写 USDT
    assert (rsum["first_round"], rsum["last_round"], rsum["rounds"], rsum["days"]) == (1, 1, 1, 1) and rsum["from_date"] == rsum["to_date"]
    assert page["currency"] == "USDT"
    assert sf.report_status(tsf.USER, sid)["practice_date"] == rsum["from_date"]
    with pytest.raises(ps.SessionError):
        rs.statistics_page(tsf.USER, "BTCUSDT", "bad_range")


def test_export_markdown_matches_statistics_page(sandbox):  # noqa: F811
    """下载我的数据（第 5c 阶段，D70）：Markdown 里的数字与统计页同一范围一致；接口以附件形式返回。"""
    from fastapi import HTTPException

    from python_backend.practice_reports import export_markdown_html as ex
    from python_backend.website_server import api_routes

    udb.enter_user("Test_User_01")
    tsf.play_round(new_round(), tsf.PLAN, 310 * 15)
    page = rs.statistics_page(tsf.USER, "BTCUSDT", "all")
    name, text = rs.export_markdown(tsf.USER, "BTCUSDT", "all")
    s = page["stats"]
    assert name.endswith(".md") and "BTCUSDT_all_" in name
    # 统计表照 MT4 排版（D73）：三列「项目 | 数值」
    assert f"| 交易总笔数 | {s['trades']} | 做空（胜率） |" in text
    assert f"| 盈利交易（占总数） | {s['wins']}（{ex.p0(s['win_rate'])}） |" in text
    assert f"| 净盈亏 | {ex.signed_money(s['net_pnl'], 'USDT')} |" in text
    assert f"| 利润因子 | {ex.n2(s['profit_factor'])} |" in text
    assert f"| 最大回撤 | {ex.money(s['max_drawdown'], 'USDT')}（" in text
    assert f"| 绝对回撤 | {ex.money(s['absolute_drawdown'], 'USDT')} |" in text
    for h in ("## 一、说明", "## 二、总览", "## 三、每轮进步表", "## 四、每轮简报", "## 五、交易明细", "## 六、给 AI 的提问模板"):
        assert h in text
    detail = text.split("## 五、交易明细")[1].split("## 六")[0]
    assert sum(1 for line in detail.splitlines() if line.startswith("| 1 |")) == s["trades"]   # 每笔一行
    res = api_routes.get_export(tsf.USER, "BTCUSDT", "all")        # 直接调接口函数（不为测试多装 HTTP 客户端库）
    assert res.status_code == 200 and res.media_type.startswith("text/markdown")
    assert "attachment" in res.headers["content-disposition"] and res.body.decode("utf-8").split("\n", 3)[3] == text.split("\n", 3)[3]  # 第 3 行是导出时间
    for sym, rng, code in (("BTCUSDT", "bad", 422), ("NOPE", "all", 404)):
        with pytest.raises(HTTPException) as e:
            api_routes.get_export(tsf.USER, sym, rng)
        assert e.value.status_code == code
    _, empty = rs.export_markdown(tsf.USER, "XAUUSD", "all")       # 没练过的品种：只有说明
    assert "没有已完成的轮次" in empty and "## 五" not in empty


# ============================================================
# 五、第 5b-2 阶段（D71）：自定义日期范围、每 5 轮一组、连亏段的持仓编号
# ============================================================

def test_custom_date_bounds_follow_display_timezone():
    """UTC+8 的 10-22 整天 = UTC 10-21 16:00 到 10-22 16:00；结束日期当天整天都算。"""
    assert rs._custom_bounds("2026-10-22", "2026-10-22", 8)[:2] == ("2026-10-21 16:00:00", "2026-10-22 16:00:00")
    assert rs._custom_bounds("2026-10-21", "2026-10-22", 0) == ("2026-10-21 00:00:00", "2026-10-23 00:00:00", "2026-10-21", "2026-10-22")
    assert rs._custom_bounds("2026-1-5", "2026-01-05", 0)[2] == "2026-01-05"     # 统一成补零写法（文件名、标题用）
    for a, b, msg in (("2026-10-22", "2026-10-21", "起始日期晚于结束日期"), ("", "2026-10-21", "请填写起止日期"), ("2026-13-01", "2026-12-01", "请填写起止日期")):
        with pytest.raises(ps.SessionError) as e:
            rs._custom_bounds(a, b, 0)
        assert msg in str(e.value) and e.value.status == 422
    rounds = [{"round_no": i, "finished_at": t} for i, t in
              enumerate(["2026-10-21 15:59:59", "2026-10-21 16:00:00", "2026-10-22 15:59:59", "2026-10-22 16:00:00"], 1)]
    lo, hi = rs._custom_bounds("2026-10-22", "2026-10-22", 8)[:2]
    assert [r["round_no"] for r in rs._in_range("custom", rounds, None, (lo, hi))] == [2, 3]


def test_groups_of_five_rounds_match_hand_calc():
    """12 轮：分 3 组（1–5、6–10、11–12 未满）。每轮 2 笔，第 k 轮盈亏 = (+k, −1)；第 11、12 轮两笔都亏。"""
    def rnd(no):
        pnls = [-2.0, -3.0] if no > 10 else [float(no), -1.0]
        return {"round_no": no, "start_utc": "", "end_utc": "", "days": 1, "bars_played": 300, "max_drawdown_pct": None,
                "violations_total": no % 3,
                "trade_rows": [{"no": j + 1, "close_ms": no * 1000 + j, "pnl": p, "direction": 1, "cost": 0.1} for j, p in enumerate(pnls)]}
    rounds = [rnd(i) for i in range(1, 13)]
    facts = {r["round_no"]: [{"disciplined": j == 0} for j in range(2)] for r in rounds}
    g = rs._groups(rounds, facts)
    assert [(x["first"], x["last"], x["complete"], len(x["round_nos"])) for x in g] == [(1, 5, True, 5), (6, 10, True, 5), (11, 15, False, 2)]
    assert [x["trades"] for x in g] == [10, 10, 4]
    assert g[0]["win_rate"] == pytest.approx(0.5) and g[2]["win_rate"] == 0.0
    assert g[0]["net_pnl"] == pytest.approx(1 + 2 + 3 + 4 + 5 - 5) and g[1]["net_pnl"] == pytest.approx(6 + 7 + 8 + 9 + 10 - 5)
    assert g[0]["profit_factor"] == pytest.approx(15 / 5) and g[0]["payoff_ratio"] == pytest.approx(3 / 1)
    assert g[2]["profit_factor"] == 0.0 and g[2]["payoff_ratio"] is None and g[0]["disciplined_share"] == pytest.approx(0.5)
    assert [x["violations"] for x in g] == [1 + 2 + 0 + 1 + 2, 0 + 1 + 2 + 0 + 1, 2 + 0]


def test_loss_streak_items_carry_position_ids(review):
    facts, summary, _ = review
    facts = [dict(f, position_id=f["position_id"] + 10) for f in facts]   # 让持仓编号和「第几笔」不同
    items = dr.review_tables(facts, [summary], SETTINGS)["loss_streaks"]["items"]
    assert items[0]["nos"] == [4, 5, 6] and items[0]["position_ids"] == [14, 15, 16]


def test_statistics_and_export_with_custom_dates(sandbox):  # noqa: F811
    udb.enter_user("Test_User_01")
    tsf.play_round(new_round(), tsf.PLAN, 310 * 15)
    with udb.user_db(tsf.USER) as db:
        finished = db.execute("SELECT finished_at FROM sessions WHERE status = 'completed'").fetchone()[0]
    day = finished[:10]
    whole = rs.statistics_page(tsf.USER, "BTCUSDT", "all")
    page = rs.statistics_page(tsf.USER, "BTCUSDT", "custom", start=day, end=day)
    assert page["range_rounds"] == [1] and page["stats"] == whole["stats"] and page["review"] == whole["review"]
    assert page["range_label"] == f"{day} 至 {day}（按练习完成日期，UTC）" and page["groups"] == whole["groups"]
    assert len(page["groups"]) == 1 and not page["groups"][0]["complete"]
    empty = rs.statistics_page(tsf.USER, "BTCUSDT", "custom", start="2020-01-01", end="2020-01-31")
    assert empty["range_rounds"] == [] and empty["stats"]["trades"] == 0 and empty["groups"] == whole["groups"]
    udb.put_settings(tsf.USER, {"utc_offset_hours": 8})
    assert "UTC+8" in rs.statistics_page(tsf.USER, "BTCUSDT", "custom", start=day, end=day)["range_label"]
    name, text = rs.export_markdown(tsf.USER, "BTCUSDT", "custom", start="2020-01-01", end="2020-01-31")
    assert "_2020-01-01_2020-01-31_" in name and "没有已完成的轮次" in text
    name, text = rs.export_markdown(tsf.USER, "BTCUSDT", "custom", start="2000-01-01", end="2099-12-31")
    assert "### 每 5 轮一组的对比" in text and "第 1–5 轮（未满 5 轮，已有 1 轮）" in text
    with pytest.raises(ps.SessionError):
        rs.statistics_page(tsf.USER, "BTCUSDT", "custom", start="2026-10-22", end="2026-10-21")


def test_mt4_extra_items_match_hand_calc():
    """MT4 式统计表补的几项（D73），手算：逐笔 −5、−10、+20、−30、+40、+3
    累计盈亏 0 → −5 → −15 → +5 → −25 → +15 → +18，最低 −25 → 绝对回撤 25；
    连赢段 (+20)、(+40, +3) → 金额最大 43（2 笔），平均 1.5 笔；连亏段 (−5, −10)、(−30) → 金额最大 −30（1 笔），平均 1.5 笔。"""
    trades = [{"pnl": x, "direction": 1, "cost": 0.0, "round_no": 1} for x in (-5.0, -10.0, 20.0, -30.0, 40.0, 3.0)]
    r = pr.range_stats(trades, [{"round_no": 1, "start_utc": "a", "end_utc": "b", "days": 1, "bars_played": 300}], 1000.0)
    assert r["absolute_drawdown"] == pytest.approx(25.0)
    assert r["max_win_streak_amount"] == {"count": 2, "amount": pytest.approx(43.0)} and r["avg_win_streak"] == pytest.approx(1.5)
    assert r["max_loss_streak_amount"] == {"count": 1, "amount": pytest.approx(-30.0)} and r["avg_loss_streak"] == pytest.approx(1.5)
    assert r["max_drawdown"] == pytest.approx(30.0)   # 从前高 +5 跌到 −25
