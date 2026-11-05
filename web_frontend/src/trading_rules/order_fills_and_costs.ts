// 交易账户、订单、逐根 1m 成交与成本（规格书 6.1、6.2、6.6、6.7、15.2、15.3 节，决策 D53–D55）。
// 与后端 python_backend/trading_rules/order_fills_and_costs.py 同一份规则（那边文件头有完整说明），用
// tests/cross_check_cases/trading_cases.json 逐笔对账；改一边必须同时改另一边，运算顺序也保持一致。
// 成本规则来源：CryptoTrade/core/cost_models.py；止损止盈判断顺序来源：CryptoTrade/backtest/engine.py（2026-10-21 复制后改写）。
// 要点：点差、滑点算进成交价，手续费成交时从余额扣除；爆仓按强平价成交（跳空按开盘价），之后交易账户清零（D55）。
// 每根 1m 的处理顺序：① 跳空止损 → 跳空止盈 ② 开盘已越过强平价则强平 ③ 排队的市价开仓
//   ④ 盘中按「离开盘价近的先发生」处理止损、强平、挂单、止盈（同距离：止损 → 强平 → 挂单 → 止盈）；
//   同一仓位同根碰到止损和止盈按止损；同根碰到强平时止盈都不算；本根刚成交的仓位止盈从下一根才判断。
// 手动平仓（全部或部分）不排队：立即按当前价格（最后一根 1m 的收盘）成交，时间不走（D57）。
// 价格叫法（D54）：K 线价格 = 卖价（bid），买价 = 卖价 + 点差。
import {
  type MarketSpec,
  accountMetrics,
  closePrice,
  equityOf,
  floorToStep,
  liquidationPrice,
  maxWithdraw,
  pendingMargin,
  positionMargin,
  spreadOf,
  unitsOf,
  usedMargin,
} from './margin_and_liquidation';

export const MINUTE_MS = 60_000;
const QTY_EPS = 1e-9;
const PRIORITY = { stop: 0, liquidation: 1, pending: 2, tp: 3 } as const;

export type Direction = 1 | -1;
type Num = number | null;

/** 下单 / 改单 / 出入金不合法。code 是固定的英文代号（前后端一致），message 是给用户看的中文原因 */
export class TradingRuleError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------- 成本 ----------------

/** 币安按名义价值收的费率（挂单 / 吃单）；Exness 没有按比例的手续费 */
export function feeRate(spec: MarketSpec, maker: boolean): number {
  if (spec.cost.model === 'pct') return maker ? spec.cost.maker : spec.cost.taker;
  return 0;
}

/** 一次吃单成交的滑点（价格差）。abs：固定价差；pct：成交价的百分比 */
export function slippageAmount(spec: MarketSpec, basePrice: number): number {
  const s = spec.slippage;
  if (s.kind === 'abs') return s.value;
  if (s.kind === 'pct') return basePrice * s.value;
  throw new Error(`[成本] 不支持的滑点类型 ${String(s.kind)}（可选 pct / abs）`);
}

/** 一次成交的手续费：币安 = 名义价值 × 费率；Exness = 每手每边佣金 × 手数（档案里为 0） */
export function fillFee(spec: MarketSpec, qty: number, price: number, maker: boolean): number {
  if (spec.cost.model === 'pct') return price * unitsOf(qty, spec) * feeRate(spec, maker);
  return (spec.cost.commission_per_lot_side ?? 0) * qty;
}

/** 吃单成交：买入在 base 上加滑点，卖出减滑点。返回 [成交价, 滑点] */
export function takerFill(directionOfFill: number, basePrice: number, spec: MarketSpec): [number, number] {
  const slip = slippageAmount(spec, basePrice);
  return [directionOfFill === 1 ? basePrice + slip : basePrice - slip, slip];
}

/** 每 1 个 unit 在止损被打到时亏多少（含止损滑点和两边手续费） */
export function lossPerUnitAtStop(direction: number, entryPrice: number, stopPrice: number, spec: MarketSpec): number {
  const [exitPrice] = takerFill(-direction, stopPrice, spec);
  const rate = feeRate(spec, false);
  return (entryPrice - exitPrice) * direction + entryPrice * rate + exitPrice * rate;
}

