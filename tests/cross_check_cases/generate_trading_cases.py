# -*- coding: utf-8 -*-
"""
生成前后端交易规则的对账用例（规格书第 10 节第 4 阶段验收、CLAUDE.md 架构铁律 3）。

每个用例 = 手工构造的几根 1m K 线（卖价）+ 在第几根之前做什么操作（市价单、挂单、改单、平仓、出入金……）。
用 Python 的 trading_rules 跑一遍，把每根之后的账户数字和最终的全部记录（成交、交易、订单结果、出入金、强平）
写进 trading_cases.json 作为「标准答案」；前端测试（web_frontend/src/trading_rules/trading_cross_check.test.ts）
读同一个文件，用 TypeScript 再跑一遍逐项比对。Python 测试（tests/python_tests/test_trading_rules.py）另外
用手算的数字核对关键用例，并检查这个文件和当前 Python 规则一致（规则改了没重新生成会报错）。

动作里可以用 position_index / order_index 指「当时持仓列表 / 挂单列表里的第几个」，由跑用例的程序换成真实编号。
运行（项目根目录）：.venv/bin/python -m tests.cross_check_cases.generate_trading_cases
"""

from __future__ import annotations

import json
from pathlib import Path

from python_backend.trading_rules import order_fills_and_costs as of

ROOT = Path(__file__).resolve().parents[2]
OUT_FILE = Path(__file__).resolve().parent / "trading_cases.json"
SPECS_FILE = ROOT / "common_settings" / "market_specs.json"
BASE_MS = 1767225600000  # 2026-01-01 00:00 UTC，用例里的时刻只是编号，与真实行情无关
BUY, SELL = 1, -1


def load_specs() -> dict:
    return json.loads(SPECS_FILE.read_text(encoding="utf-8"))["markets"]


def resolve_refs(acc: of.TradingAccount, action: dict) -> dict:
    """把 position_index / order_index 换成真实编号（前端同名函数做同样的事）。"""
    a = {k: v for k, v in action.items() if k not in ("before_bar", "position_index", "order_index")}
    if "position_index" in action:
        a["position_id"] = acc.s["positions"][action["position_index"]]["id"]
    if "order_index" in action:
        a["order_id"] = acc.s["pending"][action["order_index"]]["id"]
    return a


def run_case(case: dict, spec: dict) -> dict:
    """跑一个用例：每根之前先做该根之前的操作，再处理这根（账户不在进行中就跳过这根）。"""
    acc = of.TradingAccount(of.new_account_state(case["symbol"], case["leverage"], case["balance"],
                                                 case["funding"], BASE_MS), spec)
    errors, per_bar, returned = [], [], []
    bars = case["bars"]
    for k in range(len(bars) + 1):
        for action in case["actions"]:
            if action["before_bar"] != k:
                continue
            try:
                returned.append(of.apply_action(acc, resolve_refs(acc, action)))
            except of.TradingRuleError as e:
                errors.append({"before_bar": k, "op": action["op"], "code": e.code})
        if k == len(bars):
            break
        if acc.s["status"] != "active":
            per_bar.append({"skipped": True, "status": acc.s["status"]})
            continue
        o, h, l, c = bars[k]
        acc.process_bar({"t": BASE_MS + k * of.MINUTE_MS, "o": o, "h": h, "l": l, "c": c})
        m = acc.metrics()
        per_bar.append({"balance": m["balance"], "equity": m["equity"], "used_margin": m["used_margin"],
                        "pending_margin": m["pending_margin"],
                        "free_margin": m["free_margin"], "real_leverage": m["real_leverage"],
                        "liquidation_price": m["liquidation_price"], "status": acc.s["status"]})
    return {"errors": errors, "returned": returned, "per_bar": per_bar, "final": acc.snapshot()}


def act(before_bar: int, op: str, **kw) -> dict:
    return {"before_bar": before_bar, "op": op, **kw}


def xau(name: str, note: str, bars: list, actions: list, balance=1000.0, funding=0.0, leverage=500) -> dict:
    return {"name": name, "note": note, "symbol": "XAUUSD", "leverage": leverage, "balance": balance,
            "funding": funding, "bars": bars, "actions": actions}


