// 图上订单线的「交易含义」（规格书 6.4、6.5、6.7 节，D59）：每条线画在哪、什么颜色、标签写什么、能不能拖、点 × 做什么、
// 拖动中怎么提示、松开后改什么。画线、贴标签、处理鼠标在 chart_and_drawing/order_lines_layer.ts；这里只算内容。
// 线的编号（key）：pos{仓位} 持仓线、sl{仓位} / tp{仓位} 止损止盈、new{仓位} 从持仓线拖出来的新止损止盈（拖动中才有）、
//   pend{订单} 挂单线、psl{订单} / ptp{订单} 挂单附带的止损止盈（淡色）、draft / dsl / dtp 草稿单的进场、止损、止盈、liq 强平线、ask 买价线。
// 拖动：松开即生效（D59，照 MT5）；拖到不合法的位置时线和标签变红，松开后由交易规则拒绝、弹回原位并提示原因。
// 从持仓线往上或往下拖：多单向上是止盈、向下是止损；空单相反（规格书 6.4 节）。
// 拖动中标签实时显示：触发时的盈亏、占净值的百分比、距开仓（挂单：距现价）的价格（D58 不显示 R）。
// 部分平仓后（D78）：持仓线和止损止盈线上的金额只算剩下的仓位；拖动中另写「整笔合计」（已平 + 在这里出场）。
// 标签上的 TP / SL（照 Exness 网页版，规格书 6.7 节第 4 条）：持仓线、挂单线、草稿线还没设止盈 / 止损时显示，
//   点一下按预设距离出一条线（止损 2 倍 ATR、止盈 4 倍 ATR，从进场价算，D18），之后可以直接拖。

import { LineStyle } from 'lightweight-charts';
import type { OverlayLine } from '../chart_and_drawing/order_lines_layer';
import { spreadOf, unitsOf } from '../trading_rules/margin_and_liquidation';
import { fillFee, lossPerUnitAtStop, pendingName, takerFill, type Direction, type PendingOrder, type Position } from '../trading_rules/order_fills_and_costs';
import { price2, qtyText, signedMoney } from './format_helpers';
import { KIND_TEXT, type PracticeController } from './practice_controller';
import { DEFAULTS } from './shared_settings';

const C = {
  buy: '#2962ff', sell: '#e0464b', sl: '#e0464b', tp: '#0b9c7c', faintSl: '#f0a3a6', faintTp: '#8fd3c2',
  draft: '#7a5af8', liq: '#f0642d', ask: '#9aa3b1',
};

export interface DragPreview {
  key: string;
  price: number;
}

const parseNum = (t: string): number | null => {
  const x = Number(t.replace(/,/g, '').trim());
  return t.trim() === '' || !Number.isFinite(x) ? null : x;
};
const signedPrice = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${price2(Math.abs(x))}`;

/** 一条线；quick = 标签上显示哪些 TP / SL 快捷按钮 */
function line(key: string, price: number, color: string, style: LineStyle, label: string | null, closable: boolean, draggable: boolean,
  width: 1 | 2 = 1, invalid = false, quick?: { tp: boolean; sl: boolean }): OverlayLine {
  return { key, price, color, style, width, label: invalid && label ? `${label}（不能放这里）` : label, closable, draggable, invalid, quick };
}

/** 止损 / 止盈线是否在正确的一侧：多单的止损要低于参照价、止盈要高于；空单相反 */
function rightSide(direction: number, kind: 'sl' | 'tp', price: number, ref: number): boolean {
  return kind === 'sl' ? (ref - price) * direction > 0 : (price - ref) * direction > 0;
}

/** 算出图上全部订单线（preview = 正在拖的那条线和它此刻的价格） */
export function buildLines(c: PracticeController, preview: DragPreview | null): OverlayLine[] {
  const s = c.account.s;
  const spec = c.marketSpec;
  const bid = s.last_bid;
  if (bid === null) return [];
  const ask = bid + spreadOf(spec);
  const can = c.canAdvance();
  const equity = c.account.metrics().equity;
  const pctOf = (x: number) => (equity > 0 ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${(Math.abs(x) / equity * 100).toFixed(2)}%` : '');
  const at = (key: string, price: number) => (preview?.key === key ? preview.price : price);
  const out: OverlayLine[] = [];

  for (const p of s.positions) out.push(...positionLines(c, p, preview, bid, ask, can, pctOf));
  for (const o of s.pending) out.push(...pendingLines(c, o, preview, bid, ask, can, pctOf));
  out.push(...draftLines(c, preview, bid, ask, pctOf));

  const liq = c.account.metrics().liquidation_price;
  if (liq !== null) out.push(line('liq', liq, C.liq, LineStyle.Dashed, `强平 ${price2(liq)}`, false, false, 2));
  if (spec.platform === 'exness' && c.settingsSnapshot.show_ask_line) out.push(line('ask', at('ask', ask), C.ask, LineStyle.Dotted, null, false, false));
  return out;
}