/** 按「止损被打到最多亏净值的 X%」换算数量（规格书 6.3 节），向下取整；止损在错误一侧返回 0 */
export function qtyFromRisk(equity: number, riskRatio: number, direction: number, entryPrice: number, stopPrice: number, spec: MarketSpec): number {
  if (equity <= 0 || riskRatio <= 0) return 0;
  const perUnit = lossPerUnitAtStop(direction, entryPrice, stopPrice, spec);
  if (perUnit <= 0) return 0;
  return floorToStep((equity * riskRatio) / (perUnit * spec.contract_size), spec.qty_step);
}

/** R 倍数 = 盈亏 ÷ 第一次设止损时的风险（|开仓价 − 止损| × 数量）；没设过止损返回 null（规格书 5.8 节） */
export function rMultiple(pnl: number, entryPrice: number, initialSl: Num, qty: number, spec: MarketSpec): number | null {
  if (initialSl === null) return null;
  const risk = Math.abs(entryPrice - initialSl) * unitsOf(qty, spec);
  return risk > 0 ? pnl / risk : null;
}

export type PendingKind = 'limit' | 'stop';

/** 挂单类型自动判断：买单低于买价为限价、高于为止损；卖单高于卖价为限价、低于为止损 */
export function classifyPending(direction: number, price: number, bid: number, spec: MarketSpec): PendingKind {
  const market = direction === 1 ? bid + spreadOf(spec) : bid;
  if (price === market) throw new TradingRuleError('price_equals_market', '挂单价不能等于现价');
  if (direction === 1) return price < market ? 'limit' : 'stop';
  return price > market ? 'limit' : 'stop';
}

export function pendingName(direction: number, kind: PendingKind): string {
  return (direction === 1 ? 'buy_' : 'sell_') + kind;
}

// ---------------- 状态（可直接存成 JSON，与 Python 字段一一对应） ----------------

export interface ExitRecord { ms: number; qty: number; price: number; reason: string }
export interface Position {
  id: number; order_id: number; source: string; direction: Direction; qty: number; initial_qty: number;
  entry_price: number; sl: Num; tp: Num; initial_sl: Num; open_ms: number;
  realized_gross: number; fees: number; spread_cost: number; slippage_cost: number; exits: ExitRecord[];
}
export interface PendingOrder {
  id: number; direction: Direction; kind: PendingKind; price: number; qty: number; sl: Num; tp: Num; placed_ms: number;
  history: Array<{ ms: number; kind: PendingKind; price: number; qty: number; sl: Num; tp: Num }>;
}
export interface QueuedOrder { id: number; op: 'open'; direction: Direction; qty: number; sl: Num; tp: Num; placed_ms: number }
export interface Trade {
  position_id: number; order_id: number; source: string; direction: Direction; qty: number; entry_price: number;
  open_ms: number; close_ms: number; exit_price_avg: number; close_reason: string; gross: number; fees: number;
  spread_cost: number; slippage_cost: number; liquidation_adjust: number; pnl: number; sl_at_close: Num; tp_at_close: Num;
  initial_sl: Num; exits: ExitRecord[];
}
export interface Fill {
  seq: number; ms: number; position_id: number; order_id: number | null; action: 'open' | 'close'; reason: string;
  direction: Direction; qty: number; price: number; fee: number; spread_cost: number; slippage_cost: number; gross: number;
}
export type AccountStatus = 'active' | 'liquidated_paused' | 'ended_liquidation';
export interface AccountState {
  symbol: string; leverage: number; balance: number; funding: number; status: AccountStatus;
  last_bid: Num; now_ms: number; next_id: number;
  positions: Position[]; pending: PendingOrder[]; queue: QueuedOrder[];
  trades: Trade[]; fills: Fill[];
  order_results: Array<{ order_id: number; kind: string; result: string; ms: number; position_id: number | null }>;
  transfers: Array<{ ms: number; direction: 'to_funding' | 'to_trading'; amount: number; equity_before: number; had_positions: boolean }>;
  liquidations: Array<{ ms: number; liquidation_price: number; fill_level: number; at_open: boolean; balance_before: number; residual_cleared: number; status_after: AccountStatus }>;
}

/** 新开一轮时的账户状态 */
export function newAccountState(symbol: string, leverage: number, balance: number, funding: number, nowMs: number): AccountState {
  return {
    symbol, leverage, balance, funding, status: 'active', last_bid: null, now_ms: nowMs, next_id: 1,
    positions: [], pending: [], queue: [], trades: [], fills: [], order_results: [], transfers: [], liquidations: [],
  };
}

export interface Bar1mPrice { t: number; o: number; h: number; l: number; c: number }
interface BarEvent { type: keyof typeof PRIORITY; ref_id: number; level: number; distance: number; lp?: number; bid_level?: number }