def btc(name: str, note: str, bars: list, actions: list, balance=1000.0, funding=0.0, leverage=30, symbol="BTCUSDT") -> dict:
    return {"name": name, "note": note, "symbol": symbol, "leverage": leverage, "balance": balance,
            "funding": funding, "bars": bars, "actions": actions}


FLAT = [4200, 4201, 4199, 4200]  # 第 0 根：只用来给出「现价」4200


def exness_cases() -> list:
    return [
        xau("E01_市价多单_盘中止损", "4200 买 0.1 手，止损 4190；第 2 根最低 4185 打到止损",
            [FLAT, [4200, 4202, 4195, 4196], [4196, 4197, 4185, 4186]],
            [act(1, "market", direction=BUY, qty=0.1, sl=4190)]),
        xau("E02_市价空单_盘中止盈", "4200 卖 0.1 手，止盈 4190（看买价）；最低 4189.75 时买价正好 4190",
            [FLAT, [4200, 4201, 4195, 4196], [4196, 4197, 4189.75, 4190]],
            [act(1, "market", direction=SELL, qty=0.1, tp=4190)]),
        xau("E03_同根止损止盈都碰到按止损", "多单止损 4190、止盈 4210，第 2 根 4185–4215 两边都碰到",
            [FLAT, [4200, 4201, 4199, 4200], [4200, 4215, 4185, 4200]],
            [act(1, "market", direction=BUY, qty=0.1, sl=4190, tp=4210)]),
        xau("E04_跳空止损", "多单止损 4190，第 2 根开盘 4185（跳空越过）按开盘价成交",
            [FLAT, [4200, 4201, 4199, 4200], [4185, 4186, 4180, 4182]],
            [act(1, "market", direction=BUY, qty=0.1, sl=4190, tp=4230)]),
        xau("E05_跳空止盈", "多单止盈 4210，第 2 根开盘 4215 按开盘价成交（更有利）",
            [FLAT, [4200, 4201, 4199, 4200], [4215, 4216, 4212, 4214]],
            [act(1, "market", direction=BUY, qty=0.1, sl=4180, tp=4210)]),
        xau("E06_部分平仓与剩余不足最小手数", "买 0.05；平 0.02；再平 0.025（向下取整成 0.02，剩 0.01 正好）；最后平剩余。手动平仓立即按当前收盘价成交（D57）",
            [FLAT, [4200, 4201, 4199, 4200], [4202, 4203, 4201, 4202], [4205, 4206, 4204, 4205], [4203, 4204, 4202, 4203]],
            [act(1, "market", direction=BUY, qty=0.05), act(2, "close", position_index=0, qty=0.02),
             act(3, "close", position_index=0, qty=0.025), act(4, "close", position_index=0)]),
        xau("E07_买入限价_触及即成交", "买入限价 4195（买价口径），第 1 根最低 4194.75 时买价正好 4195",
            [FLAT, [4200, 4201, 4194.75, 4198], [4198, 4199, 4197, 4198]],
            [act(1, "pending", direction=BUY, price=4195, qty=0.1)]),
        xau("E08_买入限价_跳空按开盘价", "买入限价 4195，第 1 根开盘 4190（买价 4190.25）直接成交在开盘",
            [FLAT, [4190, 4192, 4188, 4191]],
            [act(1, "pending", direction=BUY, price=4195, qty=0.1)]),
        xau("E09_卖出限价_触及与跳空", "卖出限价 4205 第 1 根最高正好 4205 成交；另一张 4215 第 3 根开盘 4220 跳空成交",
            [FLAT, [4200, 4205, 4199, 4203], [4203, 4204, 4202, 4203], [4220, 4221, 4218, 4219]],
            [act(1, "pending", direction=SELL, price=4205, qty=0.1), act(2, "close", position_index=0),
             act(3, "pending", direction=SELL, price=4215, qty=0.1)]),
        xau("E10_买入止损_触发加滑点与跳空", "买入止损 4205：第 1 根最高 4205 时买价 4205.25 触发，成交 4205.05；"
            "另一张 4230 第 3 根开盘 4240 跳空，按开盘买价 4240.25 + 滑点",
            [FLAT, [4200, 4205, 4199, 4204], [4204, 4206, 4203, 4205], [4240, 4241, 4239, 4240]],
            [act(1, "pending", direction=BUY, price=4205, qty=0.1), act(2, "close", position_index=0),
             act(3, "pending", direction=BUY, price=4230, qty=0.1)]),
        xau("E11_卖出止损_触发与跳空", "卖出止损 4195 第 1 根最低 4194 触发，成交 4194.95；另一张 4180 第 3 根开盘 4170 跳空",
            [FLAT, [4200, 4201, 4194, 4196], [4196, 4197, 4195, 4196], [4170, 4171, 4168, 4170]],
            [act(1, "pending", direction=SELL, price=4195, qty=0.1), act(2, "close", position_index=0),
             act(3, "pending", direction=SELL, price=4180, qty=0.1)]),
        xau("E12_成交根内碰到止损", "买入限价 4195 带止损 4190、止盈 4198；第 1 根 4189–4199：成交后同根止损（止盈本根不算）",
            [FLAT, [4200, 4200, 4189, 4192]],
            [act(1, "pending", direction=BUY, price=4195, qty=0.1, sl=4190, tp=4198)]),
        xau("E13_成交根内止盈下一根才算", "买入限价 4195 带止盈 4198；第 1 根 4194–4199 成交但止盈不算；第 2 根才止盈",
            [FLAT, [4200, 4200, 4194, 4197], [4197, 4199, 4196, 4198]],
            [act(1, "pending", direction=BUY, price=4195, qty=0.1, tp=4198)]),
        xau("E14_同根多张挂单按距离成交_保证金不足", "账户 200 美元：买入限价 4195 和 4190 各 0.1 手（各预占约 84，挂得上），"
            "同一根都触发：先成交近的 4195，之后浮亏使可用保证金不够，4190 成交时保证金不足未成交",
            [FLAT, [4200, 4200, 4187, 4192]],
            [act(1, "pending", direction=BUY, price=4190, qty=0.1), act(1, "pending", direction=BUY, price=4195, qty=0.1)],
            balance=200.0),
        xau("E15_反向挂单自动撤销_OCO", "上方买入止损 4210、下方卖出止损 4190；买单成交后卖单自动撤销",
            [FLAT, [4200, 4212, 4199, 4211], [4211, 4212, 4185, 4186]],
            [act(1, "pending", direction=BUY, price=4210, qty=0.1), act(1, "pending", direction=SELL, price=4190, qty=0.1)]),
        xau("E16_持多单时反向下单被拒", "持有多单：市价卖出被拒；持仓后挂的卖出限价触发时因持有反向仓位而撤销",
            [FLAT, [4200, 4201, 4199, 4200], [4200, 4206, 4199, 4204]],
            [act(1, "market", direction=BUY, qty=0.1), act(2, "pending", direction=SELL, price=4205, qty=0.1),
             act(2, "market", direction=SELL, qty=0.1)]),
        xau("E16b_待成交买单时市价卖出被拒", "同一根前先排队市价买入、再市价卖出：卖单当场被拒（D76，不等成交）",
            [FLAT, [4200, 4201, 4199, 4200]],
            [act(1, "market", direction=BUY, qty=0.1), act(1, "market", direction=SELL, qty=0.1)]),
        xau("E16c_同一根连下两笔市价买单", "两笔在同一根开盘同价成交，成为两个独立仓位；第一笔带止盈 4203，下一根碰到后只平这一笔",
            [FLAT, [4200, 4202, 4199, 4201], [4201, 4205, 4200, 4204]],
            [act(1, "market", direction=BUY, qty=0.1, tp=4203), act(1, "market", direction=BUY, qty=0.2)]),
        xau("E17_盘中强平_资金账户为0本轮结束", "1000 美元在 4200 买 1 手（保证金 840），强平价约 4190.3；第 2 根跌到 4180",
            [FLAT, [4200, 4201, 4199, 4200], [4200, 4201, 4180, 4185], [4185, 4186, 4184, 4185]],
            [act(1, "market", direction=BUY, qty=1.0), act(1, "pending", direction=BUY, price=4150, qty=0.01)]),
        xau("E18_强平后暂停_转入后继续", "资金账户 500：强平后暂停（第 3 根跳过），转入 300 后继续交易并盈利",
            [FLAT, [4200, 4201, 4199, 4200], [4200, 4201, 4180, 4185], [4185, 4186, 4184, 4185],
             [4185, 4186, 4184, 4185], [4185, 4195, 4184, 4194]],
            [act(1, "market", direction=BUY, qty=1.0), act(4, "transfer", direction="to_trading", amount=300.0),
             act(4, "market", direction=BUY, qty=0.1, tp=4190)],
            funding=500.0),
        xau("E19_跳空强平_负余额保护", "持 1 手多单，周末式跳空开在 4150（远低于强平价），按开盘价强平，余额不为负",
            [FLAT, [4200, 4201, 4199, 4200], [4150, 4152, 4148, 4150]],
            [act(1, "market", direction=BUY, qty=1.0)]),
        xau("E20_止损比强平近_先止损不强平", "1 手多单止损 4195（强平价约 4190.3），第 2 根跌到 4185：先止损，之后无仓位不强平",
            [FLAT, [4200, 4201, 4199, 4200], [4200, 4201, 4185, 4190]],
            [act(1, "market", direction=BUY, qty=1.0, sl=4195)]),
        xau("E21_强平与止盈同根按强平", "1 手多单止盈 4205，第 2 根 4180–4206 两边都碰到：按强平",
            [FLAT, [4200, 4201, 4199, 4200], [4200, 4206, 4180, 4190]],
            [act(1, "market", direction=BUY, qty=1.0, tp=4205)]),
        xau("E22_出入金规则", "资金账户 200：转入 100（余额 1100）；多单浮盈 97 时出金 1105 被拒（超过余额，浮盈不能提）；出金 50；资金不足转入被拒；负数被拒",
            [FLAT, [4200, 4201, 4199, 4200], [4210, 4211, 4209, 4210]],
            [act(1, "transfer", direction="to_trading", amount=100.0), act(1, "market", direction=BUY, qty=0.1),
             act(3, "transfer", direction="to_funding", amount=1105.0), act(3, "transfer", direction="to_funding", amount=50.0),
             act(3, "transfer", direction="to_trading", amount=500.0), act(3, "transfer", direction="to_funding", amount=-5.0)],
            funding=200.0),
        xau("E23_改挂单越过现价自动切换类型_撤单", "买入限价 4195 改到 4210 → 自动变成买入止损；再撤单；另挂一张价位等于买价被拒",
            [FLAT, [4200, 4201, 4199, 4200]],
            [act(1, "pending", direction=BUY, price=4195, qty=0.1),
             act(1, "modify_pending", order_index=0, price=4210, qty=0.2, sl=4200),
             act(1, "cancel_pending", order_index=0), act(1, "pending", direction=BUY, price=4200.25, qty=0.1)]),
        xau("E24_改止损止盈_保本_错误一侧被拒", "多单开在 4200.30：现价 4200 时止损设 4205 被拒；涨到 4203 后止损移到开仓价（保本），第 3 根跌到 4199 被打到",
            [FLAT, [4200, 4201, 4199, 4200], [4203, 4204, 4202, 4203], [4203, 4204, 4199, 4200], [4200, 4201, 4199, 4200]],
            [act(1, "market", direction=BUY, qty=0.1), act(2, "set_stops", position_index=0, sl=4205.0),
             act(3, "set_stops", position_index=0, sl=4200.3, tp=None)]),
        xau("E25_结束本轮按现价全平并撤挂单", "持多单和一张挂单，结束本轮：按最后收盘 4206 全平，挂单撤销",
            [FLAT, [4200, 4201, 4199, 4200], [4200, 4207, 4199, 4206]],
            [act(1, "market", direction=BUY, qty=0.1), act(2, "pending", direction=BUY, price=4190, qty=0.1),
             act(3, "close_all")]),
        xau("E26_空单强平看买价", "空单 1 手开在 4199.95，强平价（买价口径）4209.95；最高 4209.80 时买价 4210.05 越过强平价",
            [FLAT, [4200, 4201, 4199, 4200], [4200, 4209.80, 4199, 4205], [4205, 4206, 4204, 4205]],
            [act(1, "market", direction=SELL, qty=1.0)]),
        xau("E27_加仓合并强平价_止损跳空空单", "空单两笔（0.3 + 0.2 手）合并强平价；第二笔止损 4210（看买价），第 3 根开盘 4212 跳空止损",
            [FLAT, [4200, 4201, 4199, 4200], [4198, 4199, 4197, 4198], [4212, 4213, 4211, 4212]],
            [act(1, "market", direction=SELL, qty=0.3), act(2, "market", direction=SELL, qty=0.2, sl=4210)]),
        xau("E29_挂单预占保证金_出金受限_撤单释放", "账户 100 美元（D60）：买入限价 4195 0.1 手预占 83.9；再挂一张被拒（可用只剩 16.1）；"
            "出金 20 被拒；撤单后出金 20 成功",
            [FLAT, [4200, 4201, 4199, 4200]],
            [act(1, "pending", direction=BUY, price=4195, qty=0.1), act(1, "pending", direction=BUY, price=4190, qty=0.1),
             act(1, "transfer", direction="to_funding", amount=20.0), act(1, "cancel_pending", order_index=0),
             act(1, "transfer", direction="to_funding", amount=20.0)],
            balance=100.0),
        xau("E28_低于最小手数与错误止损被拒", "0.005 手（低于 0.01）被拒；多单止损高于现价被拒；空单止盈高于现价被拒",
            [FLAT],
            [act(1, "market", direction=BUY, qty=0.005), act(1, "market", direction=BUY, qty=0.1, sl=4201),
             act(1, "market", direction=SELL, qty=0.1, tp=4210)]),
    ]