type PctOf = (x: number) => string;

function positionLines(c: PracticeController, p: Position, preview: DragPreview | null, bid: number, ask: number, can: boolean, pctOf: PctOf): OverlayLine[] {
  const spec = c.marketSpec;
  const d = p.direction;
  const ref = d === 1 ? bid : ask;
  const out: OverlayLine[] = [];
  const qty = qtyText(p.qty, spec.qty_step);
  // 「#编号」：多笔持仓时，持仓线和它的止盈止损线写同一个编号，持仓表每行也有（用户 2026-10-22）
  const no = `#${c.positionNo(p.id)}`;
  out.push(line(`pos${p.id}`, p.entry_price, d === 1 ? C.buy : C.sell, LineStyle.Solid, `${no} ${d === 1 ? '买' : '卖'} ${qty} | ${signedMoney(c.positionPnl(p))}`, can, can,
    1, false, can ? { tp: p.tp === null, sl: p.sl === null } : undefined));
  for (const kind of ['sl', 'tp'] as const) {
    const key = `${kind}${p.id}`;
    const level = preview?.key === key ? preview.price : p[kind];
    if (level === null) continue;
    const dragging = preview?.key === key;
    const name = kind === 'sl' ? '止损' : '止盈';
    const pnl = c.outcomeAt(p, level, kind);
    // D78：金额只算剩下的仓位；部分平过仓时，拖动中另写整笔合计（已平 + 这里出场）
    const whole = p.exits.length ? ` · 整笔合计 ${signedMoney(c.closedPartPnl(p) + pnl)}` : '';
    const label = dragging
      ? `${no} ${name} | ${signedMoney(pnl)}（${pctOf(pnl)}）· 距开仓 ${signedPrice(level - p.entry_price)}${whole}`
      : `${no} ${name} | ${signedMoney(pnl)}`;
    out.push(line(key, level, kind === 'sl' ? C.sl : C.tp, LineStyle.Dashed, label, can, can, 1, dragging && !rightSide(d, kind, level, ref)));
  }
  // 从持仓线往上 / 往下拖：拖动中画一条新的止损或止盈线（原持仓线不动）
  if (preview?.key === `pos${p.id}` && preview.price !== p.entry_price) {
    const kind = (preview.price - p.entry_price) * d > 0 ? 'tp' : 'sl';
    const pnl = c.outcomeAt(p, preview.price, kind);
    const name = kind === 'sl' ? '新止损' : '新止盈';
    const whole = p.exits.length ? ` · 整笔合计 ${signedMoney(c.closedPartPnl(p) + pnl)}` : '';
    out.push(line(`new${p.id}`, preview.price, kind === 'sl' ? C.sl : C.tp, LineStyle.Dashed,
      `${no} ${name} | ${signedMoney(pnl)}（${pctOf(pnl)}）· 距开仓 ${signedPrice(preview.price - p.entry_price)}${whole}`, false, false, 1, !rightSide(d, kind, preview.price, ref)));
  }
  return out;
}

/** 挂单成交后，在 level 出场时的盈亏（含成交、出场的手续费和滑点） */
function pendingOutcome(c: PracticeController, o: PendingOrder, entry: number, level: number, kind: 'sl' | 'tp'): number {
  const spec = c.marketSpec;
  const units = unitsOf(o.qty, spec);
  const entryFee = fillFee(spec, o.qty, entry, o.kind === 'limit');
  if (kind === 'sl') return -lossPerUnitAtStop(o.direction, entry, level, spec) * units;
  return (level - entry) * o.direction * units - entryFee - fillFee(spec, o.qty, level, true);
}

function pendingLines(c: PracticeController, o: PendingOrder, preview: DragPreview | null, bid: number, ask: number, can: boolean, pctOf: PctOf): OverlayLine[] {
  const spec = c.marketSpec;
  const d = o.direction;
  const key = `pend${o.id}`;
  const dragging = preview?.key === key;
  const price = dragging ? preview.price : o.price;
  const kind = dragging ? c.pendingKindName(d, price) : KIND_TEXT[pendingName(d, o.kind)];
  const qty = qtyText(o.qty, spec.qty_step);
  const market = d === 1 ? ask : bid;
  const stopsOk = (o.sl === null || rightSide(d, 'sl', o.sl, price)) && (o.tp === null || rightSide(d, 'tp', o.tp, price));
  const label = dragging ? `${kind ?? '挂单'} ${qty} · 距现价 ${signedPrice(price - market)}` : `${kind} ${qty}`;
  const out = [line(key, price, d === 1 ? C.buy : C.sell, LineStyle.Dashed, label, can, can, 1, dragging && (kind === null || !stopsOk),
    can ? { tp: o.tp === null, sl: o.sl === null } : undefined)];
  const entry = (o.kind === 'limit' ? price : takerFill(d, price, spec)[0]);
  for (const k of ['sl', 'tp'] as const) {
    const lk = `p${k}${o.id}`;
    const level = preview?.key === lk ? preview.price : o[k];
    if (level === null) continue;
    const pnl = pendingOutcome(c, o, entry, level, k);
    const dragK = preview?.key === lk;
    const name = k === 'sl' ? '止损' : '止盈';
    const text = dragK ? `${name} | ${signedMoney(pnl)}（${pctOf(pnl)}）· 距挂单价 ${signedPrice(level - price)}` : `${name} | ${signedMoney(pnl)}`;
    out.push(line(lk, level, k === 'sl' ? C.faintSl : C.faintTp, LineStyle.Dotted, text, can, can, 1, dragK && !rightSide(d, k, level, price)));
  }
  return out;
}