function removeItem<T>(list: T[], item: T): void {
  list.splice(list.indexOf(item), 1);
}

/** 一轮练习的交易账户（与 Python 的 TradingAccount 方法一一对应） */
export class TradingAccount {
  readonly spread: number;

  constructor(
    public s: AccountState,
    public spec: MarketSpec,
  ) {
    this.spread = spreadOf(spec);
  }

  // ---------- 查询 ----------
  metrics() {
    return accountMetrics(this.s.balance, this.s.positions, this.s.last_bid, this.spec, this.s.leverage, this.s.pending);
  }

  snapshot(): AccountState {
    return structuredClone(this.s);
  }

  private newId(): number {
    return this.s.next_id++;
  }

  private position(positionId: number): Position {
    const p = this.s.positions.find((x) => x.id === positionId);
    if (!p) throw new TradingRuleError('no_position', '找不到这个仓位（可能已经平仓）');
    return p;
  }

  private pendingOrder(orderId: number): PendingOrder {
    const o = this.s.pending.find((x) => x.id === orderId);
    if (!o) throw new TradingRuleError('no_order', '找不到这张挂单（可能已经成交或撤销）');
    return o;
  }

  // ---------- 合法性检查 ----------
  private requireActive(): number {
    if (this.s.status !== 'active') throw new TradingRuleError('not_active', '强平后暂停中或本轮已结束，不能交易');
    if (this.s.last_bid === null) throw new TradingRuleError('no_price', '还没有价格，不能交易');
    return this.s.last_bid;
  }

  private checkQty(qty: number, price: number): number {
    const q = floorToStep(qty, this.spec.qty_step);
    if (q < this.spec.min_qty - QTY_EPS) throw new TradingRuleError('below_min_qty', `低于最小下单量 ${this.spec.min_qty}`);
    if (unitsOf(q, this.spec) * price < (this.spec.min_notional ?? 0)) {
      throw new TradingRuleError('below_min_notional', `名义价值低于最小值 ${this.spec.min_notional}`);
    }
    return q;
  }

  private checkStops(direction: number, ref: number, sl: Num, tp: Num): void {
    if (sl !== null && (ref - sl) * direction <= 0) {
      throw new TradingRuleError('stop_wrong_side', '止损在错误的一侧' + (direction === 1 ? '（多单止损要低于现价）' : '（空单止损要高于现价）'));
    }
    if (tp !== null && (tp - ref) * direction <= 0) {
      throw new TradingRuleError('tp_wrong_side', '止盈在错误的一侧' + (direction === 1 ? '（多单止盈要高于现价）' : '（空单止盈要低于现价）'));
    }
  }

  /** 挂单要预占保证金（D60）：可用保证金（已扣其他挂单的预占）不够这张单的保证金就挂不上 */
  private checkPendingMargin(qty: number, price: number, excludeId: number | null = null): void {
    const others = this.s.pending.filter((o) => o.id !== excludeId);
    const m = accountMetrics(this.s.balance, this.s.positions, this.s.last_bid, this.spec, this.s.leverage, others);
    const need = positionMargin(qty, price, this.spec, this.s.leverage);
    if (m.free_margin < need) {
      throw new TradingRuleError('margin_insufficient', `可用保证金不够（挂单要预占 ${need.toFixed(2)}，可用 ${m.free_margin.toFixed(2)}）`);
    }
  }

  private checkNoOpposite(direction: number): void {
    if (this.s.positions.some((p) => p.direction !== direction)) {
      throw new TradingRuleError('opposite_position', '已持有反向仓位，第一版不允许锁仓');
    }
  }

  /** D76：还有反向的市价单在排队等成交时，当场拒绝（原来要等成交时才拒，结果一样，只是提前告诉用户） */
  private checkNoOppositeQueued(direction: number): void {
    if (this.s.queue.some((q) => q.direction !== direction)) {
      throw new TradingRuleError('opposite_position', '已有反向的市价单在等成交，第一版不允许锁仓');
    }
  }

  // ---------- 用户操作（发生在两根 1m 之间，时刻 = now_ms） ----------
  /** 市价单：排队，到下一根 1m 开盘成交（D53） */
  placeMarket(direction: Direction, qty: number, sl: Num = null, tp: Num = null): number {
    const bid = this.requireActive();
    this.checkNoOpposite(direction);
    this.checkNoOppositeQueued(direction);
    const q = this.checkQty(qty, bid);
    this.checkStops(direction, closePrice(direction, bid, this.spec), sl, tp);
    const id = this.newId();
    this.s.queue.push({ id, op: 'open', direction, qty: q, sl, tp, placed_ms: this.s.now_ms });
    return id;
  }

