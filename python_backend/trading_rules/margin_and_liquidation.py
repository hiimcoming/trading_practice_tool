# -*- coding: utf-8 -*-
"""
保证金、净值、真实杠杆、强平价、仓位换算（规格书 6.1、6.3、6.5、6.6 节，决策 D55）。

前端 web_frontend/src/trading_rules/margin_and_liquidation.ts 是同一份规则的 TypeScript 版，
两边用 tests/cross_check_cases/trading_cases.json 逐笔对账（CLAUDE.md 架构铁律 3）；改一边必须同时改另一边，
并且公式里的运算顺序也保持一致（浮点数换个顺序结果会差在最后一位）。

价格约定（D54，照 Exness 界面叫法）：
  - K 线价格 = 卖价（bid）；买价 = 卖价 + 点差（Exness 固定 0.25，币安为 0，只有一个价格）。
  - 多单平仓是「卖」，按卖价估值；空单平仓是「买」，按买价估值。
数量约定：qty 是手数（Exness）或币数（币安）；units = qty × 合约单位（盎司数 / 币数）。
仓位 position 是字典，至少有 direction（1 多 / -1 空）、qty、entry_price。

本模块属于 trading_rules/，不依赖项目内其他目录（品种档案以字典传入，来自 common_settings/market_specs.json）。
"""

from __future__ import annotations

import math

STEP_EPS = 1e-9  # 向下取整到步长时的容差：0.29999999999 这类浮点误差算作 0.3


def floor_to_step(x: float, step: float) -> float:
    """向下取整到步长的整数倍（规格书 15.2 节：手数、数量一律向下取整）。"""
    return math.floor(x / step + STEP_EPS) * step


def spread_of(spec: dict) -> float:
    """买价比卖价高多少（Exness 固定点差；币安 0）。"""
    return spec["cost"]["spread"] if spec["cost"]["model"] == "spread" else 0.0


def units_of(qty: float, spec: dict) -> float:
    return qty * spec["contract_size"]


def close_price(direction: int, bid: float, spec: dict) -> float:
    """平仓价（不含滑点）：多单按卖价，空单按买价。"""
    return bid if direction == 1 else bid + spread_of(spec)


def position_margin(qty: float, price: float, spec: dict, leverage: float) -> float:
    """一个仓位占用的保证金 = 名义价值 ÷ 杠杆（按开仓价算，开仓后不变）。"""
    return units_of(qty, spec) * price / leverage


def floating_pnl(position: dict, bid: float, spec: dict) -> float:
    """一个仓位不计平仓成本的浮动盈亏。"""
    p = close_price(position["direction"], bid, spec)
    return (p - position["entry_price"]) * position["direction"] * units_of(position["qty"], spec)


def used_margin(positions: list, spec: dict, leverage: float) -> float:
    total = 0.0
    for p in positions:
        total += position_margin(p["qty"], p["entry_price"], spec, leverage)
    return total


def pending_margin(pending: list, spec: dict, leverage: float) -> float:
    """挂单预占的保证金（D60：两个平台都在挂出时预占）= 每张挂单的 手数 × 合约单位 × 挂单价 ÷ 杠杆 之和。"""
    total = 0.0
    for o in pending:
        total += position_margin(o["qty"], o["price"], spec, leverage)
    return total


def equity_of(balance: float, positions: list, bid: float, spec: dict) -> float:
    """净值 = 余额 + 全部仓位的浮动盈亏。"""
    total = balance
    for p in positions:
        total += floating_pnl(p, bid, spec)
    return total


def maintenance_params(spec: dict, leverage: float) -> tuple:
    """强平公式里的 (m, 速算额)。Exness：m = 强平线 ÷ 杠杆；币安：m = 维持保证金率。"""
    if spec["platform"] == "exness":
        return spec.get("stop_out_level", 0.0) / leverage, 0.0
    return spec["maintenance_margin_rate"], spec.get("maintenance_amount", 0.0)


def liquidation_price(positions: list, balance: float, spec: dict, leverage: float):
    """
    全部仓位合并后的强平价（规格书 6.5 节；同一时间只有同方向仓位）。没有仓位、或多单永远不会被强平时返回 None。
    多单返回的是「卖价」触发价，空单返回的是「买价」触发价。
      多单：(Q × E − B − 速算额) ÷ (Q × (1 − m))
      空单：(Q × E + B + 速算额) ÷ (Q × (1 + m))
    Q = 总 units，E = 按 units 加权的开仓均价，B = 交易账户余额（已扣除已发生的手续费）。
    """
    if not positions:
        return None
    direction = positions[0]["direction"]
    q = 0.0
    qe = 0.0
    for p in positions:
        u = units_of(p["qty"], spec)
        q += u
        qe += u * p["entry_price"]
    m, amount = maintenance_params(spec, leverage)
    if direction == 1:
        price = (qe - balance - amount) / (q * (1 - m))
        return price if price > 0 else None
    return (qe + balance + amount) / (q * (1 + m))


def account_metrics(balance: float, positions: list, bid, spec: dict, leverage: float, pending=()) -> dict:
    """
    交易账户的各项显示数字（规格书 6.1 节）。bid 为 None（还没有价格）时只给余额。
    可用保证金 = 净值 − 持仓保证金 − 挂单预占保证金（D60）；保证金水平、强平价只看持仓（挂单没成交前不会亏钱）。
    """
    used = used_margin(positions, spec, leverage)
    reserved = pending_margin(list(pending), spec, leverage)
    if bid is None:
        return {"balance": balance, "equity": balance, "floating_pnl": 0.0, "used_margin": used,
                "pending_margin": reserved, "free_margin": balance - used - reserved, "margin_level": None,
                "real_leverage": 0.0, "liquidation_price": liquidation_price(positions, balance, spec, leverage)}
    equity = equity_of(balance, positions, bid, spec)
    notional = 0.0
    for p in positions:
        notional += units_of(p["qty"], spec) * bid
    return {
        "balance": balance,
        "equity": equity,
        "floating_pnl": equity - balance,
        "used_margin": used,
        "pending_margin": reserved,
        "free_margin": equity - used - reserved,
        "margin_level": equity / used if used > 0 else None,
        "real_leverage": notional / equity if equity > 0 else None,
        "liquidation_price": liquidation_price(positions, balance, spec, leverage),
    }


def max_withdraw(balance: float, free_margin: float) -> float:
    """出金上限 = min(余额, 可用保证金)：浮动盈利不能提走（规格书 6.6 节）。"""
    return max(0.0, min(balance, free_margin))


# ---------------- 仓位面板的换算（规格书 6.3 节；「按风险定仓位」要用成本规则，放在 order_fills_and_costs） ----------------

def qty_from_margin_ratio(equity: float, ratio: float, price: float, spec: dict, leverage: float) -> float:
    """按「占用净值的 X% 作保证金」换算数量，向下取整到步长。"""
    if price <= 0 or ratio <= 0 or equity <= 0:
        return 0.0
    raw = equity * ratio * leverage / (price * spec["contract_size"])
    return floor_to_step(raw, spec["qty_step"])


def pnl_per_price_unit(qty: float, spec: dict) -> float:
    """价格每变动 1 美元（1 USDT）的盈亏。"""
    return units_of(qty, spec)