function draftLines(c: PracticeController, preview: DragPreview | null, bid: number, ask: number, pctOf: PctOf): OverlayLine[] {
  const f = c.view?.form;
  if (!f || f.draft === null) return [];
  const spec = c.marketSpec;
  const d: Direction = f.draft;
  const isPending = f.tab === 'pending';
  const typed = isPending ? parseNum(f.priceText) : d === 1 ? ask : bid;
  const entryLevel = preview?.key === 'draft' && typed !== null ? preview.price : typed;
  const out: OverlayLine[] = [];
  if (entryLevel === null) return out;
  const kind = isPending ? c.pendingKindName(d, entryLevel) : null;
  const qty = c.draftQty;
  const qtyLabel = `${qtyText(qty, spec.qty_step)} ${spec.qty_unit ?? (spec.platform === 'exness' ? '手' : '')}`;
  const entryLine = line('draft', entryLevel, C.draft, LineStyle.LargeDashed, `草稿 ${kind ?? (isPending ? '挂单' : d === 1 ? '买入' : '卖出')} ${qtyLabel}`, true, isPending, 2,
    preview?.key === 'draft' && kind === null, { tp: parseNum(f.tpText) === null, sl: parseNum(f.slText) === null });
  // 「提交」按钮：能不能提交、原因都由下单面板算好（和面板上的提交按钮同一套检查）；面板还没算好时不显示
  if (c.draftSubmit) entryLine.submit = { side: d === 1 ? 'buy' : 'sell', reason: c.draftSubmit.reason };
  out.push(entryLine);
  // 预计成交价：市价按买价 / 卖价加滑点；限价按挂单价；止损挂单加滑点
  const entry = !isPending ? takerFill(d, entryLevel, spec)[0] : kind?.endsWith('限价') ? entryLevel : takerFill(d, entryLevel, spec)[0];
  const units = unitsOf(qty, spec);
  for (const k of ['sl', 'tp'] as const) {
    const lk = k === 'sl' ? 'dsl' : 'dtp';
    const level = preview?.key === lk ? preview.price : parseNum(k === 'sl' ? f.slText : f.tpText);
    if (level === null) continue;
    const ok = rightSide(d, k, level, entry);
    const pnl = !ok ? 0 : k === 'sl' ? -lossPerUnitAtStop(d, entry, level, spec) * units : (level - entry) * d * units - fillFee(spec, qty, level, true);
    const name = k === 'sl' ? '止损' : '止盈';
    const text = preview?.key === lk ? `${name} | ${signedMoney(pnl)}（${pctOf(pnl)}）· 距进场 ${signedPrice(level - entry)}` : `${name} | ${signedMoney(pnl)}`;
    out.push(line(lk, level, k === 'sl' ? C.sl : C.tp, LineStyle.LargeDashed, text, true, true, 1, !ok));
  }
  return out;
}

/**
 * 从 TP / SL 按钮按住拖出来的线（编号 quick|线|tp 或 sl），对应到哪条止盈 / 止损线：
 * 持仓 pos3 → sl3 / tp3；挂单 pend5 → psl5 / ptp5；草稿 draft → dsl / dtp。拖动中和松开都按这条线处理。
 */
export function quickTargetKey(dragKey: string): string {
  const [, key, kind] = dragKey.split('|');
  const id = key.replace(/^\D+/, '');
  if (key.startsWith('pos')) return `${kind}${id}`;
  if (key.startsWith('pend')) return `p${kind}${id}`;
  return kind === 'sl' ? 'dsl' : 'dtp';
}