  /** 手动平仓（全部或部分）：立即按当前价格（最后一根 1m 收盘）吃单 + 滑点成交，时间不走（D57）；剩余低于最小手数时直接全平 */
  closePosition(positionId: number, qty: Num = null): number {
    const bid = this.requireActive();
    const p = this.position(positionId);
    let q = qty === null ? p.qty : floorToStep(qty, this.spec.qty_step);
    if (q <= QTY_EPS) throw new TradingRuleError('below_min_qty', '平仓数量太小');
    if (q > p.qty - this.spec.min_qty + QTY_EPS) q = p.qty;
    const id = this.newId();
    const ms = this.s.now_ms;
    const [price, slip] = takerFill(-p.direction, closePrice(p.direction, bid, this.spec), this.spec);
    this.closePart(p, q, price, slip, false, 'manual', ms, id);
    this.result(id, 'close', 'filled', ms, positionId);
    return id;
  }

  /** 挂单：类型按价位自动判断，从下一根 1m 开始判断成交 */
  placePending(direction: Direction, price: number, qty: number, sl: Num = null, tp: Num = null): number {
    const bid = this.requireActive();
    const kind = classifyPending(direction, price, bid, this.spec);
    const q = this.checkQty(qty, price);
    this.checkStops(direction, price, sl, tp);
    this.checkPendingMargin(q, price);
    const id = this.newId();
    this.s.pending.push({ id, direction, kind, price, qty: q, sl, tp, placed_ms: this.s.now_ms, history: [] });
    return id;
  }

  /** 改挂单（全部给最终值）；价位越过现价时类型自动切换，方向不变 */
  modifyPending(orderId: number, price: number, qty: number, sl: Num = null, tp: Num = null): void {
    const bid = this.requireActive();
    const o = this.pendingOrder(orderId);
    const kind = classifyPending(o.direction, price, bid, this.spec);
    const q = this.checkQty(qty, price);
    this.checkStops(o.direction, price, sl, tp);
    this.checkPendingMargin(q, price, orderId);
    o.history.push({ ms: this.s.now_ms, kind: o.kind, price: o.price, qty: o.qty, sl: o.sl, tp: o.tp });
    Object.assign(o, { kind, price, qty: q, sl, tp });
  }

  cancelPending(orderId: number): void {
    this.dropPending(this.pendingOrder(orderId), 'cancelled');
  }

  /** 改持仓的止损止盈（给最终值，null = 取消）；移到保本就是把止损设为开仓价 */
  setPositionStops(positionId: number, sl: Num = null, tp: Num = null): void {
    const bid = this.requireActive();
    const p = this.position(positionId);
    this.checkStops(p.direction, closePrice(p.direction, bid, this.spec), sl, tp);
    if (p.initial_sl === null && sl !== null) p.initial_sl = sl; // 第一次设的止损，算 R 倍数用
    p.sl = sl;
    p.tp = tp;
  }

  /** 出入金（规格书 6.6 节）。to_funding：交易账户 → 资金账户；to_trading：资金账户 → 交易账户 */
  transfer(direction: 'to_funding' | 'to_trading', amount: number): void {
    if (amount <= 0) throw new TradingRuleError('bad_amount', '金额必须大于 0');
    const m = this.metrics();
    if (direction === 'to_funding') {
      const limit = maxWithdraw(this.s.balance, m.free_margin);
      if (amount > limit + 1e-9) throw new TradingRuleError('over_withdraw', `最多可转出 ${limit.toFixed(2)}（浮动盈利不能转出）`);
      this.s.balance -= amount;
      this.s.funding += amount;
    } else if (direction === 'to_trading') {
      if (amount > this.s.funding + 1e-9) throw new TradingRuleError('over_funding', `资金账户只有 ${this.s.funding.toFixed(2)}`);
      this.s.funding -= amount;
      this.s.balance += amount;
      if (this.s.status === 'liquidated_paused') this.s.status = 'active';
    } else {
      throw new TradingRuleError('bad_direction', '未知的划转方向');
    }
    this.s.transfers.push({ ms: this.s.now_ms, direction, amount, equity_before: m.equity, had_positions: this.s.positions.length > 0 });
  }

