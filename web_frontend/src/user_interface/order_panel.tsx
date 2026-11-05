// 右侧下单面板（规格书 6.3、6.7 节，D56、D59）：照 Exness 网页版排版——卖 / 买两个大价格按钮（中间是点差）、
// 市价 / 挂单两个标签、仓位（手数 / 保证金比例 / 风险比例三种方式联动，换算一律向下取整）、止盈、止损，
// 下面列出这笔单的名义价值、保证金、每 1 美元盈亏、止损亏多少、止盈赚多少、下单后的预估强平价和真实杠杆（界面不显示 R，D58）。
//   · 市价标签：点「卖出 / 买入」一键成交（D26；D76 起默认先排队，D80：排队时按钮下写「待成交 卖出 ×N（共 x 手）」）；按 B / S 生成市价草稿单，图上先画出进场、止损、止盈三条线，点「提交」才成交。
//   · 挂单标签（照 Exness 的 Pending 表单，D59）：选买 / 卖、填挂单价、手数和止盈止损，类型按价格与现价自动判断
//     （买单低于买价为限价、高于为止损；卖单高于卖价为限价、低于为止损），按钮写「提交 买入限价」；价格轴「+」也生成这张草稿。
// 表单的价格、止盈止损和草稿单状态放在练习页控制中心（practice_controller.ts），图上的草稿线跟着它画。
// 方向判断（市价、没有草稿时）：已有持仓 → 按持仓方向；否则止损在现价下方按买入、在上方按卖出，没设止损看止盈，都没设按买入。
// 止损 / 止盈的 − / + ：空着时，− 在现价下方、+ 在现价上方按默认距离出一个价（止损 2 倍 ATR、止盈 4 倍 ATR，D18）；
//   有值时按固定步长微调。宽度固定按窗口比例（约 21%），不能拖动；可一键收起成一条细边；草稿单出现时自动展开（规格书 5.6 节）。
// 图上草稿线标签的「提交」按钮：每次刷新把「能否提交 + 原因 + 提交动作」交给控制中心，和本面板的提交按钮完全同一套检查和动作。
// 币安品种（D72，照币安网页版）：
//   · 面板顶部「全仓 · 杠杆 30 倍」，点开选快捷倍数或输入整数（1 到品种上限）；有持仓、挂单或还没成交的市价单时不能改，
//     所以已经开的仓位保证金、强平价、止损金额都不受影响，只改之后开仓占用的保证金；改完记成这个品种下次开局的默认杠杆。
//   · 仓位方式「数量 / 保证金% / 风险%」：「数量」可切三种单位——USDT 名义价值（默认，仓位总大小）、USDT 保证金（押进去的本金
//     = 名义价值 ÷ 杠杆）、币数（BTC / ETH）；输入框下面一行总是写出换算：多少币、名义价值、保证金和占净值的比例。
//   Exness 黄金不变（杠杆仍在开局的高级设置里选，与 Exness 实盘一样在账户设置里改）。
import { useEffect, useRef, useState } from 'preact/hooks';
import { floorToStep, liquidationPrice, positionMargin, qtyFromMarginRatio, spreadOf, unitsOf } from '../trading_rules/margin_and_liquidation';
import { fillFee, lossPerUnitAtStop, qtyFromRisk, takerFill, type Direction } from '../trading_rules/order_fills_and_costs';
import { money, pct, price2, qtyText, quote, signedMoney } from './format_helpers';
import type { PracticeController, PracticeView } from './practice_controller';
import { DEFAULTS, local } from './shared_settings';

/** lots = 手数 / 币数；notional = USDT 名义价值；cost = USDT 保证金（后两种只有币安）；margin = 保证金占净值 %；risk = 止损风险 % */
type SizeMode = 'lots' | 'notional' | 'cost' | 'margin' | 'risk';
type QtyUnit = 'lots' | 'notional' | 'cost';
const isQtyUnit = (m: SizeMode): m is QtyUnit => m === 'lots' || m === 'notional' || m === 'cost';

