# -*- coding: utf-8 -*-
"""
交易账户、订单、逐根 1m 成交与成本（规格书 6.1、6.2、6.6、6.7、15.2、15.3 节，决策 D53–D55）。

成本规则复制自 CryptoTrade/core/cost_models.py（2026-10-21 复制后改写），止损止盈判断顺序复制自
CryptoTrade/backtest/engine.py 的 _stop_or_tp。与 CryptoTrade 的不同：
  - 点差、滑点直接算进成交价（照 MT5：多单开在买价 = 卖价 + 点差，再加滑点），手续费在成交那一刻从余额扣除，
    这样强平公式里的「余额已扣除已发生的成本」才成立；每笔成交另记点差、滑点、手续费各多少，留给报告。
  - 爆仓按强平价成交（跳空越过按开盘价），而不是按整根最差价；强平后交易账户清零（D55）。
前端 web_frontend/src/trading_rules/order_fills_and_costs.ts 是同一份规则，两边用
tests/cross_check_cases/trading_cases.json 逐笔对账；改一边必须同时改另一边，运算顺序也保持一致。

每根 1m 的处理顺序（process_bar）：
  ① 开盘：已有仓位的跳空止损 → 跳空止盈（按开盘价成交）；
  ② 开盘：开盘价已越过强平价 → 按开盘价强平；
  ③ 开盘：排队的市价开仓（检查反向仓位、保证金）；
  ④ 盘中：止损、强平、挂单触发、止盈，按「离开盘价近的先发生」依次处理（同距离：止损 → 强平 → 挂单 → 止盈）；
     同一仓位同根碰到止损和止盈按止损；同根碰到强平时这一根的止盈都不算（保守）；
     本根刚成交的仓位，止损本根就判断，止盈从下一根才判断（规格书 6.7 节）。
手动平仓（全部或部分）不排队：立即按当前价格（最后一根 1m 的收盘）成交，时间不走（D57）。
改杠杆（D72，下单面板上用，第一版只给币安）：只有空仓、没有挂单、没有排队的市价单时才能改，所以已有的保证金、强平价、
  止损金额都不受影响，只改之后开仓的保证金占用；和其他操作一样记进事件日志，服务器复算照样重放。
价格叫法（D54）：K 线价格 = 卖价（bid），买价 = 卖价 + 点差。

本模块属于 trading_rules/，只依赖同目录的 margin_and_liquidation。
"""

from __future__ import annotations

import copy

from python_backend.trading_rules import margin_and_liquidation as ml

MINUTE_MS = 60_000
QTY_EPS = 1e-9
PRIORITY = {"stop": 0, "liquidation": 1, "pending": 2, "tp": 3}