  /** 改平台杠杆（D72）：空仓、没有挂单、没有排队的市价单时才能改；范围按品种档案的 leverage.min–max */
  setLeverage(leverage: number): void {
    if (this.s.positions.length || this.s.pending.length || this.s.queue.length)
      throw new TradingRuleError('leverage_busy', '有持仓、挂单或还没成交的市价单时不能改杠杆（先平仓、撤单）');
    const { min, max } = this.spec.leverage!;
    if (!(min <= leverage && leverage <= max)) throw new TradingRuleError('bad_leverage', `杠杆要在 ${min}–${max} 倍之间`);
    this.s.leverage = leverage;
  }

  /** 结束本轮：按现价（最后一根 1m 的收盘）全部市价平仓，撤销全部挂单和排队（D26） */
  closeAllNow(reason = 'end_of_round'): void {
    const bid = this.s.last_bid!;
    const ms = this.s.now_ms;
    for (const p of [...this.s.positions]) {
      const [price, slip] = takerFill(-p.direction, closePrice(p.direction, bid, this.spec), this.spec);
      this.closePart(p, p.qty, price, slip, false, reason, ms);
    }
    for (const o of [...this.s.pending]) this.dropPending(o, 'cancelled_end_of_round');
    for (const q of this.s.queue) this.result(q.id, q.op, 'cancelled_end_of_round', ms);
    this.s.queue = [];
  }

  // ---------- 记账 ----------
  private result(orderId: number, kind: string, result: string, ms: number, positionId: number | null = null): void {
    this.s.order_results.push({ order_id: orderId, kind, result, ms, position_id: positionId });
  }

  private dropPending(o: PendingOrder, result: string): void {
    removeItem(this.s.pending, o);
    this.result(o.id, pendingName(o.direction, o.kind), result, this.s.now_ms);
  }

  private recordFill(p: Position, action: 'open' | 'close', reason: string, qty: number, price: number, fee: number,
    spreadCost: number, slipCost: number, gross: number, ms: number, orderId: number | null = null): void {
    this.s.fills.push({
      seq: this.s.fills.length + 1, ms, position_id: p.id, order_id: orderId, action, reason, direction: p.direction,
      qty, price, fee, spread_cost: spreadCost, slippage_cost: slipCost, gross,
    });
  }

  private openPosition(orderId: number, source: string, direction: Direction, qty: number, price: number, slip: number,
    maker: boolean, sl: Num, tp: Num, ms: number): Position {
    const units = unitsOf(qty, this.spec);
    const fee = fillFee(this.spec, qty, price, maker);
    const spreadCost = direction === 1 ? this.spread * units : 0;
    const slipCost = slip * units;
    this.s.balance -= fee;
    const p: Position = {
      id: this.newId(), order_id: orderId, source, direction, qty, initial_qty: qty, entry_price: price, sl, tp, initial_sl: sl, open_ms: ms,
      realized_gross: 0, fees: fee, spread_cost: spreadCost, slippage_cost: slipCost, exits: [],
    };
    this.s.positions.push(p);
    this.recordFill(p, 'open', source, qty, price, fee, spreadCost, slipCost, 0, ms, orderId);
    this.result(orderId, source, 'filled', ms, p.id);
    return p;
  }

  /** 平掉一个仓位的 qty；平完时生成一笔交易记录并返回它，否则返回 null */
  private closePart(p: Position, qty: number, price: number, slip: number, maker: boolean, reason: string, ms: number,
    orderId: number | null = null): Trade | null {
    const units = unitsOf(qty, this.spec);
    const gross = (price - p.entry_price) * p.direction * units;
    const fee = fillFee(this.spec, qty, price, maker);
    const spreadCost = p.direction === -1 ? this.spread * units : 0;
    const slipCost = slip * units;
    this.s.balance += gross - fee;
    p.qty -= qty;
    p.realized_gross += gross;
    p.fees += fee;
    p.spread_cost += spreadCost;
    p.slippage_cost += slipCost;
    p.exits.push({ ms, qty, price, reason });
    this.recordFill(p, 'close', reason, qty, price, fee, spreadCost, slipCost, gross, ms, orderId);
    if (p.qty > QTY_EPS) return null;
    return this.finishTrade(p, reason, ms);
  }