const parse = (t: string): number | null => {
  const x = Number(t.replace(/,/g, '').trim());
  return t.trim() === '' || !Number.isFinite(x) ? null : x;
};

export function OrderPanel({ ctrl, view }: { ctrl: PracticeController; view: PracticeView }) {
  const [collapsed, setCollapsed] = useState(() => local.get('order_panel_collapsed', window.innerWidth < 1280));
  const autoExpanded = useRef(false);
  /** 本次刷新算出的草稿单提交信息（渲染时写入，渲染后交给控制中心；面板收起时也照算） */
  const draftSubmit = useRef<{ reason: string | null; submit: () => void } | null>(null);
  useEffect(() => ctrl.setDraftSubmit(draftSubmit.current));
  const [mode, setMode] = useState<SizeMode>(() => local.get<SizeMode>('order_size_mode', 'lots'));
  const [values, setValues] = useState<Record<SizeMode, string>>(() =>
    ({
      lots: String(ctrl.marketSpec.min_qty),
      margin: String(DEFAULTS.trading_panel.default_margin_ratio * 100),
      risk: String(DEFAULTS.trading_panel.default_risk_ratio * 100),
      notional: String(DEFAULTS.trading_panel.default_notional_usdt),
      cost: String(DEFAULTS.trading_panel.default_cost_usdt),
      // 按品种分开记（D72：以前三个品种共用一份，在 BTC 填的 0.001 会带到黄金变成「低于最小手数」）；缺的项用默认值补上
      ...local.get<Partial<Record<SizeMode, string>>>(`order_size_values.${ctrl.account.s.symbol}`, {}),
    }),
  );
  const isBinance = ctrl.marketSpec.platform === 'binance';
  /** 币安「数量」用哪种单位（记在本浏览器）；Exness 只有手数 */
  const [qtyUnit, setQtyUnit] = useState<QtyUnit>(() => (isBinance ? local.get<QtyUnit>('order_qty_unit', 'notional') : 'lots'));
  const [levOpen, setLevOpen] = useState(false);
  // Exness 没有 USDT 单位：以前在币安选过的单位不带过来；币安「数量」标签对应当前单位
  const shownMode: SizeMode = !isBinance && (mode === 'notional' || mode === 'cost') ? 'lots' : isQtyUnit(mode) ? (isBinance ? qtyUnit : 'lots') : mode;
  const f = view.form;

  // 草稿单出现时自动展开；草稿结束后，如果是自动展开的就收回（规格书 5.6 节）
  useEffect(() => {
    if (f.draft !== null && collapsed) {
      autoExpanded.current = true;
      setCollapsed(false);
    } else if (f.draft === null && autoExpanded.current) {
      autoExpanded.current = false;
      setCollapsed(true);
    }
  }, [f.draft]);

  const toggle = () => {
    autoExpanded.current = false;
    setCollapsed(!collapsed);
    local.set('order_panel_collapsed', !collapsed);
  };

  const spec = ctrl.marketSpec;
  const acc = ctrl.account;
  const precision = view.market.price_precision;
  const bid = acc.s.last_bid;
  const spread = spreadOf(spec);
  const unit = spec.qty_unit ?? (spec.platform === 'exness' ? '手' : '');
  const queued = ctrl.queuedSummary();
  const sl = parse(f.slText);
  const tp = parse(f.tpText);
  const pendingPrice = parse(f.priceText);
  const isPending = f.tab === 'pending';
  const m = acc.metrics();
  const held = acc.s.positions[0]?.direction;
  const ask = bid === null ? 0 : bid + spread;

  // 估算用的方向：有草稿按草稿方向；否则按持仓方向或止损止盈的位置
  const d: Direction = f.draft ?? held ?? (bid === null ? 1 : sl !== null ? (sl < bid ? 1 : -1) : tp !== null ? (tp > bid ? 1 : -1) : 1);
  const kindName = isPending && pendingPrice !== null ? ctrl.pendingKindName(d, pendingPrice) : null;
  /** 这个方向的预计成交价：市价按买价 / 卖价加滑点；限价挂单按挂单价；止损挂单按挂单价加滑点 */
  const entryFor = (dir: Direction): number => {
    if (bid === null) return 0;
    if (isPending && pendingPrice !== null) return kindName?.endsWith('限价') ? pendingPrice : takerFill(dir, pendingPrice, spec)[0];
    return takerFill(dir, dir === 1 ? ask : bid, spec)[0];
  };
  const lev = acc.s.leverage;
  const qtyFor = (dir: Direction): number => {
    const v = parse(values[shownMode]) ?? 0;
    if (shownMode === 'lots') return floorToStep(v, spec.qty_step);
    const e = entryFor(dir);
    // USDT 换算成币数：名义价值 ÷ 预计成交价；保证金 × 杠杆 ÷ 预计成交价；一律向下取整到数量步长
    if (shownMode === 'notional') return e > 0 ? floorToStep(v / e, spec.qty_step) : 0;
    if (shownMode === 'cost') return e > 0 ? floorToStep((v * lev) / e, spec.qty_step) : 0;
    if (shownMode === 'margin') return qtyFromMarginRatio(m.equity, v / 100, e, spec, lev);
    return sl === null ? 0 : qtyFromRisk(m.equity, v / 100, dir, entryFor(dir), sl, spec);
  };
  const q = qtyFor(d);
  useEffect(() => {
    ctrl.qtyTextForMenu = () => `${qtyText(q, spec.qty_step)} ${unit}`;
    ctrl.draftQty = q;
    ctrl.refreshOverlay(); // 草稿线的标签里有手数
  }, [q]);

  const collapsedView = (
    <aside class="order-panel collapsed" onClick={toggle} title="展开下单面板">
      ‹
    </aside>
  );
  if (bid === null) {
    draftSubmit.current = null;
    return collapsed ? collapsedView : <aside class="order-panel">还没有价格</aside>;
  }

  const setValue = (v: string) => {
    const next = { ...values, [shownMode]: v };
    setValues(next);
    local.set(`order_size_values.${acc.s.symbol}`, next);
  };
  const chooseMode = (k: SizeMode) => {
    setMode(k);
    local.set('order_size_mode', k);
  };
  const chooseUnit = (u: QtyUnit) => {
    setQtyUnit(u);
    local.set('order_qty_unit', u);
    chooseMode(u);
  };
  const levReason = ctrl.leverageReason();
  const levPresets = spec.leverage?.presets ?? [];
  const pickLeverage = (x: number) => {
    if (ctrl.setLeverage(x)) setLevOpen(false);
  };

  /** 市价单这个方向现在能不能下；不能时返回原因 */
  const marketReason = (dir: Direction): string | null => {
    if (!ctrl.canAdvance()) return acc.s.status === 'active' ? '现在不能交易' : '强平后暂停中，先转入资金或结束本轮';
    if (acc.s.positions.some((p) => p.direction !== dir)) return `已持有${dir === 1 ? '空' : '多'}单，第一版不允许锁仓`;
    return commonReason(dir, dir === 1 ? bid : ask);
  };
  /** 市价和挂单共用的检查；ref = 判断止损止盈方向的参照价（市价用现在的平仓价，挂单用挂单价） */
  const commonReason = (dir: Direction, ref: number): string | null => {
    if (shownMode === 'risk' && sl === null) return '按风险定仓位要先设止损';
    const qty = qtyFor(dir);
    const entry = entryFor(dir);
    if (qty < spec.min_qty - 1e-9) return `手数低于最小值 ${spec.min_qty}`;
    if (unitsOf(qty, spec) * entry < (spec.min_notional ?? 0)) return `名义价值低于最小值 ${spec.min_notional}`;
    if (sl !== null && (sl - ref) * dir >= 0) return dir === 1 ? '买单的止损要低于' + (isPending ? '挂单价' : '现价') : '卖单的止损要高于' + (isPending ? '挂单价' : '现价');
    if (tp !== null && (tp - ref) * dir <= 0) return dir === 1 ? '买单的止盈要高于' + (isPending ? '挂单价' : '现价') : '卖单的止盈要低于' + (isPending ? '挂单价' : '现价');
    // 市价单：保证金 + 手续费；挂单：挂出时就预占保证金（D60）
    if (isPending ? m.free_margin < positionMargin(qty, pendingPrice ?? entry, spec, acc.s.leverage)
      : m.free_margin < positionMargin(qty, entry, spec, acc.s.leverage) + fillFee(spec, qty, entry, false)) return '可用保证金不够';
    return null;
  };
  const pendingReason = (): string | null => {
    if (!ctrl.canAdvance()) return '现在不能交易';
    if (pendingPrice === null) return '请填挂单价（或点价格轴上的「+」）';
    if (kindName === null) return '挂单价不能等于现价';
    return commonReason(d, pendingPrice);
  };
  const sellReason = marketReason(-1);
  const buyReason = marketReason(1);
  const pReason = isPending ? pendingReason() : null;

  const submitMarket = (dir: Direction) => {
    if (ctrl.marketOrder(dir, qtyFor(dir), sl, tp)) ctrl.updateForm({ draft: null, slText: '', tpText: '' });
  };

  /** 仓位输入框 − / + 的步长：手数 / 币数按数量步长，USDT 按 usdt_step，百分比按 1 */
  const stepOf = (k: SizeMode) => (k === 'lots' ? spec.qty_step : k === 'notional' || k === 'cost' ? DEFAULTS.trading_panel.usdt_step : 1);

  // 止损 / 止盈的 − / +
  const atr = ctrl.atr();
  const step = spec.tick_size * 100;
  // 止盈止损价、挂单价按 2 位小数给（D58）
  const round = (x: number) => Number((Math.round(x * 100) / 100).toFixed(2));
  const base = isPending && pendingPrice !== null ? pendingPrice : bid;
  const nudge = (key: 'slText' | 'tpText' | 'priceText', sign: 1 | -1, atrMultiple: number) => {
    const cur = parse(f[key]);
    if (cur !== null) return ctrl.updateForm({ [key]: String(round(cur + sign * step)) });
    const dist = atr !== null ? atr * atrMultiple : bid * 0.002 * atrMultiple;
    ctrl.updateForm({ [key]: String(round((key === 'priceText' ? bid : base) + sign * dist)) });
  };

  // 估算
  const entry = entryFor(d);
  const units = unitsOf(q, spec);
  const margin = positionMargin(q, entry, spec, acc.s.leverage);
  const entryFee = fillFee(spec, q, entry, !!kindName?.endsWith('限价'));
  const slLoss = sl !== null && (entry - sl) * d > 0 ? lossPerUnitAtStop(d, entry, sl, spec) * units : null;
  const tpGain = tp !== null && (tp - entry) * d > 0 ? (tp - entry) * d * units - entryFee - fillFee(spec, q, tp, true) : null;
  // 挂单不计入当前强平价；这里估算的是「若这张单成交」之后的强平价（规格书 6.7 节）
  const sameSide = acc.s.positions.filter((p) => p.direction === d);
  const liq = q > 0 ? liquidationPrice([...sameSide, { direction: d, qty: q, entry_price: entry }], acc.s.balance - entryFee, spec, acc.s.leverage) : null;
  const ref = d === 1 ? bid : ask;
  let notional = units * bid;
  for (const p of sameSide) notional += unitsOf(p.qty, spec) * bid;
  const realLev = m.equity > 0 ? notional / m.equity : null;
  const shownReason = isPending ? pReason : d === 1 ? buyReason : sellReason;
  const submitDraft = () => (isPending ? ctrl.placePending(d, pendingPrice!, q, sl, tp) : ctrl.submitMarketDraft(q));
  draftSubmit.current = f.draft === null ? null : { reason: isPending ? pReason : shownReason, submit: submitDraft };
  if (collapsed) return collapsedView;
  const pendingWarn = isPending && held !== undefined && held !== d ? `现在持有${held === 1 ? '多' : '空'}单：这张单触发时若仍未平仓，会因不允许锁仓而撤销` : null;

  return (
    <aside class="order-panel">
      <div class="panel-head">
        <b>{view.symbol}</b>
        <button class="icon" title="收起" onClick={toggle}>
          ›
        </button>
      </div>
      {isBinance && (
        <div class="leverage-row">
          <span class="muted">全仓</span>
          <button class="leverage-button" disabled={levReason !== null && !levOpen} title={levReason ?? '点这里改杠杆'}
            onClick={() => setLevOpen(!levOpen)}>
            杠杆 <b>{lev} 倍</b> {levReason ? '' : '▾'}
          </button>
          {levReason && <span class="field-note">{levReason}</span>}
        </div>
      )}
      {isBinance && levOpen && (
        <LeverageEditor current={lev} min={spec.leverage?.min ?? 1} max={spec.leverage?.max ?? lev} presets={levPresets}
          reason={levReason} onPick={pickLeverage} onClose={() => setLevOpen(false)} />
      )}
      <div class="quote-buttons">
        <button class="quote sell" disabled={isPending ? !ctrl.canAdvance() : sellReason !== null}
          title={isPending ? '挂卖单' : (sellReason ?? `卖出 ${qtyText(q, spec.qty_step)}`)}
          onClick={() => (isPending ? ctrl.startDraft('pending', -1) : submitMarket(-1))}
          data-selected={isPending && d === -1 ? '1' : undefined}>
          <span>卖出</span>
          <b>{quote(bid, precision)}</b>
        </button>
        <button class="quote buy" disabled={isPending ? !ctrl.canAdvance() : buyReason !== null}
          title={isPending ? '挂买单' : (buyReason ?? `买入 ${qtyText(q, spec.qty_step)}`)}
          onClick={() => (isPending ? ctrl.startDraft('pending', 1) : submitMarket(1))}
          data-selected={isPending && d === 1 ? '1' : undefined}>
          <span>买入</span>
          <b>{quote(ask, precision)}</b>
        </button>
        {spread > 0 && <span class="spread-tag">{spread} 美元</span>}
      </div>
      {/* D80：市价单在排队时，按钮正下方写明方向、笔数和合计数量（就在刚点的地方，不会以为没点上） */}
      {queued && (
        <div class="queued-note">
          待成交 {queued.direction === 1 ? '买入' : '卖出'} ×{queued.count}（共 {qtyText(queued.qty, spec.qty_step)} {unit || view.symbol.replace(/USDT$/, '')}）· 按空格成交
        </div>
      )}
      {/* 不能下单的原因放在按钮正下方，窄屏时也看得见 */}
      {shownReason && <div class="order-reason">{shownReason}</div>}
      <div class="segmented order-type">
        <button class={isPending ? '' : 'active'} onClick={() => ctrl.updateForm({ tab: 'market', draft: null, priceText: '' })}>
          市价
        </button>
        <button class={isPending ? 'active' : ''} disabled={!ctrl.canAdvance()} onClick={() => ctrl.startDraft('pending', d)}>
          挂单
        </button>
      </div>
      {isPending && <div class="field-note">先点上面的「卖出 / 买入」选方向（当前：{d === 1 ? '买入' : '卖出'}）</div>}

      {isPending && (
        <>
          <div class="field-label">
            挂单价 {kindName && <b class={d === 1 ? 'buy-text' : 'sell-text'}>→ {kindName}</b>}
          </div>
          <Stepper text={f.priceText} onText={(t) => ctrl.updateForm({ priceText: t })} placeholder="价格" unit="价格"
            onMinus={() => nudge('priceText', -1, 1)} onPlus={() => nudge('priceText', 1, 1)} />
        </>
      )}

      <div class="field-label">仓位</div>
      <div class="segmented size-mode">
        {([[isBinance ? qtyUnit : 'lots', isBinance ? '数量' : '手数'], ['margin', '保证金%'], ['risk', '风险%']] as Array<[SizeMode, string]>).map(([k, label]) => (
          <button key={label} class={(isQtyUnit(k) ? isQtyUnit(shownMode) : shownMode === k) ? 'active' : ''} onClick={() => chooseMode(k)}>
            {label}
          </button>
        ))}
      </div>
      {isBinance && isQtyUnit(shownMode) && (
        <div class="segmented size-mode qty-unit">
          {([['notional', 'USDT 名义'], ['cost', 'USDT 保证金'], ['lots', unit]] as Array<[QtyUnit, string]>).map(([k, label]) => (
            <button key={k} class={shownMode === k ? 'active' : ''} onClick={() => chooseUnit(k)}
              title={k === 'notional' ? '仓位总大小 = 数量 × 价格' : k === 'cost' ? '押进去的本金 = 名义价值 ÷ 杠杆' : `直接填${unit}的个数`}>
              {label}
            </button>
          ))}
        </div>
      )}
      <Stepper
        text={values[shownMode]}
        onText={setValue}
        unit={shownMode === 'lots' ? unit : shownMode === 'notional' || shownMode === 'cost' ? 'USDT' : '%'}
        onMinus={() => setValue(String(Math.max(0, Number(((parse(values[shownMode]) ?? 0) - stepOf(shownMode)).toFixed(4)))))}
        onPlus={() => setValue(String(Number(((parse(values[shownMode]) ?? 0) + stepOf(shownMode)).toFixed(4))))}
      />
      {isBinance ? (
        <div class="field-note size-summary">
          {q > 0 ? <>= <b>{qtyText(q, spec.qty_step)} {unit}</b> · 名义 {money(units * entry)} USDT · 保证金 {money(margin)} USDT（占净值 {pct(m.equity > 0 ? margin / m.equity : null, 1)}）</> : '= —'}
          {shownMode !== 'lots' && '（向下取整）'}
        </div>
      ) : shownMode !== 'lots' && <div class="field-note">= {q > 0 ? `${qtyText(q, spec.qty_step)} ${unit}` : '—'}（向下取整）</div>}

      <div class="field-label">止盈</div>
      <Stepper text={f.tpText} onText={(t) => ctrl.updateForm({ tpText: t })} placeholder="未设置" unit="价格" clearable
        onMinus={() => nudge('tpText', -1, DEFAULTS.trading_panel.default_tp_atr)}
        onPlus={() => nudge('tpText', 1, DEFAULTS.trading_panel.default_tp_atr)} />
      <div class="field-label">止损</div>
      <Stepper text={f.slText} onText={(t) => ctrl.updateForm({ slText: t })} placeholder="未设置" unit="价格" clearable
        onMinus={() => nudge('slText', -1, DEFAULTS.trading_panel.default_sl_atr)}
        onPlus={() => nudge('slText', 1, DEFAULTS.trading_panel.default_sl_atr)} />
      <div class="field-note">
        空着时点 − 放{isPending ? '挂单价' : '现价'}下方、+ 放上方（止损 {DEFAULTS.trading_panel.default_sl_atr}×ATR、止盈 {DEFAULTS.trading_panel.default_tp_atr}×ATR）
      </div>

      {(isPending || f.draft !== null) && (
        <div class="draft-bar">
          <button class={`primary submit ${d === 1 ? 'buy' : 'sell'}`} disabled={(isPending ? pReason : shownReason) !== null}
            onClick={submitDraft}>
            提交 {isPending ? (kindName ?? (d === 1 ? '买入挂单' : '卖出挂单')) : d === 1 ? '买入' : '卖出'} {qtyText(q, spec.qty_step)} {unit}
          </button>
          <button onClick={() => ctrl.cancelDraft()} title="Esc">
            取消
          </button>
        </div>
      )}
      {pendingWarn && <div class="field-note warn-note">{pendingWarn}</div>}

      <dl class="order-info">
        <dt>按{d === 1 ? '买入' : '卖出'}估算</dt>
        <dd>{q > 0 ? `${qtyText(q, spec.qty_step)} ${unit}` : '—'}</dd>
        {isPending && (
          <>
            <dt>预计成交价</dt>
            <dd>{pendingPrice !== null ? quote(entry, precision) : '—'}</dd>
          </>
        )}
        <dt>名义价值</dt>
        <dd>{money(units * entry)}</dd>
        <dt>{isPending ? '预占保证金' : '保证金'}</dt>
        <dd>
          {money(margin)}
          <small>（净值 {pct(m.equity > 0 ? margin / m.equity : null, 1)}）</small>
        </dd>
        <dt>每 1 美元盈亏</dt>
        <dd>{money(units)}</dd>
        <dt>止损亏损</dt>
        <dd class={slLoss !== null ? 'loss' : ''}>
          {slLoss !== null ? `−${money(slLoss)}` : '—'}
          {slLoss !== null && <small>（{pct(m.equity > 0 ? slLoss / m.equity : null)}）</small>}
        </dd>
        <dt>止盈盈利</dt>
        <dd class={tpGain !== null ? 'profit' : ''}>{tpGain !== null ? signedMoney(tpGain) : '—'}</dd>
        <dt>{isPending ? '成交后强平价' : '下单后强平价'}</dt>
        <dd>
          {liq !== null ? price2(liq) : '无'}
          {liq !== null && <small>（距现价 {pct(Math.abs(liq - ref) / ref)}）</small>}
        </dd>
        <dt>{isPending ? '成交后真实杠杆' : '下单后真实杠杆'}</dt>
        <dd>{realLev !== null ? `${realLev.toFixed(2)} 倍` : '—'}</dd>
      </dl>
    </aside>
  );
}

