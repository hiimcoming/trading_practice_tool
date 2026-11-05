// 保证金、净值、真实杠杆、强平价、仓位换算（规格书 6.1、6.3、6.5、6.6 节，决策 D55）。
// 与后端 python_backend/trading_rules/margin_and_liquidation.py 同一份规则，用
// tests/cross_check_cases/trading_cases.json 逐笔对账（CLAUDE.md 架构铁律 3）；改一边必须同时改另一边，
// 公式里的运算顺序也保持一致（浮点数换个顺序结果会差在最后一位）。
// 价格约定（D54，照 Exness 界面叫法）：K 线价格 = 卖价（bid）；买价 = 卖价 + 点差（Exness 固定 0.25，币安 0）。
//   多单平仓是「卖」，按卖价估值；空单平仓是「买」，按买价估值。
// 数量约定：qty 是手数（Exness）或币数（币安）；units = qty × 合约单位。

/** 品种档案（common_settings/market_specs.json 里的一项，只列交易规则用到的字段） */
export interface MarketSpec {
  platform: 'exness' | 'binance';
  contract_size: number;
  qty_step: number;
  min_qty: number;
  min_notional?: number;
  tick_size: number;
  cost: { model: 'spread'; spread: number; commission_per_lot_side?: number } | { model: 'pct'; maker: number; taker: number };
  slippage: { kind: 'abs' | 'pct'; value: number };
  stop_out_level?: number;
  maintenance_margin_rate?: number;
  maintenance_amount?: number;
  limit_fill_rule?: 'touch' | 'cross_one_tick';
  /** 平台杠杆的允许范围（改杠杆时检查，D72）；presets 是面板上的快捷按钮 */
  leverage?: { min: number; max: number; presets?: number[] };
  /** 下单数量的单位（只用来显示）：Exness「手」，币安为币名 */
  qty_unit?: string;
}

/** 计算保证金与强平价时只需要仓位的这几个字段 */
export interface PositionLike {
  direction: 1 | -1;
  qty: number;
  entry_price: number;
}

const STEP_EPS = 1e-9; // 向下取整到步长时的容差：0.29999999999 这类浮点误差算作 0.3

/** 向下取整到步长的整数倍（规格书 15.2 节） */
export function floorToStep(x: number, step: number): number {
  return Math.floor(x / step + STEP_EPS) * step;
}

/** 买价比卖价高多少（Exness 固定点差；币安 0） */
export function spreadOf(spec: MarketSpec): number {
  return spec.cost.model === 'spread' ? spec.cost.spread : 0;
}

export function unitsOf(qty: number, spec: MarketSpec): number {
  return qty * spec.contract_size;
}

/** 平仓价（不含滑点）：多单按卖价，空单按买价 */
export function closePrice(direction: number, bid: number, spec: MarketSpec): number {
  return direction === 1 ? bid : bid + spreadOf(spec);
}

/** 一个仓位占用的保证金 = 名义价值 ÷ 杠杆（按开仓价算，开仓后不变） */
export function positionMargin(qty: number, price: number, spec: MarketSpec, leverage: number): number {
  return (unitsOf(qty, spec) * price) / leverage;
}

/** 一个仓位不计平仓成本的浮动盈亏 */
export function floatingPnl(p: PositionLike, bid: number, spec: MarketSpec): number {
  const price = closePrice(p.direction, bid, spec);
  return (price - p.entry_price) * p.direction * unitsOf(p.qty, spec);
}

export function usedMargin(positions: PositionLike[], spec: MarketSpec, leverage: number): number {
  let total = 0;
  for (const p of positions) total += positionMargin(p.qty, p.entry_price, spec, leverage);
  return total;
}

/** 挂单预占的保证金（D60：两个平台都在挂出时预占）= 每张挂单的 手数 × 合约单位 × 挂单价 ÷ 杠杆 之和 */
export function pendingMargin(pending: Array<{ qty: number; price: number }>, spec: MarketSpec, leverage: number): number {
  let total = 0;
  for (const o of pending) total += positionMargin(o.qty, o.price, spec, leverage);
  return total;
}

/** 净值 = 余额 + 全部仓位的浮动盈亏 */
export function equityOf(balance: number, positions: PositionLike[], bid: number, spec: MarketSpec): number {
  let total = balance;
  for (const p of positions) total += floatingPnl(p, bid, spec);
  return total;
}