  private finishTrade(p: Position, reason: string, ms: number): Trade {
    removeItem(this.s.positions, p);
    let exitValue = 0;
    for (const e of p.exits) exitValue += e.qty * e.price;
    const trade: Trade = {
      position_id: p.id, order_id: p.order_id, source: p.source, direction: p.direction, qty: p.initial_qty,
      entry_price: p.entry_price, open_ms: p.open_ms, close_ms: ms, exit_price_avg: exitValue / p.initial_qty,
      close_reason: reason, gross: p.realized_gross, fees: p.fees, spread_cost: p.spread_cost, slippage_cost: p.slippage_cost,
      liquidation_adjust: 0, pnl: p.realized_gross - p.fees, sl_at_close: p.sl, tp_at_close: p.tp, initial_sl: p.initial_sl,
      exits: p.exits,
    };
    this.s.trades.push(trade);
    return trade;
  }

  /** 成交那一刻：可用保证金（扣除其余挂单的预占，D60）≥ 这笔的保证金 + 手续费。成交的这张挂单此时已移出挂单列表 */
  private canAfford(qty: number, price: number, refBid: number, maker: boolean): boolean {
    const equity = equityOf(this.s.balance, this.s.positions, refBid, this.spec);
    const free = equity - usedMargin(this.s.positions, this.spec, this.s.leverage) - pendingMargin(this.s.pending, this.spec, this.s.leverage);
    const need = positionMargin(qty, price, this.spec, this.s.leverage) + fillFee(this.spec, qty, price, maker);
    return free >= need;
  }

  /** 开仓前检查反向仓位和保证金；成交后撤销反向挂单（OCO） */
  private tryOpen(orderId: number, source: string, direction: Direction, qty: number, price: number, slip: number,
    maker: boolean, sl: Num, tp: Num, refBid: number, ms: number): Position | null {
    if (this.s.positions.some((p) => p.direction !== direction)) {
      this.result(orderId, source, 'opposite_position', ms);
      return null;
    }
    if (!this.canAfford(qty, price, refBid, maker)) {
      this.result(orderId, source, 'margin_insufficient', ms);
      return null;
    }
    const p = this.openPosition(orderId, source, direction, qty, price, slip, maker, sl, tp, ms);
    for (const o of [...this.s.pending]) if (o.direction !== direction) this.dropPending(o, 'cancelled_opposite');
    return p;
  }

  // ---------- 逐根 1m ----------
  /** 处理一根 1m（o h l c 为卖价）。顺序见文件头 */
  processBar(bar: Bar1mPrice): void {
    if (this.s.status !== 'active') throw new TradingRuleError('not_active', '强平后暂停中或本轮已结束，不能推进');
    const { t, o } = bar;
    this.s.now_ms = t;
    const fillBid = new Map<number, number>();
    this.gapExits(o, t);
    if (this.liquidateAtOpen(o, t)) {
      for (const q of this.s.queue) this.result(q.id, 'market', 'cancelled_liquidation', t);
    } else {
      this.runQueue(o, t, fillBid);
      this.intrabar(bar, fillBid);
    }
    this.s.queue = [];
    this.s.last_bid = bar.c;
    this.s.now_ms = t + MINUTE_MS;
  }

  private gapExits(o: number, t: number): void {
    const ask = o + this.spread;
    for (const p of [...this.s.positions]) {
      const d = p.direction;
      const ref = d === 1 ? o : ask;
      if (p.sl !== null && (ref - p.sl) * d <= 0) {
        const [price, slip] = takerFill(-d, ref, this.spec);
        this.closePart(p, p.qty, price, slip, false, 'gap_stop', t);
      } else if (p.tp !== null && (ref - p.tp) * d >= 0) {
        this.closePart(p, p.qty, ref, 0, true, 'gap_tp', t);
      }
    }
  }

  /** 排队的市价开仓，按这根 1m 的开盘价成交 */
  private runQueue(o: number, t: number, fillBid: Map<number, number>): void {
    for (const q of this.s.queue) {
      const base = q.direction === 1 ? o + this.spread : o;
      const [price, slip] = takerFill(q.direction, base, this.spec);
      const p = this.tryOpen(q.id, 'market', q.direction, q.qty, price, slip, false, q.sl, q.tp, o, t);
      if (p) fillBid.set(p.id, o);
    }
  }

  private liquidateAtOpen(o: number, t: number): boolean {
    const lp = liquidationPrice(this.s.positions, this.s.balance, this.spec, this.s.leverage);
    if (lp === null) return false;
    const d = this.s.positions[0].direction;
    const ref = d === 1 ? o : o + this.spread;
    if ((ref - lp) * d > 0) return false;
    this.liquidate(ref, lp, t, true);
    return true;
  }