/** 松开：把新价格写进去（不合法时由交易规则拒绝，页面提示原因，线弹回原位） */
export function dropLine(c: PracticeController, key: string, price: number): void {
  const s = c.account.s;
  const id = Number(key.replace(/^\D+/, ''));
  const p = s.positions.find((x) => x.id === id);
  const o = s.pending.find((x) => x.id === id);
  const two = String(Number(price.toFixed(2)));
  if (key.startsWith('sl') && p && price !== p.sl) c.setStops(id, price, p.tp);
  else if (key.startsWith('tp') && p && price !== p.tp) c.setStops(id, p.sl, price);
  else if (key.startsWith('pos') && p && price !== p.entry_price) {
    const isTp = (price - p.entry_price) * p.direction > 0;
    c.setStops(id, isTp ? p.sl : price, isTp ? price : p.tp);
  } else if (key.startsWith('pend') && o && price !== o.price) c.modifyPending(id, price, o.qty, o.sl, o.tp);
  else if (key.startsWith('psl') && o && price !== o.sl) c.modifyPending(id, o.price, o.qty, price, o.tp);
  else if (key.startsWith('ptp') && o && price !== o.tp) c.modifyPending(id, o.price, o.qty, o.sl, price);
  else if (key === 'draft') c.updateForm({ priceText: two });
  else if (key === 'dsl') c.updateForm({ slText: two });
  else if (key === 'dtp') c.updateForm({ tpText: two });
}

/**
 * 点了标签上的 TP / SL：从进场价（持仓的开仓价、挂单价、草稿的进场价）按预设距离放一条止盈 / 止损线
 * （止损 2 倍 ATR、止盈 4 倍 ATR，当前周期、只用已收盘 K 线；K 线不够算 ATR 时按价格的 0.2% 当一倍）。
 * 持仓若已经浮亏很多、按开仓价算出的止损落在现价错误的一侧，就改从现价算，保证这条线一出现就合法。
 */
export function quickLine(c: PracticeController, key: string, kind: 'tp' | 'sl'): void {
  const s = c.account.s;
  const bid = s.last_bid;
  if (bid === null) return;
  const ask = bid + spreadOf(c.marketSpec);
  const id = Number(key.replace(/^\D+/, ''));
  const mult = kind === 'sl' ? DEFAULTS.trading_panel.default_sl_atr : DEFAULTS.trading_panel.default_tp_atr;
  const one = c.atr() ?? bid * 0.002;
  const away = (entry: number, d: number) => Number((entry + (kind === 'tp' ? d : -d) * one * mult).toFixed(2));
  const p = s.positions.find((x) => x.id === id);
  const o = s.pending.find((x) => x.id === id);
  if (key.startsWith('pos') && p) {
    let level = away(p.entry_price, p.direction);
    const ref = p.direction === 1 ? bid : ask;
    if (!rightSide(p.direction, kind, level, ref)) level = away(ref, p.direction);
    c.setStops(id, kind === 'sl' ? level : p.sl, kind === 'tp' ? level : p.tp);
  } else if (key.startsWith('pend') && o) {
    const level = away(o.price, o.direction);
    c.modifyPending(id, o.price, o.qty, kind === 'sl' ? level : o.sl, kind === 'tp' ? level : o.tp);
  } else if (key === 'draft') {
    const f = c.view.form;
    if (f.draft === null) return;
    const entry = f.tab === 'pending' ? parseNum(f.priceText) : f.draft === 1 ? ask : bid;
    if (entry === null) return;
    c.updateForm(kind === 'sl' ? { slText: String(away(entry, f.draft)) } : { tpText: String(away(entry, f.draft)) });
  }
}

/** 点了标签上的 ×：持仓线 = 按现价平仓；止损止盈 = 取消它；挂单 = 撤单；草稿 = 取消草稿或清掉草稿的止损止盈 */
export function closeLine(c: PracticeController, key: string): void {
  const s = c.account.s;
  const id = Number(key.replace(/^\D+/, ''));
  const p = s.positions.find((x) => x.id === id);
  const o = s.pending.find((x) => x.id === id);
  if (key.startsWith('pos') && p) c.closePosition(id);
  else if (key.startsWith('sl') && p) c.setStops(id, null, p.tp);
  else if (key.startsWith('tp') && p) c.setStops(id, p.sl, null);
  else if (key.startsWith('pend') && o) c.cancelPending(id);
  else if (key.startsWith('psl') && o) c.modifyPending(id, o.price, o.qty, null, o.tp);
  else if (key.startsWith('ptp') && o) c.modifyPending(id, o.price, o.qty, o.sl, null);
  else if (key === 'draft') c.cancelDraft();
  else if (key === 'dsl') c.updateForm({ slText: '' });
  else if (key === 'dtp') c.updateForm({ tpText: '' });
}

/** 点了草稿线标签上的「提交」：和点下单面板上的提交按钮完全一样 */
export function submitLine(c: PracticeController, key: string): void {
  if (key === 'draft' && c.draftSubmit && c.draftSubmit.reason === null) c.draftSubmit.submit();
}
