# -*- coding: utf-8 -*-
"""
交易规则（python_backend/trading_rules/ 的 margin_and_liquidation、order_fills_and_costs）的手算核对：
  - 规格书 6.3、6.5 节的验算例；
  - 对账用例里关键几笔的成交价、成本、盈亏，与手算一致（数字推导写在每条注释里）；
  - trading_cases.json 与当前 Python 规则一致（规则改了没重新生成用例会失败，前端读同一个文件对账）。
"""

import json

import pytest

from python_backend.trading_rules import margin_and_liquidation as ml
from python_backend.trading_rules import order_fills_and_costs as of
from tests.cross_check_cases import generate_trading_cases as gen

SPECS = gen.load_specs()
XAU, BTC = SPECS["XAUUSD"], SPECS["BTCUSDT"]
CASES = {c["name"]: c for c in json.loads(gen.OUT_FILE.read_text(encoding="utf-8"))["cases"]}


def final(name):
    return CASES[name]["expected"]["final"]


# ---------------- 规格书验算例 ----------------

def test_spec_6_3_margin_and_sizing():
    # 0.01 手 × 100 盎司 × 4200 ÷ 500 = 8.4（规格书原写 0.84，已更正）
    assert ml.position_margin(0.01, 4200, XAU, 500) == pytest.approx(8.4)
    # 净值 1000 的 23% = 230 作保证金 → 230 ÷ 8.4 = 27.38 个 0.01 手 → 向下取整 0.27 手
    assert ml.qty_from_margin_ratio(1000, 0.23, 4200, XAU, 500) == pytest.approx(0.27)
    # 0.27 手 = 27 盎司：金价每动 1 美元盈亏 27 美元
    assert ml.pnl_per_price_unit(0.27, XAU) == pytest.approx(27)


def test_spec_6_5_liquidation_examples():
    # 原文纯公式：2.73 手（273 盎司）、开仓 4200、余额 1000、m = 0 → 4200 − 1000 ÷ 273 = 4196.34
    lp = ml.liquidation_price([{"direction": 1, "qty": 2.73, "entry_price": 4200}], 1000, XAU, 500)
    assert round(lp, 2) == 4196.34
    # 可行的例子：0.27 手 → 4200 − 1000 ÷ 27 = 4162.96
    lp = ml.liquidation_price([{"direction": 1, "qty": 0.27, "entry_price": 4200}], 1000, XAU, 500)
    assert round(lp, 2) == 4162.96
    # 币安：0.1 BTC 在 100000，余额 1000，m = 0.4% → (10000 − 1000) ÷ (0.1 × 0.996) = 90361.4
    lp = ml.liquidation_price([{"direction": 1, "qty": 0.1, "entry_price": 100000}], 1000, BTC, 30)
    assert round(lp, 1) == 90361.4
    # 空单：(Q × E + B) ÷ (Q × (1 + m))：0.1 BTC 在 100000 → 11000 ÷ 0.1004 = 109561.75
    lp = ml.liquidation_price([{"direction": -1, "qty": 0.1, "entry_price": 100000}], 1000, BTC, 30)
    assert round(lp, 2) == 109561.75


def test_risk_sizing_includes_costs():
    # 多单开在 4200.30，止损 4190：每盎司亏 4200.30 − (4190 − 0.05) = 10.35；风险 1% = 10 美元 → 10 ÷ (10.35 × 100) = 0.0096 → 0 手
    assert of.qty_from_risk(1000, 0.01, 1, 4200.30, 4190, XAU) == 0
    # 风险 5% = 50 美元 → 50 ÷ 1035 = 0.048 → 0.04 手
    assert of.qty_from_risk(1000, 0.05, 1, 4200.30, 4190, XAU) == pytest.approx(0.04)
    # 止损在错误一侧 → 0
    assert of.qty_from_risk(1000, 0.05, 1, 4200.30, 4210, XAU) == 0


def test_max_withdraw_excludes_floating_profit():
    assert ml.max_withdraw(1100, 1112.99) == 1100   # 有浮盈：最多提余额
    assert ml.max_withdraw(1100, 900) == 900        # 有浮亏：最多提可用保证金


# ---------------- 用例里的关键数字（手算） ----------------

def test_exness_market_long_stop_costs():
    t = final("E01_市价多单_盘中止损")["trades"][0]
    # 开仓 = 卖价 4200 + 点差 0.25 + 滑点 0.05；止损 = 4190 − 0.05；10 盎司
    assert t["entry_price"] == pytest.approx(4200.30)
    assert t["exit_price_avg"] == pytest.approx(4189.95)
    assert t["pnl"] == pytest.approx(-103.5)
    assert t["spread_cost"] == pytest.approx(2.5) and t["slippage_cost"] == pytest.approx(1.0)