class TradingRuleError(Exception):
    """下单 / 改单 / 出入金不合法。code 是固定的英文代号（前后端一致），message 是给用户看的中文原因。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------- 成本（来源：CryptoTrade/core/cost_models.py，2026-10-21 复制后改写） ----------------

def fee_rate(spec: dict, maker: bool) -> float:
    """币安按名义价值收的费率（挂单 / 吃单）；Exness 没有按比例的手续费。"""
    if spec["cost"]["model"] == "pct":
        return spec["cost"]["maker"] if maker else spec["cost"]["taker"]
    return 0.0


def slippage_amount(spec: dict, base_price: float) -> float:
    """一次吃单成交的滑点（价格差）。abs：固定价差；pct：成交价的百分比。"""
    s = spec["slippage"]
    if s["kind"] == "abs":
        return s["value"]
    if s["kind"] == "pct":
        return base_price * s["value"]
    raise ValueError(f"[成本] 不支持的滑点类型 {s['kind']!r}（可选 pct / abs）")


def fill_fee(spec: dict, qty: float, price: float, maker: bool) -> float:
    """一次成交的手续费：币安 = 名义价值 × 费率；Exness = 每手每边佣金 × 手数（档案里为 0）。"""
    if spec["cost"]["model"] == "pct":
        return price * ml.units_of(qty, spec) * fee_rate(spec, maker)
    return spec["cost"].get("commission_per_lot_side", 0.0) * qty


def taker_fill(direction_of_fill: int, base_price: float, spec: dict) -> tuple:
    """吃单成交：买入在 base 上加滑点，卖出减滑点。返回 (成交价, 滑点)。base 已是该方向的价格（买价或卖价）。"""
    slip = slippage_amount(spec, base_price)
    return (base_price + slip if direction_of_fill == 1 else base_price - slip), slip


def loss_per_unit_at_stop(direction: int, entry_price: float, stop_price: float, spec: dict) -> float:
    """每 1 个 unit 在止损被打到时亏多少（含止损成交的滑点和两边手续费，「按风险定仓位」不低估亏损）。"""
    exit_price, _ = taker_fill(-direction, stop_price, spec)
    rate = fee_rate(spec, maker=False)
    return (entry_price - exit_price) * direction + entry_price * rate + exit_price * rate


def qty_from_risk(equity: float, risk_ratio: float, direction: int, entry_price: float, stop_price: float,
                  spec: dict) -> float:
    """按「止损被打到最多亏净值的 X%」换算数量（规格书 6.3 节），向下取整到步长；止损在错误一侧返回 0。"""
    if equity <= 0 or risk_ratio <= 0:
        return 0.0
    per_unit = loss_per_unit_at_stop(direction, entry_price, stop_price, spec)
    if per_unit <= 0:
        return 0.0
    return ml.floor_to_step(equity * risk_ratio / (per_unit * spec["contract_size"]), spec["qty_step"])


def r_multiple(pnl: float, entry_price: float, initial_sl, qty: float, spec: dict):
    """R 倍数 = 盈亏 ÷ 第一次设止损时的风险（|开仓价 − 止损| × 数量）；没设过止损返回 None（规格书 5.8 节）。"""
    if initial_sl is None:
        return None
    risk = abs(entry_price - initial_sl) * ml.units_of(qty, spec)
    return pnl / risk if risk > 0 else None


def classify_pending(direction: int, price: float, bid: float, spec: dict) -> str:
    """挂单类型自动判断（规格书 6.7 节）：买单低于买价为限价、高于为止损；卖单高于卖价为限价、低于为止损。"""
    market = bid + ml.spread_of(spec) if direction == 1 else bid
    if price == market:
        raise TradingRuleError("price_equals_market", "挂单价不能等于现价")
    if direction == 1:
        return "limit" if price < market else "stop"
    return "limit" if price > market else "stop"


def pending_name(direction: int, kind: str) -> str:
    return ("buy_" if direction == 1 else "sell_") + kind


# ---------------- 交易账户 ----------------

def new_account_state(symbol: str, leverage: float, balance: float, funding: float, now_ms: int) -> dict:
    """新开一轮时的账户状态（可直接存成 JSON，断点续练原样恢复）。"""
    return {
        "symbol": symbol, "leverage": leverage, "balance": balance, "funding": funding,
        "status": "active", "last_bid": None, "now_ms": now_ms, "next_id": 1,
        "positions": [], "pending": [], "queue": [],
        "trades": [], "fills": [], "order_results": [], "transfers": [], "liquidations": [],
    }


class TradingAccount:
    """一轮练习的交易账户。state 是可序列化的字典；spec 是该品种的档案（market_specs.json）。"""

    def __init__(self, state: dict, spec: dict):
        self.s = state
        self.spec = spec
        self.spread = ml.spread_of(spec)

    # ---------- 查询 ----------
    def metrics(self) -> dict:
        return ml.account_metrics(self.s["balance"], self.s["positions"], self.s["last_bid"], self.spec,
                                  self.s["leverage"], self.s["pending"])

    def snapshot(self) -> dict:
        return copy.deepcopy(self.s)

    def _new_id(self) -> int:
        i = self.s["next_id"]
        self.s["next_id"] = i + 1
        return i

    def _position(self, position_id: int) -> dict:
        for p in self.s["positions"]:
            if p["id"] == position_id:
                return p
        raise TradingRuleError("no_position", "找不到这个仓位（可能已经平仓）")

    def _pending(self, order_id: int) -> dict:
        for o in self.s["pending"]:
            if o["id"] == order_id:
                return o
        raise TradingRuleError("no_order", "找不到这张挂单（可能已经成交或撤销）")

    # ---------- 合法性检查（规格书 15.2、15.3 节） ----------
    def _require_active(self):
        if self.s["status"] != "active":
            raise TradingRuleError("not_active", "强平后暂停中或本轮已结束，不能交易")
        if self.s["last_bid"] is None:
            raise TradingRuleError("no_price", "还没有价格，不能交易")

    def _check_qty(self, qty: float, price: float) -> float:
        q = ml.floor_to_step(qty, self.spec["qty_step"])
        if q < self.spec["min_qty"] - QTY_EPS:
            raise TradingRuleError("below_min_qty", f"低于最小下单量 {self.spec['min_qty']}")
        if ml.units_of(q, self.spec) * price < self.spec.get("min_notional", 0.0):
            raise TradingRuleError("below_min_notional", f"名义价值低于最小值 {self.spec['min_notional']}")
        return q

    def _check_stops(self, direction: int, ref: float, sl, tp):
        """止损止盈必须在正确一侧。ref：市价单 / 持仓用现在的平仓价，挂单用挂单价。"""
        if sl is not None and (ref - sl) * direction <= 0:
            raise TradingRuleError("stop_wrong_side", "止损在错误的一侧" + ("（多单止损要低于现价）" if direction == 1 else "（空单止损要高于现价）"))
        if tp is not None and (tp - ref) * direction <= 0:
            raise TradingRuleError("tp_wrong_side", "止盈在错误的一侧" + ("（多单止盈要高于现价）" if direction == 1 else "（空单止盈要低于现价）"))

    def _check_pending_margin(self, qty: float, price: float, exclude_id=None):
        """挂单要预占保证金（D60）：可用保证金（已扣其他挂单的预占）不够这张单的保证金就挂不上。"""
        others = [o for o in self.s["pending"] if o["id"] != exclude_id]
        m = ml.account_metrics(self.s["balance"], self.s["positions"], self.s["last_bid"], self.spec,
                               self.s["leverage"], others)
        need = ml.position_margin(qty, price, self.spec, self.s["leverage"])
        if m["free_margin"] < need:
            raise TradingRuleError("margin_insufficient", f"可用保证金不够（挂单要预占 {need:.2f}，可用 {m['free_margin']:.2f}）")

    def _check_no_opposite(self, direction: int):
        if any(p["direction"] != direction for p in self.s["positions"]):
            raise TradingRuleError("opposite_position", "已持有反向仓位，第一版不允许锁仓")

    def _check_no_opposite_queued(self, direction: int):
        """D76：还有反向的市价单在排队等成交时，当场拒绝（原来要等成交时才拒，结果一样，只是提前告诉用户）。"""
        if any(q["direction"] != direction for q in self.s["queue"]):
            raise TradingRuleError("opposite_position", "已有反向的市价单在等成交，第一版不允许锁仓")

    # ---------- 用户操作（发生在两根 1m 之间，时刻 = now_ms） ----------
    def place_market(self, direction: int, qty: float, sl=None, tp=None) -> int:
        """市价单：排队，到下一根 1m 开盘成交（D53）。"""
        self._require_active()
        self._check_no_opposite(direction)
        self._check_no_opposite_queued(direction)
        bid = self.s["last_bid"]
        q = self._check_qty(qty, bid)
        self._check_stops(direction, ml.close_price(direction, bid, self.spec), sl, tp)
        oid = self._new_id()
        self.s["queue"].append({"id": oid, "op": "open", "direction": direction, "qty": q, "sl": sl, "tp": tp,
                                "placed_ms": self.s["now_ms"]})
        return oid

    def close_position(self, position_id: int, qty=None) -> int:
        """手动平仓（全部或部分）：立即按当前价格（最后一根 1m 收盘）吃单 + 滑点成交，时间不走（D57）。
        剩余低于最小手数时直接全平（15.2 节）。"""
        self._require_active()
        p = self._position(position_id)
        q = p["qty"] if qty is None else ml.floor_to_step(qty, self.spec["qty_step"])
        if q <= QTY_EPS:
            raise TradingRuleError("below_min_qty", "平仓数量太小")
        if q > p["qty"] - self.spec["min_qty"] + QTY_EPS:
            q = p["qty"]
        oid = self._new_id()
        ms = self.s["now_ms"]
        base = ml.close_price(p["direction"], self.s["last_bid"], self.spec)
        price, slip = taker_fill(-p["direction"], base, self.spec)
        self._close_part(p, q, price, slip, False, "manual", ms, oid)
        self._result(oid, "close", "filled", ms, position_id)
        return oid

    def place_pending(self, direction: int, price: float, qty: float, sl=None, tp=None) -> int:
        """挂单：类型按价位自动判断（买入/卖出 × 限价/止损），从下一根 1m 开始判断成交。"""
        self._require_active()
        kind = classify_pending(direction, price, self.s["last_bid"], self.spec)
        q = self._check_qty(qty, price)
        self._check_stops(direction, price, sl, tp)
        self._check_pending_margin(q, price)
        oid = self._new_id()
        self.s["pending"].append({"id": oid, "direction": direction, "kind": kind, "price": price, "qty": q,
                                  "sl": sl, "tp": tp, "placed_ms": self.s["now_ms"], "history": []})
        return oid

    def modify_pending(self, order_id: int, price: float, qty: float, sl=None, tp=None):
        """改挂单（价位、数量、止损止盈都给最终值）；价位越过现价时类型自动切换，方向不变。"""
        self._require_active()
        o = self._pending(order_id)
        kind = classify_pending(o["direction"], price, self.s["last_bid"], self.spec)
        q = self._check_qty(qty, price)
        self._check_stops(o["direction"], price, sl, tp)
        self._check_pending_margin(q, price, exclude_id=order_id)
        o["history"].append({"ms": self.s["now_ms"], "kind": o["kind"], "price": o["price"], "qty": o["qty"],
                             "sl": o["sl"], "tp": o["tp"]})
        o.update({"kind": kind, "price": price, "qty": q, "sl": sl, "tp": tp})

    def cancel_pending(self, order_id: int):
        o = self._pending(order_id)
        self._drop_pending(o, "cancelled")

    def set_position_stops(self, position_id: int, sl=None, tp=None):
        """改持仓的止损止盈（给最终值，None = 取消）；移到保本就是把止损设为开仓价。"""
        self._require_active()
        p = self._position(position_id)
        self._check_stops(p["direction"], ml.close_price(p["direction"], self.s["last_bid"], self.spec), sl, tp)
        if p["initial_sl"] is None and sl is not None:
            p["initial_sl"] = sl  # 第一次设的止损，算 R 倍数用
        p["sl"] = sl
        p["tp"] = tp

    def transfer(self, direction: str, amount: float):
        """出入金（规格书 6.6 节）。to_funding：交易账户 → 资金账户；to_trading：资金账户 → 交易账户。"""
        if amount <= 0:
            raise TradingRuleError("bad_amount", "金额必须大于 0")
        m = self.metrics()
        if direction == "to_funding":
            limit = ml.max_withdraw(self.s["balance"], m["free_margin"])
            if amount > limit + 1e-9:
                raise TradingRuleError("over_withdraw", f"最多可转出 {limit:.2f}（浮动盈利不能转出）")
            self.s["balance"] -= amount
            self.s["funding"] += amount
        elif direction == "to_trading":
            if amount > self.s["funding"] + 1e-9:
                raise TradingRuleError("over_funding", f"资金账户只有 {self.s['funding']:.2f}")
            self.s["funding"] -= amount
            self.s["balance"] += amount
            if self.s["status"] == "liquidated_paused":
                self.s["status"] = "active"
        else:
            raise TradingRuleError("bad_direction", "未知的划转方向")
        self.s["transfers"].append({"ms": self.s["now_ms"], "direction": direction, "amount": amount,
                                    "equity_before": m["equity"], "had_positions": bool(self.s["positions"])})

    def set_leverage(self, leverage: float):
        """改平台杠杆（D72）：空仓、没有挂单、没有排队的市价单时才能改；范围按品种档案的 leverage.min–max。"""
        if self.s["positions"] or self.s["pending"] or self.s["queue"]:
            raise TradingRuleError("leverage_busy", "有持仓、挂单或还没成交的市价单时不能改杠杆（先平仓、撤单）")
        lo, hi = self.spec["leverage"]["min"], self.spec["leverage"]["max"]
        if not lo <= leverage <= hi:
            raise TradingRuleError("bad_leverage", f"杠杆要在 {lo:g}–{hi:g} 倍之间")
        self.s["leverage"] = leverage

    def close_all_now(self, reason: str = "end_of_round"):
        """结束本轮：按现价（最后一根 1m 的收盘）全部市价平仓，撤销全部挂单和排队（D26）。"""
        bid = self.s["last_bid"]
        ms = self.s["now_ms"]
        for p in list(self.s["positions"]):
            base = ml.close_price(p["direction"], bid, self.spec)
            price, slip = taker_fill(-p["direction"], base, self.spec)
            self._close_part(p, p["qty"], price, slip, False, reason, ms)
        for o in list(self.s["pending"]):
            self._drop_pending(o, "cancelled_end_of_round")
        for q in self.s["queue"]:
            self._result(q["id"], q["op"], "cancelled_end_of_round", ms)
        self.s["queue"] = []

    # ---------- 记账 ----------
    def _result(self, order_id: int, kind: str, result: str, ms: int, position_id=None):
        self.s["order_results"].append({"order_id": order_id, "kind": kind, "result": result, "ms": ms,
                                        "position_id": position_id})

    def _drop_pending(self, o: dict, result: str):
        self.s["pending"].remove(o)
        self._result(o["id"], pending_name(o["direction"], o["kind"]), result, self.s["now_ms"])

    def _record_fill(self, p: dict, action: str, reason: str, qty: float, price: float, fee: float,
                     spread_cost: float, slip_cost: float, gross: float, ms: int, order_id=None):
        self.s["fills"].append({
            "seq": len(self.s["fills"]) + 1, "ms": ms, "position_id": p["id"], "order_id": order_id,
            "action": action, "reason": reason, "direction": p["direction"], "qty": qty, "price": price,
            "fee": fee, "spread_cost": spread_cost, "slippage_cost": slip_cost, "gross": gross})

    def _open_position(self, order_id: int, source: str, direction: int, qty: float, price: float, slip: float,
                       maker: bool, sl, tp, ms: int) -> dict:
        units = ml.units_of(qty, self.spec)
        fee = fill_fee(self.spec, qty, price, maker)
        spread_cost = self.spread * units if direction == 1 else 0.0
        slip_cost = slip * units
        self.s["balance"] -= fee
        p = {"id": self._new_id(), "order_id": order_id, "source": source, "direction": direction, "qty": qty,
             "initial_qty": qty, "entry_price": price, "sl": sl, "tp": tp, "initial_sl": sl, "open_ms": ms,
             "realized_gross": 0.0, "fees": fee, "spread_cost": spread_cost, "slippage_cost": slip_cost,
             "exits": []}
        self.s["positions"].append(p)
        self._record_fill(p, "open", source, qty, price, fee, spread_cost, slip_cost, 0.0, ms, order_id)
        self._result(order_id, source, "filled", ms, p["id"])
        return p

    def _close_part(self, p: dict, qty: float, price: float, slip: float, maker: bool, reason: str, ms: int,
                    order_id=None):
        """平掉一个仓位的 qty（全部或部分）；平完时生成一笔交易记录并返回它，否则返回 None。"""
        units = ml.units_of(qty, self.spec)
        gross = (price - p["entry_price"]) * p["direction"] * units
        fee = fill_fee(self.spec, qty, price, maker)
        spread_cost = self.spread * units if p["direction"] == -1 else 0.0
        slip_cost = slip * units
        self.s["balance"] += gross - fee
        p["qty"] -= qty
        p["realized_gross"] += gross
        p["fees"] += fee
        p["spread_cost"] += spread_cost
        p["slippage_cost"] += slip_cost
        p["exits"].append({"ms": ms, "qty": qty, "price": price, "reason": reason})
        self._record_fill(p, "close", reason, qty, price, fee, spread_cost, slip_cost, gross, ms, order_id)
        if p["qty"] > QTY_EPS:
            return None
        return self._finish_trade(p, reason, ms)

    def _finish_trade(self, p: dict, reason: str, ms: int) -> dict:
        self.s["positions"].remove(p)
        exit_value = 0.0
        for e in p["exits"]:
            exit_value += e["qty"] * e["price"]
        trade = {"position_id": p["id"], "order_id": p["order_id"], "source": p["source"],
                 "direction": p["direction"], "qty": p["initial_qty"], "entry_price": p["entry_price"],
                 "open_ms": p["open_ms"], "close_ms": ms, "exit_price_avg": exit_value / p["initial_qty"],
                 "close_reason": reason, "gross": p["realized_gross"], "fees": p["fees"],
                 "spread_cost": p["spread_cost"], "slippage_cost": p["slippage_cost"], "liquidation_adjust": 0.0,
                 "pnl": p["realized_gross"] - p["fees"], "sl_at_close": p["sl"], "tp_at_close": p["tp"],
                 "initial_sl": p["initial_sl"],
                 "exits": p["exits"]}
        self.s["trades"].append(trade)
        return trade

    def _can_afford(self, qty: float, price: float, ref_bid: float, maker: bool) -> bool:
        """成交那一刻：可用保证金（扣除其余挂单的预占，D60）≥ 这笔的保证金 + 手续费。成交的这张挂单此时已移出挂单列表。"""
        equity = ml.equity_of(self.s["balance"], self.s["positions"], ref_bid, self.spec)
        free = (equity - ml.used_margin(self.s["positions"], self.spec, self.s["leverage"])
                - ml.pending_margin(self.s["pending"], self.spec, self.s["leverage"]))
        need = ml.position_margin(qty, price, self.spec, self.s["leverage"]) + fill_fee(self.spec, qty, price, maker)
        return free >= need

    def _try_open(self, order_id: int, source: str, direction: int, qty: float, price: float, slip: float,
                  maker: bool, sl, tp, ref_bid: float, ms: int):
        """开仓前检查反向仓位和保证金；成交后撤销反向挂单（OCO）。成交返回新仓位，否则返回 None。"""
        if any(p["direction"] != direction for p in self.s["positions"]):
            self._result(order_id, source, "opposite_position", ms)
            return None
        if not self._can_afford(qty, price, ref_bid, maker):
            self._result(order_id, source, "margin_insufficient", ms)
            return None
        p = self._open_position(order_id, source, direction, qty, price, slip, maker, sl, tp, ms)
        for o in list(self.s["pending"]):
            if o["direction"] != direction:
                self._drop_pending(o, "cancelled_opposite")
        return p

    # ---------- 逐根 1m ----------
    def process_bar(self, bar: dict):
        """处理一根 1m（bar：t 开盘时刻毫秒、o h l c 为卖价）。顺序见文件头。"""
        if self.s["status"] != "active":
            raise TradingRuleError("not_active", "强平后暂停中或本轮已结束，不能推进")
        t, o = bar["t"], bar["o"]
        self.s["now_ms"] = t
        fill_bid = {}
        self._gap_exits(o, t)
        if self._liquidate_at_open(o, t):
            for q in self.s["queue"]:
                self._result(q["id"], "market", "cancelled_liquidation", t)
        else:
            self._run_queue(o, t, fill_bid)
            self._intrabar(bar, fill_bid)
        self.s["queue"] = []
        self.s["last_bid"] = bar["c"]
        self.s["now_ms"] = t + MINUTE_MS

    def _gap_exits(self, o: float, t: int):
        ask = o + self.spread
        for p in list(self.s["positions"]):
            d = p["direction"]
            ref = o if d == 1 else ask
            if p["sl"] is not None and (ref - p["sl"]) * d <= 0:
                price, slip = taker_fill(-d, ref, self.spec)
                self._close_part(p, p["qty"], price, slip, False, "gap_stop", t)
            elif p["tp"] is not None and (ref - p["tp"]) * d >= 0:
                self._close_part(p, p["qty"], ref, 0.0, True, "gap_tp", t)

    def _run_queue(self, o: float, t: int, fill_bid: dict):
        """排队的市价开仓，按这根 1m 的开盘价成交。"""
        for q in self.s["queue"]:
            base = o + self.spread if q["direction"] == 1 else o
            price, slip = taker_fill(q["direction"], base, self.spec)
            p = self._try_open(q["id"], "market", q["direction"], q["qty"], price, slip, False,
                               q["sl"], q["tp"], o, t)
            if p is not None:
                fill_bid[p["id"]] = o

    def _liquidate_at_open(self, o: float, t: int) -> bool:
        lp = ml.liquidation_price(self.s["positions"], self.s["balance"], self.spec, self.s["leverage"])
        if lp is None:
            return False
        d = self.s["positions"][0]["direction"]
        ref = o if d == 1 else o + self.spread
        if (ref - lp) * d > 0:
            return False
        self._liquidate(ref, lp, t, at_open=True)
        return True

    def _intrabar(self, bar: dict, fill_bid: dict):
        while True:
            events = self._collect_events(bar, fill_bid)
            if not events:
                return
            ev = min(events, key=lambda e: (e["distance"], PRIORITY[e["type"]], e["ref_id"]))
            if ev["type"] == "liquidation":
                self._liquidate(ev["level"], ev["lp"], bar["t"], at_open=False)
                return
            self._execute(ev, bar, fill_bid)

    def _collect_events(self, bar: dict, fill_bid: dict) -> list:
        events = []
        tps = []
        for p in self.s["positions"]:
            start = fill_bid.get(p["id"], bar["o"])
            sl_ev = self._stop_event(p, bar, start)
            if sl_ev:
                events.append(sl_ev)
            elif p["id"] not in fill_bid:
                tp_ev = self._tp_event(p, bar)
                if tp_ev:
                    tps.append(tp_ev)
        liq = self._liquidation_event(bar)
        if liq:
            events.append(liq)
        else:
            events.extend(tps)
        for o in self.s["pending"]:
            ev = self._pending_event(o, bar)
            if ev:
                events.append(ev)
        return events

    def _stop_event(self, p: dict, bar: dict, start_bid: float):
        sl = p["sl"]
        if sl is None:
            return None
        if p["direction"] == 1:
            if bar["l"] > sl:
                return None
            level = min(sl, start_bid)
            return {"type": "stop", "ref_id": p["id"], "level": level, "distance": abs(bar["o"] - level)}
        if bar["h"] + self.spread < sl:
            return None
        level = max(sl, start_bid + self.spread)
        return {"type": "stop", "ref_id": p["id"], "level": level, "distance": abs(bar["o"] - (level - self.spread))}

    def _tp_event(self, p: dict, bar: dict):
        tp = p["tp"]
        if tp is None:
            return None
        if p["direction"] == 1:
            if bar["h"] < tp:
                return None
            return {"type": "tp", "ref_id": p["id"], "level": tp, "distance": abs(tp - bar["o"])}
        if bar["l"] + self.spread > tp:
            return None
        return {"type": "tp", "ref_id": p["id"], "level": tp, "distance": abs(tp - self.spread - bar["o"])}

    def _liquidation_event(self, bar: dict):
        lp = ml.liquidation_price(self.s["positions"], self.s["balance"], self.spec, self.s["leverage"])
        if lp is None:
            return None
        if self.s["positions"][0]["direction"] == 1:
            if bar["l"] > lp:
                return None
            level = min(lp, bar["o"])
            return {"type": "liquidation", "ref_id": 0, "level": level, "lp": lp, "distance": abs(bar["o"] - level)}
        if bar["h"] + self.spread < lp:
            return None
        level = max(lp, bar["o"] + self.spread)
        return {"type": "liquidation", "ref_id": 0, "level": level, "lp": lp,
                "distance": abs(bar["o"] - (level - self.spread))}

    def _pending_event(self, o: dict, bar: dict):
        """挂单这一根是否触发；返回成交基准价（买单为买价口径、卖单为卖价口径）和离开盘价的距离。"""
        price, d, sp = o["price"], o["direction"], self.spread
        cross = self.spec["tick_size"] if self.spec.get("limit_fill_rule") == "cross_one_tick" else 0.0
        eps = self.spec["tick_size"] * 1e-6
        op, hi, lo = bar["o"] + (sp if d == 1 else 0.0), bar["h"] + (sp if d == 1 else 0.0), bar["l"] + (sp if d == 1 else 0.0)
        if o["kind"] == "limit":
            if d == 1:
                if lo > price - cross + eps:
                    return None
                gap = op <= price - cross + eps
                base = op if gap else price
            else:
                if hi < price + cross - eps:
                    return None
                gap = op >= price + cross - eps
                base = op if gap else price
        else:
            if (d == 1 and hi < price) or (d == -1 and lo > price):
                return None
            gap = (op - price) * d >= 0
            base = op if gap else price
        bid_level = base - (sp if d == 1 else 0.0)
        return {"type": "pending", "ref_id": o["id"], "level": base, "bid_level": bid_level,
                "distance": 0.0 if gap else abs(bid_level - bar["o"])}

    def _execute(self, ev: dict, bar: dict, fill_bid: dict):
        t = bar["t"]
        if ev["type"] == "pending":
            o = self._pending(ev["ref_id"])
            self.s["pending"].remove(o)
            maker = o["kind"] == "limit"
            if maker:
                price, slip = ev["level"], 0.0
            else:
                price, slip = taker_fill(o["direction"], ev["level"], self.spec)
            p = self._try_open(o["id"], pending_name(o["direction"], o["kind"]), o["direction"], o["qty"], price,
                               slip, maker, o["sl"], o["tp"], ev["bid_level"], t)
            if p is not None:
                fill_bid[p["id"]] = ev["bid_level"]
            return
        p = self._position(ev["ref_id"])
        if ev["type"] == "stop":
            price, slip = taker_fill(-p["direction"], ev["level"], self.spec)
            self._close_part(p, p["qty"], price, slip, False, "stop", t)
        else:
            self._close_part(p, p["qty"], ev["level"], 0.0, True, "tp", t)

    def _liquidate(self, level: float, lp: float, t: int, at_open: bool):
        """强平：全部仓位按强平价（跳空按开盘价）吃单 + 滑点平掉，撤销全部挂单；交易账户清零（D55）。"""
        balance_before = self.s["balance"]
        trades = []
        total_units = 0.0
        for p in list(self.s["positions"]):
            price, slip = taker_fill(-p["direction"], level, self.spec)
            total_units += ml.units_of(p["qty"], self.spec)
            trades.append((ml.units_of(p["qty"], self.spec), self._close_part(p, p["qty"], price, slip, False, "liquidation", t)))
        for o in list(self.s["pending"]):
            self._drop_pending(o, "cancelled_liquidation")
        residual = self.s["balance"]
        for units, trade in trades:
            adjust = -residual * units / total_units
            trade["liquidation_adjust"] = adjust
            trade["pnl"] += adjust
        self.s["balance"] = 0.0
        self.s["status"] = "liquidated_paused" if self.s["funding"] > 0 else "ended_liquidation"
        self.s["liquidations"].append({"ms": t, "liquidation_price": lp, "fill_level": level, "at_open": at_open,
                                       "balance_before": balance_before, "residual_cleared": residual,
                                       "status_after": self.s["status"]})


# ---------------- 动作分派（对账用例与第 5 阶段服务器复算共用：按事件日志重放） ----------------

def apply_action(acc: TradingAccount, action: dict):
    """按动作字典执行一次用户操作；返回新订单号（如有）。"""
    op = action["op"]
    if op == "market":
        return acc.place_market(action["direction"], action["qty"], action.get("sl"), action.get("tp"))
    if op == "close":
        return acc.close_position(action["position_id"], action.get("qty"))
    if op == "pending":
        return acc.place_pending(action["direction"], action["price"], action["qty"], action.get("sl"), action.get("tp"))
    if op == "modify_pending":
        return acc.modify_pending(action["order_id"], action["price"], action["qty"], action.get("sl"), action.get("tp"))
    if op == "cancel_pending":
        return acc.cancel_pending(action["order_id"])
    if op == "set_stops":
        return acc.set_position_stops(action["position_id"], action.get("sl"), action.get("tp"))
    if op == "transfer":
        return acc.transfer(action["direction"], action["amount"])
    if op == "close_all":
        return acc.close_all_now(action.get("reason", "end_of_round"))
    if op == "set_leverage":
        return acc.set_leverage(action["leverage"])
    raise TradingRuleError("bad_op", f"未知的操作 {op!r}")