  private intrabar(bar: Bar1mPrice, fillBid: Map<number, number>): void {
    for (;;) {
      const events = this.collectEvents(bar, fillBid);
      if (events.length === 0) return;
      let ev = events[0];
      for (const e of events.slice(1)) {
        const a = [e.distance, PRIORITY[e.type], e.ref_id];
        const b = [ev.distance, PRIORITY[ev.type], ev.ref_id];
        if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) ev = e;
      }
      if (ev.type === 'liquidation') {
        this.liquidate(ev.level, ev.lp!, bar.t, false);
        return;
      }
      this.execute(ev, bar, fillBid);
    }
  }

  private collectEvents(bar: Bar1mPrice, fillBid: Map<number, number>): BarEvent[] {
    const events: BarEvent[] = [];
    const tps: BarEvent[] = [];
    for (const p of this.s.positions) {
      const start = fillBid.get(p.id) ?? bar.o;
      const slEv = this.stopEvent(p, bar, start);
      if (slEv) events.push(slEv);
      else if (!fillBid.has(p.id)) {
        const tpEv = this.tpEvent(p, bar);
        if (tpEv) tps.push(tpEv);
      }
    }
    const liq = this.liquidationEvent(bar);
    if (liq) events.push(liq);
    else events.push(...tps);
    for (const o of this.s.pending) {
      const ev = this.pendingEvent(o, bar);
      if (ev) events.push(ev);
    }
    return events;
  }

  private stopEvent(p: Position, bar: Bar1mPrice, startBid: number): BarEvent | null {
    const sl = p.sl;
    if (sl === null) return null;
    if (p.direction === 1) {
      if (bar.l > sl) return null;
      const level = Math.min(sl, startBid);
      return { type: 'stop', ref_id: p.id, level, distance: Math.abs(bar.o - level) };
    }
    if (bar.h + this.spread < sl) return null;
    const level = Math.max(sl, startBid + this.spread);
    return { type: 'stop', ref_id: p.id, level, distance: Math.abs(bar.o - (level - this.spread)) };
  }

  private tpEvent(p: Position, bar: Bar1mPrice): BarEvent | null {
    const tp = p.tp;
    if (tp === null) return null;
    if (p.direction === 1) {
      if (bar.h < tp) return null;
      return { type: 'tp', ref_id: p.id, level: tp, distance: Math.abs(tp - bar.o) };
    }
    if (bar.l + this.spread > tp) return null;
    return { type: 'tp', ref_id: p.id, level: tp, distance: Math.abs(tp - this.spread - bar.o) };
  }

  private liquidationEvent(bar: Bar1mPrice): BarEvent | null {
    const lp = liquidationPrice(this.s.positions, this.s.balance, this.spec, this.s.leverage);
    if (lp === null) return null;
    if (this.s.positions[0].direction === 1) {
      if (bar.l > lp) return null;
      const level = Math.min(lp, bar.o);
      return { type: 'liquidation', ref_id: 0, level, lp, distance: Math.abs(bar.o - level) };
    }
    if (bar.h + this.spread < lp) return null;
    const level = Math.max(lp, bar.o + this.spread);
    return { type: 'liquidation', ref_id: 0, level, lp, distance: Math.abs(bar.o - (level - this.spread)) };
  }

  /** 挂单这一根是否触发；level 为成交基准价（买单为买价口径、卖单为卖价口径） */
  private pendingEvent(o: PendingOrder, bar: Bar1mPrice): BarEvent | null {
    const price = o.price;
    const d = o.direction;
    const sp = this.spread;
    const cross = this.spec.limit_fill_rule === 'cross_one_tick' ? this.spec.tick_size : 0;
    const eps = this.spec.tick_size * 1e-6;
    const add = d === 1 ? sp : 0;
    const op = bar.o + add;
    const hi = bar.h + add;
    const lo = bar.l + add;
    let gap: boolean;
    let base: number;
    if (o.kind === 'limit') {
      if (d === 1) {
        if (lo > price - cross + eps) return null;
        gap = op <= price - cross + eps;
      } else {
        if (hi < price + cross - eps) return null;
        gap = op >= price + cross - eps;
      }
      base = gap ? op : price;
    } else {
      if ((d === 1 && hi < price) || (d === -1 && lo > price)) return null;
      gap = (op - price) * d >= 0;
      base = gap ? op : price;
    }
    const bidLevel = base - add;
    return { type: 'pending', ref_id: o.id, level: base, bid_level: bidLevel, distance: gap ? 0 : Math.abs(bidLevel - bar.o) };
  }

  private execute(ev: BarEvent, bar: Bar1mPrice, fillBid: Map<number, number>): void {
    const t = bar.t;
    if (ev.type === 'pending') {
      const o = this.pendingOrder(ev.ref_id);
      removeItem(this.s.pending, o);
      const maker = o.kind === 'limit';
      const [price, slip] = maker ? [ev.level, 0] : takerFill(o.direction, ev.level, this.spec);
      const p = this.tryOpen(o.id, pendingName(o.direction, o.kind), o.direction, o.qty, price, slip, maker, o.sl, o.tp, ev.bid_level!, t);
      if (p) fillBid.set(p.id, ev.bid_level!);
      return;
    }
    const p = this.position(ev.ref_id);
    if (ev.type === 'stop') {
      const [price, slip] = takerFill(-p.direction, ev.level, this.spec);
      this.closePart(p, p.qty, price, slip, false, 'stop', t);
    } else {
      this.closePart(p, p.qty, ev.level, 0, true, 'tp', t);
    }
  }

  /** 强平：全部仓位按强平价（跳空按开盘价）吃单 + 滑点平掉，撤销全部挂单；交易账户清零（D55） */
  private liquidate(level: number, lp: number, t: number, atOpen: boolean): void {
    const balanceBefore = this.s.balance;
    const trades: Array<[number, Trade]> = [];
    let totalUnits = 0;
    for (const p of [...this.s.positions]) {
      const [price, slip] = takerFill(-p.direction, level, this.spec);
      totalUnits += unitsOf(p.qty, this.spec);
      trades.push([unitsOf(p.qty, this.spec), this.closePart(p, p.qty, price, slip, false, 'liquidation', t)!]);
    }
    for (const o of [...this.s.pending]) this.dropPending(o, 'cancelled_liquidation');
    const residual = this.s.balance;
    for (const [units, trade] of trades) {
      const adjust = (-residual * units) / totalUnits;
      trade.liquidation_adjust = adjust;
      trade.pnl += adjust;
    }
    this.s.balance = 0;
    this.s.status = this.s.funding > 0 ? 'liquidated_paused' : 'ended_liquidation';
    this.s.liquidations.push({
      ms: t, liquidation_price: lp, fill_level: level, at_open: atOpen, balance_before: balanceBefore,
      residual_cleared: residual, status_after: this.s.status,
    });
  }
}

