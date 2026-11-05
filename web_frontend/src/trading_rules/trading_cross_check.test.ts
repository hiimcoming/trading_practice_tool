// 前后端交易规则对账（规格书第 10 节第 4 阶段验收、CLAUDE.md 架构铁律 3）：
// 读 Python 生成的 tests/cross_check_cases/trading_cases.json，用 TypeScript 把每个用例重跑一遍，
// 逐项比对每根之后的账户数字和最终的全部记录（成交、交易、订单结果、出入金、强平、剩余持仓与挂单）。
// 数字允许的误差：1e-9（两边运算顺序一致，实际差异应为 0）。另附规格书 6.3、6.5 节验算例。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import specsFile from '../../../common_settings/market_specs.json';
import { liquidationPrice, positionMargin, qtyFromMarginRatio, type MarketSpec } from './margin_and_liquidation';
import { MINUTE_MS, TradingAccount, TradingRuleError, applyAction, newAccountState, type TradingAction } from './order_fills_and_costs';

interface CaseAction { before_bar: number; op: string; position_index?: number; order_index?: number; [k: string]: unknown }
interface Case {
  name: string; symbol: string; leverage: number; balance: number; funding: number;
  bars: number[][]; actions: CaseAction[]; expected: unknown;
}
const file = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../tests/cross_check_cases/trading_cases.json'), 'utf-8')) as {
  base_ms: number; cases: Case[];
};
const SPECS = (specsFile as unknown as { markets: Record<string, MarketSpec> }).markets;

/** 把 position_index / order_index 换成真实编号（与 Python 的 resolve_refs 一致） */
function resolveRefs(acc: TradingAccount, a: CaseAction): TradingAction {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) if (!['before_bar', 'position_index', 'order_index'].includes(k)) out[k] = v;
  if (a.position_index !== undefined) out.position_id = acc.s.positions[a.position_index].id;
  if (a.order_index !== undefined) out.order_id = acc.s.pending[a.order_index].id;
  return out as unknown as TradingAction;
}

/** 与 Python 的 run_case 一致 */
function runCase(c: Case) {
  const acc = new TradingAccount(newAccountState(c.symbol, c.leverage, c.balance, c.funding, file.base_ms), SPECS[c.symbol]);
  const errors: unknown[] = [];
  const perBar: unknown[] = [];
  const returned: unknown[] = [];
  for (let k = 0; k <= c.bars.length; k++) {
    for (const a of c.actions) {
      if (a.before_bar !== k) continue;
      try {
        returned.push(applyAction(acc, resolveRefs(acc, a)) ?? null);
      } catch (e) {
        if (!(e instanceof TradingRuleError)) throw e;
        errors.push({ before_bar: k, op: a.op, code: e.code });
      }
    }
    if (k === c.bars.length) break;
    if (acc.s.status !== 'active') {
      perBar.push({ skipped: true, status: acc.s.status });
      continue;
    }
    const [o, h, l, cl] = c.bars[k];
    acc.processBar({ t: file.base_ms + k * MINUTE_MS, o, h, l, c: cl });
    const m = acc.metrics();
    perBar.push({
      balance: m.balance, equity: m.equity, used_margin: m.used_margin, pending_margin: m.pending_margin, free_margin: m.free_margin,
      real_leverage: m.real_leverage, liquidation_price: m.liquidation_price, status: acc.s.status,
    });
  }
  return { errors, returned, per_bar: perBar, final: acc.snapshot() };
}

/** 逐项比对（数字允许 1e-9 误差）；返回不一致的位置列表 */
function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))) out.push(`${path}: TS ${a} ≠ Python ${b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: 长度 TS ${a.length} ≠ Python ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
    return;
  }
  if (a !== b) out.push(`${path}: TS ${JSON.stringify(a)} ≠ Python ${JSON.stringify(b)}`);
}

describe('前后端交易规则逐项一致', () => {
  it('用例数量正确', () => expect(file.cases.length).toBe(41));
  for (const c of file.cases) {
    it(c.name, () => {
      const out: string[] = [];
      diff(runCase(c), c.expected, c.name, out);
      expect(out).toEqual([]);
    });
  }
  it('汇总：成交与交易笔数', () => {
    let fills = 0;
    let trades = 0;
    let mismatches = 0;
    for (const c of file.cases) {
      const got = runCase(c);
      fills += got.final.fills.length;
      trades += got.final.trades.length;
      const out: string[] = [];
      diff(got, c.expected, c.name, out);
      mismatches += out.length;
    }
    console.log(`[对账] ${file.cases.length} 个用例，${fills} 笔成交、${trades} 笔完整交易，不一致 ${mismatches} 处`);
    expect(mismatches).toBe(0);
  });
});

describe('规格书验算例（TypeScript 版）', () => {
  const xau = SPECS.XAUUSD;
  const btc = SPECS.BTCUSDT;
  it('6.3 节：0.01 手保证金 8.4，23% → 0.27 手', () => {
    expect(positionMargin(0.01, 4200, xau, 500)).toBeCloseTo(8.4, 10);
    expect(qtyFromMarginRatio(1000, 0.23, 4200, xau, 500)).toBeCloseTo(0.27, 10);
  });
  it('6.5 节：Exness 4196.34 / 4162.96，币安 90361.4', () => {
    expect(liquidationPrice([{ direction: 1, qty: 2.73, entry_price: 4200 }], 1000, xau, 500)!.toFixed(2)).toBe('4196.34');
    expect(liquidationPrice([{ direction: 1, qty: 0.27, entry_price: 4200 }], 1000, xau, 500)!.toFixed(2)).toBe('4162.96');
    expect(liquidationPrice([{ direction: 1, qty: 0.1, entry_price: 100000 }], 1000, btc, 30)!.toFixed(1)).toBe('90361.4');
  });
});