/** 改杠杆的小框（D72，币安）：快捷倍数按钮 + 输入整数；不能改时只显示原因 */
function LeverageEditor(props: { current: number; min: number; max: number; presets: number[]; reason: string | null;
  onPick: (x: number) => void; onClose: () => void }) {
  const [text, setText] = useState(String(props.current));
  const x = Number(text);
  const bad = !Number.isInteger(x) || x < props.min || x > props.max ? `请输入 ${props.min}–${props.max} 的整数` : null;
  return (
    <div class="leverage-editor">
      {props.reason ? <div class="field-note">{props.reason}</div> : (
        <>
          <div class="leverage-presets">
            {props.presets.map((p) => (
              <button key={p} class={p === props.current ? 'active' : ''} onClick={() => props.onPick(p)}>{p} 倍</button>
            ))}
          </div>
          <div class="leverage-input">
            <input type="text" inputMode="numeric" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && !bad && props.onPick(x)} aria-label="杠杆倍数" />
            <span class="muted">倍</span>
            <button class="primary" disabled={bad !== null} onClick={() => props.onPick(x)}>确定</button>
            <button onClick={props.onClose}>取消</button>
          </div>
          <div class="field-note">{bad ?? `范围 ${props.min}–${props.max} 倍；只影响之后开仓占用的保证金，不改变止损亏多少`}</div>
        </>
      )}
    </div>
  );
}

/** 输入框两边带 − / + 的数字框（照 Exness） */
function Stepper(props: { text: string; onText: (t: string) => void; onMinus: () => void; onPlus: () => void; unit: string; placeholder?: string; clearable?: boolean }) {
  return (
    <div class="stepper">
      <input type="text" inputMode="decimal" value={props.text} placeholder={props.placeholder}
        onInput={(e) => props.onText((e.target as HTMLInputElement).value)} />
      {props.clearable && props.text !== '' ? (
        <button class="unit clear" title="取消" onClick={() => props.onText('')}>
          ×
        </button>
      ) : (
        <span class="unit">{props.unit}</span>
      )}
      <button onClick={props.onMinus}>−</button>
      <button onClick={props.onPlus}>+</button>
    </div>
  );
}