def test_exness_short_tp_looks_at_ask():
    t = final("E02_市价空单_盘中止盈")["trades"][0]
    # 卖在 4200 − 0.05；止盈 4190（买价口径）不计滑点；(4199.95 − 4190) × 10 = 99.5
    assert (t["entry_price"], t["exit_price_avg"], t["pnl"]) == pytest.approx((4199.95, 4190, 99.5))


def test_same_bar_stop_and_tp_counts_as_stop():
    assert final("E03_同根止损止盈都碰到按止损")["trades"][0]["close_reason"] == "stop"


def test_gaps():
    assert final("E04_跳空止损")["trades"][0]["exit_price_avg"] == pytest.approx(4184.95)
    assert final("E05_跳空止盈")["trades"][0]["exit_price_avg"] == pytest.approx(4215)
    assert final("E08_买入限价_跳空按开盘价")["positions"][0]["entry_price"] == pytest.approx(4190.25)


def test_partial_close():
    t = final("E06_部分平仓与剩余不足最小手数")["trades"][0]
    # 手动平仓立即按当前价成交（D57）：每次按前一根收盘价减滑点 0.05，开仓价 4200.30
    assert [e["qty"] for e in t["exits"]] == pytest.approx([0.02, 0.02, 0.01])
    assert [e["price"] for e in t["exits"]] == pytest.approx([4199.95, 4201.95, 4204.95])
    assert t["pnl"] == pytest.approx(-0.70 + 3.30 + 4.65)


def test_pending_fills():
    assert final("E07_买入限价_触及即成交")["positions"][0]["entry_price"] == pytest.approx(4195)
    fills = final("E10_买入止损_触发加滑点与跳空")["fills"]
    assert [f["price"] for f in fills if f["action"] == "open"] == pytest.approx([4205.05, 4240.30])
    fills = final("E11_卖出止损_触发与跳空")["fills"]
    assert [f["price"] for f in fills if f["action"] == "open"] == pytest.approx([4194.95, 4169.95])


def test_fill_bar_stop_yes_tp_no():
    assert final("E12_成交根内碰到止损")["trades"][0]["close_reason"] == "stop"
    t = final("E13_成交根内止盈下一根才算")["trades"][0]
    assert t["close_reason"] == "tp" and t["close_ms"] == gen.BASE_MS + 2 * of.MINUTE_MS


def test_multiple_pendings_and_margin():
    f = final("E14_同根多张挂单按距离成交_保证金不足")
    assert f["positions"][0]["entry_price"] == pytest.approx(4195)          # 近的先成交
    assert [(r["order_id"], r["result"]) for r in f["order_results"]] == [(2, "filled"), (1, "margin_insufficient")]


def test_oco_and_opposite():
    f = final("E15_反向挂单自动撤销_OCO")
    assert [r["result"] for r in f["order_results"]] == ["filled", "cancelled_opposite"]
    e = CASES["E16_持多单时反向下单被拒"]["expected"]
    assert e["errors"][0]["code"] == "opposite_position"
    assert e["final"]["order_results"][-1]["result"] == "opposite_position"


def test_liquidation_ends_round_and_clears_account():
    f = final("E17_盘中强平_资金账户为0本轮结束")
    # 1 手多单开在 4200.30：强平价 = 4200.30 − 1000 ÷ 100 = 4190.30，成交 4190.25
    assert f["liquidations"][0]["liquidation_price"] == pytest.approx(4190.30)
    assert f["trades"][0]["pnl"] == pytest.approx(-1000)
    assert f["balance"] == 0 and f["status"] == "ended_liquidation"
    assert f["order_results"][-1]["result"] == "cancelled_liquidation"


def test_liquidation_pause_then_transfer_continue():
    e = CASES["E18_强平后暂停_转入后继续"]["expected"]
    assert e["per_bar"][3]["skipped"] is True
    assert e["final"]["status"] == "active" and e["final"]["funding"] == pytest.approx(200)
    assert e["final"]["balance"] == pytest.approx(300 + 47)


def test_gap_liquidation_negative_balance_protection():
    f = final("E19_跳空强平_负余额保护")
    assert f["liquidations"][0]["at_open"] is True
    assert f["liquidations"][0]["residual_cleared"] == pytest.approx(-4035)
    assert f["trades"][0]["pnl"] == pytest.approx(-1000) and f["balance"] == 0


def test_stop_before_liquidation_and_liquidation_beats_tp():
    assert final("E20_止损比强平近_先止损不强平")["balance"] == pytest.approx(465)
    assert final("E21_强平与止盈同根按强平")["trades"][0]["close_reason"] == "liquidation"