/** 强平公式里的 [m, 速算额]。Exness：m = 强平线 ÷ 杠杆；币安：m = 维持保证金率 */
export function maintenanceParams(spec: MarketSpec, leverage: number): [number, number] {
  if (spec.platform === 'exness') return [(spec.stop_out_level ?? 0) / leverage, 0];
  return [spec.maintenance_margin_rate!, spec.maintenance_amount ?? 0];
}

/**
 * 全部仓位合并后的强平价（规格书 6.5 节）。没有仓位、或多单永远不会被强平时返回 null。
 * 多单返回「卖价」触发价，空单返回「买价」触发价。
 *   多单：(Q × E − B − 速算额) ÷ (Q × (1 − m))；空单：(Q × E + B + 速算额) ÷ (Q × (1 + m))
 */
export function liquidationPrice(positions: PositionLike[], balance: number, spec: MarketSpec, leverage: number): number | null {
  if (positions.length === 0) return null;
  const direction = positions[0].direction;
  let q = 0;
  let qe = 0;
  for (const p of positions) {
    const u = unitsOf(p.qty, spec);
    q += u;
    qe += u * p.entry_price;
  }
  const [m, amount] = maintenanceParams(spec, leverage);
  if (direction === 1) {
    const price = (qe - balance - amount) / (q * (1 - m));
    return price > 0 ? price : null;
  }
  return (qe + balance + amount) / (q * (1 + m));
}

export interface AccountMetrics {
  balance: number;
  equity: number;
  floating_pnl: number;
  used_margin: number;
  /** 挂单预占的保证金（D60） */
  pending_margin: number;
  free_margin: number;
  margin_level: number | null;
  real_leverage: number | null;
  liquidation_price: number | null;
}

/**
 * 交易账户的各项显示数字（规格书 6.1 节）。bid 为 null（还没有价格）时只给余额。
 * 可用保证金 = 净值 − 持仓保证金 − 挂单预占保证金（D60）；保证金水平、强平价只看持仓（挂单没成交前不会亏钱）。
 */
export function accountMetrics(balance: number, positions: PositionLike[], bid: number | null, spec: MarketSpec, leverage: number,
  pending: Array<{ qty: number; price: number }> = []): AccountMetrics {
  const used = usedMargin(positions, spec, leverage);
  const reserved = pendingMargin(pending, spec, leverage);
  const liq = liquidationPrice(positions, balance, spec, leverage);
  if (bid === null) {
    return { balance, equity: balance, floating_pnl: 0, used_margin: used, pending_margin: reserved, free_margin: balance - used - reserved, margin_level: null, real_leverage: 0, liquidation_price: liq };
  }
  const equity = equityOf(balance, positions, bid, spec);
  let notional = 0;
  for (const p of positions) notional += unitsOf(p.qty, spec) * bid;
  return {
    balance,
    equity,
    floating_pnl: equity - balance,
    used_margin: used,
    pending_margin: reserved,
    free_margin: equity - used - reserved,
    margin_level: used > 0 ? equity / used : null,
    real_leverage: equity > 0 ? notional / equity : null,
    liquidation_price: liq,
  };
}

/** 出金上限 = min(余额, 可用保证金)：浮动盈利不能提走（规格书 6.6 节） */
export function maxWithdraw(balance: number, freeMargin: number): number {
  return Math.max(0, Math.min(balance, freeMargin));
}

// ---------------- 仓位面板的换算（规格书 6.3 节；「按风险定仓位」要用成本规则，放在 order_fills_and_costs） ----------------

/** 按「占用净值的 X% 作保证金」换算数量，向下取整到步长 */
export function qtyFromMarginRatio(equity: number, ratio: number, price: number, spec: MarketSpec, leverage: number): number {
  if (price <= 0 || ratio <= 0 || equity <= 0) return 0;
  const raw = (equity * ratio * leverage) / (price * spec.contract_size);
  return floorToStep(raw, spec.qty_step);
}

/** 价格每变动 1 美元（1 USDT）的盈亏 */
export function pnlPerPriceUnit(qty: number, spec: MarketSpec): number {
  return unitsOf(qty, spec);
}