BFLAT = [100000, 100050, 99950, 100000]


def binance_cases() -> list:
    return [
        btc("B01_市价多单止盈_吃单进挂单出", "100000 买 0.1 BTC：开仓吃单 0.05% + 滑点 0.01%；止盈 101000 按挂单 0.02%、不计滑点",
            [BFLAT, [100000, 100100, 99900, 100050], [100050, 101200, 100000, 101100]],
            [act(1, "market", direction=BUY, qty=0.1, tp=101000)]),
        btc("B02_买入限价_仅触及不成交_穿过1格才成交", "买入限价 99000：第 1 根最低正好 99000 不成交；第 2 根最低 98999.9 成交",
            [BFLAT, [100000, 100010, 99000, 99500], [99500, 99600, 98999.9, 99100]],
            [act(1, "pending", direction=BUY, price=99000, qty=0.01)]),
        btc("B03_卖出限价穿过与跳空", "卖出限价 101000：最高 101000.1 成交；另一张 102000 第 3 根开盘 102500 跳空按开盘",
            [BFLAT, [100000, 101000.1, 99990, 100900], [100900, 100950, 100800, 100900], [102500, 102600, 102400, 102500]],
            [act(1, "pending", direction=SELL, price=101000, qty=0.01), act(2, "close", position_index=0),
             act(3, "pending", direction=SELL, price=102000, qty=0.01)]),
        btc("B04_止损挂单百分比滑点", "卖出止损 99500 触发，成交价 = 99500 × (1 − 0.01%)；之后止损 100000（空单）被打到",
            [BFLAT, [99800, 99850, 99400, 99600], [99600, 100100, 99550, 100050]],
            [act(1, "pending", direction=SELL, price=99500, qty=0.01, sl=100000)]),
        btc("B05_维持保证金强平", "1000 USDT 在 100000 买 0.25 BTC（30 倍，保证金 833），维持保证金率 0.4%；第 2 根跌到 95000 强平",
            [BFLAT, [100000, 100010, 99990, 100000], [100000, 100010, 95000, 96000]],
            [act(1, "market", direction=BUY, qty=0.25)]),
        btc("B06_最小名义价值", "价格 40000 时 0.001 BTC = 40 USDT，低于最小名义价值 50 被拒；0.002 可以",
            [[40000, 40010, 39990, 40000], [40000, 40010, 39990, 40000]],
            [act(1, "market", direction=BUY, qty=0.001), act(1, "market", direction=BUY, qty=0.002)]),
        btc("B08_币安挂单预占保证金", "100 USDT、30 倍（D60）：买入限价 99000 0.03 BTC 预占 99；再挂 0.001 BTC 被拒；"
            "改单时先放回自己的预占：改到 99500（需 99.5）可以，改成 0.031 BTC（需 102.3）被拒，最后改到 98000",
            [BFLAT, [100000, 100010, 99990, 100000]],
            [act(1, "pending", direction=BUY, price=99000, qty=0.03), act(1, "pending", direction=BUY, price=98000, qty=0.001),
             act(1, "modify_pending", order_index=0, price=99500, qty=0.03), act(1, "modify_pending", order_index=0, price=99000, qty=0.031),
             act(1, "modify_pending", order_index=0, price=98000, qty=0.03)],
            balance=100.0),
        btc("B07_空单市价止损", "100000 卖 0.05 BTC 止损 101000；第 2 根最高 101500 打到止损，成交 101000 × (1 + 0.01%)",
            [BFLAT, [100000, 100100, 99900, 100000], [100000, 101500, 99950, 101200]],
            [act(1, "market", direction=SELL, qty=0.05, sl=101000)]),
        btc("B09_改杠杆只在空仓无挂单时", "30 倍开局，第 1 根前改成 10 倍再买 0.05 BTC（保证金 500）；同一时刻再改杠杆被拒（市价单还在排队）；"
            "第 2 根前持仓中改杠杆被拒；平仓后改 50 倍、改 200 倍被拒（最高 150）；再买 0.05（保证金 100）；"
            "第 3 根前平仓后挂一张限价单，有挂单时改杠杆被拒（D72）",
            [BFLAT, [100000, 100010, 99990, 100000], [100000, 100010, 99990, 100000], [100000, 100010, 99990, 100000]],
            [act(1, "set_leverage", leverage=10), act(1, "market", direction=BUY, qty=0.05), act(1, "set_leverage", leverage=20),
             act(2, "set_leverage", leverage=50), act(2, "close", position_index=0), act(2, "set_leverage", leverage=50),
             act(2, "set_leverage", leverage=200), act(2, "market", direction=BUY, qty=0.05),
             act(3, "close", position_index=0), act(3, "pending", direction=BUY, price=99000, qty=0.01), act(3, "set_leverage", leverage=20)]),
        btc("B10_ETH_价格两位小数_最小名义价值20", "ETHUSDT：价格 4000 时 0.004 ETH = 16 USDT 低于 20 被拒，0.005 ETH = 20 可以；"
            "买入限价 3999.99 要穿过 1 格（0.01）才成交：第 1 根最低正好 3999.99 不成交、第 2 根最低 3999.98 成交",
            [[4000, 4000.5, 3999.5, 4000], [4000, 4001, 3999.99, 4000], [4000, 4001, 3999.98, 4000]],
            [act(1, "market", direction=BUY, qty=0.004), act(1, "market", direction=BUY, qty=0.005),
             act(1, "pending", direction=BUY, price=3999.99, qty=0.006)],
            symbol="ETHUSDT"),
    ]


def build() -> dict:
    specs = load_specs()
    cases = []
    for case in exness_cases() + binance_cases():
        case["expected"] = run_case(case, specs[case["symbol"]])
        cases.append(case)
    return {"_说明": "由 generate_trading_cases.py 生成，不要手改；前后端交易规则逐项对账用", "base_ms": BASE_MS,
            "cases": cases}


def main():
    data = build()
    OUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"[对账用例] 已写入 {OUT_FILE.name}：{len(data['cases'])} 个用例")


if __name__ == "__main__":
    main()