def test_short_liquidation_uses_ask():
    f = final("E26_空单强平看买价")
    assert f["liquidations"][0]["liquidation_price"] == pytest.approx(4209.95)
    assert f["trades"][0]["exit_price_avg"] == pytest.approx(4210.00)


def test_transfers():
    e = CASES["E22_出入金规则"]["expected"]
    assert [x["code"] for x in e["errors"]] == ["over_withdraw", "over_funding", "bad_amount"]
    assert (e["final"]["balance"], e["final"]["funding"]) == pytest.approx((1050, 150))


def test_binance_fees():
    t = final("B01_市价多单止盈_吃单进挂单出")["trades"][0]
    # 开仓 100000 + 0.01% 滑点 = 100010，吃单 0.05% = 5.0005；止盈 101000 挂单 0.02% = 2.02；毛利 (101000 − 100010) × 0.1 = 99
    assert t["fees"] == pytest.approx(5.0005 + 2.02)
    assert t["pnl"] == pytest.approx(99 - 7.0205)


def test_binance_limit_needs_one_tick_cross():
    f = final("B02_买入限价_仅触及不成交_穿过1格才成交")
    assert f["positions"][0]["open_ms"] == gen.BASE_MS + 2 * of.MINUTE_MS


def test_binance_maintenance_liquidation():
    f = final("B05_维持保证金强平")
    # 余额扣开仓手续费后 1000 − 12.50125；强平价 = (0.25 × 100010 − 987.49875) ÷ (0.25 × 0.996) = 96445.79
    assert f["liquidations"][0]["liquidation_price"] == pytest.approx(96445.788, abs=0.01)
    assert f["trades"][0]["pnl"] == pytest.approx(-1000)


def test_r_multiple():
    # E01：开仓 4200.30、止损 4190、0.1 手：风险 10.30 × 10 = 103；盈亏 −103.5 → −1.005R
    t = final("E01_市价多单_盘中止损")["trades"][0]
    assert of.r_multiple(t["pnl"], t["entry_price"], t["initial_sl"], t["qty"], XAU) == pytest.approx(-103.5 / 103)
    # E24：开仓时没设止损，后来设的保本止损（4200.30）就是第一次止损 → 风险 0 → 无 R
    t = final("E24_改止损止盈_保本_错误一侧被拒")["trades"][0]
    assert t["initial_sl"] == pytest.approx(4200.3)
    assert of.r_multiple(t["pnl"], t["entry_price"], t["initial_sl"], t["qty"], XAU) is None


def test_pending_orders_reserve_margin():
    # D60：100 美元、500 倍：买入限价 4195 × 0.1 手预占 10 × 4195 ÷ 500 = 83.9，可用只剩 16.1
    e = CASES["E29_挂单预占保证金_出金受限_撤单释放"]["expected"]
    assert [x["code"] for x in e["errors"]] == ["margin_insufficient", "over_withdraw"]
    assert e["final"]["balance"] == pytest.approx(80) and e["final"]["funding"] == pytest.approx(20)  # 撤单后出金 20 成功
    # 币安：100 USDT、30 倍：99000 × 0.03 ÷ 30 = 99 预占；再挂 0.001（98000 × 0.001 ÷ 30 = 3.27）不够；
    # 改单先放回自己的 99：改到 99500（需 99.5 ≤ 100）可以；改成 0.031（需 102.3）被拒；最后改到 98000（需 98）
    b = CASES["B08_币安挂单预占保证金"]["expected"]
    assert [x["code"] for x in b["errors"]] == ["margin_insufficient", "margin_insufficient"]
    assert [h["price"] for h in b["final"]["pending"][0]["history"]] == [99000, 99500]
    assert b["final"]["pending"][0]["price"] == 98000
    assert b["per_bar"][1]["pending_margin"] == pytest.approx(98000 * 0.03 / 30)  # 第 1 根之后：预占 98


def test_rejections():
    codes = [x["code"] for x in CASES["E28_低于最小手数与错误止损被拒"]["expected"]["errors"]]
    assert codes == ["below_min_qty", "stop_wrong_side", "tp_wrong_side"]
    assert CASES["B06_最小名义价值"]["expected"]["errors"][0]["code"] == "below_min_notional"
    assert CASES["E23_改挂单越过现价自动切换类型_撤单"]["expected"]["final"]["order_results"][0]["kind"] == "buy_stop"


def test_cases_file_matches_current_python_rules():
    rebuilt = gen.build()
    assert json.loads(json.dumps(rebuilt, ensure_ascii=False)) == json.loads(gen.OUT_FILE.read_text(encoding="utf-8"))
    assert len(rebuilt["cases"]) == 41