// ---------------- 动作分派（对账用例与服务器复算共用：按事件日志重放） ----------------

export type TradingAction =
  | { op: 'market'; direction: Direction; qty: number; sl?: Num; tp?: Num }
  | { op: 'close'; position_id: number; qty?: Num }
  | { op: 'pending'; direction: Direction; price: number; qty: number; sl?: Num; tp?: Num }
  | { op: 'modify_pending'; order_id: number; price: number; qty: number; sl?: Num; tp?: Num }
  | { op: 'cancel_pending'; order_id: number }
  | { op: 'set_stops'; position_id: number; sl?: Num; tp?: Num }
  | { op: 'transfer'; direction: 'to_funding' | 'to_trading'; amount: number }
  | { op: 'close_all'; reason?: string }
  | { op: 'set_leverage'; leverage: number };

/** 按动作执行一次用户操作；返回新订单号（如有） */
export function applyAction(acc: TradingAccount, a: TradingAction): number | undefined {
  switch (a.op) {
    case 'market': return acc.placeMarket(a.direction, a.qty, a.sl ?? null, a.tp ?? null);
    case 'close': return acc.closePosition(a.position_id, a.qty ?? null);
    case 'pending': return acc.placePending(a.direction, a.price, a.qty, a.sl ?? null, a.tp ?? null);
    case 'modify_pending': acc.modifyPending(a.order_id, a.price, a.qty, a.sl ?? null, a.tp ?? null); return undefined;
    case 'cancel_pending': acc.cancelPending(a.order_id); return undefined;
    case 'set_stops': acc.setPositionStops(a.position_id, a.sl ?? null, a.tp ?? null); return undefined;
    case 'transfer': acc.transfer(a.direction, a.amount); return undefined;
    case 'close_all': acc.closeAllNow(a.reason ?? 'end_of_round'); return undefined;
    case 'set_leverage': acc.setLeverage(a.leverage); return undefined;
    default: throw new TradingRuleError('bad_op', `未知的操作 ${String((a as { op: string }).op)}`);
  }
}
