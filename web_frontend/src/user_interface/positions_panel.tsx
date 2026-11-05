// 底部持仓面板（规格书 5.6、6.1 节，照 Exness）：标签页「持仓 / 挂单 / 已平仓 / 出入金」；每行一笔，
// 持仓行：点止盈 / 止损格子就地修改（止损格旁有「保本」），行尾「平仓 ×」全平；
//   「盈亏」只算剩下的仓位，部分平过仓的在后面用灰字写「已平 +x」（D78，照 Exness）；
//   排队等成交的市价单在持仓表最上面显示灰色「待成交」行，页签写「持仓(N) · 待成交 M」（D80）；
//   点手数格子弹出部分平仓小菜单（用户 2026-10-22）：25% / 50% / 75% 写明平多少、大约盈亏多少，点了直接平；
//   自定义：Exness 品种填手数，币圈品种填 USDT 名义价值（按现价换算成数量，向下取到数量步长，输入框下实时显示换算结果）。
//   数量按交易规则同样的方式取整：不足最小单位的选项变灰；剩余部分会低于最小单位时直接全平（写明「全部」）。
//   菜单浮在格子上方，不改变表格宽度。每笔持仓前有「#编号」，与图上持仓线、止盈止损线的编号一致。
// 标签栏右侧有「全部平仓」。界面不显示 R（D58，数据里仍记第一次止损价，留给第 5 阶段报告）。时间只显示星期和时刻（盲练不漏日期，15.7 节）。
// 高度按「占窗口高度的比例」记住（用户 2026-10-21 定）：默认 25%，拖动范围 8%–60%，且至少 60 像素；可收起成只剩标签的一条。
import { useEffect, useState } from 'preact/hooks';
import { closePrice, floorToStep, spreadOf } from '../trading_rules/margin_and_liquidation';
import { pendingName, type Position } from '../trading_rules/order_fills_and_costs';
import { CLOSE_REASON_TEXT, money, price2, qtyText, quote, signedMoney, weekdayTime } from './format_helpers';
import { KIND_TEXT, type PracticeController, type PracticeView } from './practice_controller';
import { local } from './shared_settings';

const DEFAULT_PANEL_RATIO = 0.25;
const clampRatio = (r: number) => Math.min(Math.max(r, 0.08), 0.6);
const ratioToPx = (r: number) => Math.max(60, Math.round(window.innerHeight * clampRatio(r)));


export function PositionsPanel({ ctrl, view, hint }: { ctrl: PracticeController; view: PracticeView; hint: string }) {
  const [tab, setTab] = useState(0);
  const [ratio, setRatio] = useState(() => clampRatio(local.get<number>('positions_panel_ratio', DEFAULT_PANEL_RATIO)));
  const [height, setHeight] = useState(() => ratioToPx(ratio));
  // 窗口大小变了（换屏幕、拖窗口）就按比例重新算高度
  useEffect(() => {
    const onResize = () => setHeight(ratioToPx(ratio));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [ratio]);
  const [collapsed, setCollapsed] = useState(() => local.get('positions_panel_collapsed', false));

  const startDrag = (e: PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let h = startH;
    const move = (ev: PointerEvent) => {
      h = ratioToPx((startH + (startY - ev.clientY)) / window.innerHeight);
      setHeight(h);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const r = clampRatio(h / window.innerHeight);
      setRatio(r);
      local.set('positions_panel_ratio', r);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const toggle = () => {
    setCollapsed(!collapsed);
    local.set('positions_panel_collapsed', !collapsed);
  };

  const s = ctrl.account.s;
  const tabs = [`持仓(${s.positions.length})${s.queue.length ? ` · 待成交 ${s.queue.length}` : ''}`, `挂单(${s.pending.length})`, `已平仓(${s.trades.length})`, `出入金(${s.transfers.length})`];
  return (
    <section class="positions-panel" style={{ height: collapsed ? undefined : `${height}px` }}>
      {!collapsed && <div class="resize-handle" onPointerDown={startDrag} title="拖动调整高度" />}
      <div class="panel-tabs">
        {tabs.map((t, i) => (
          <button key={i} class={tab === i ? 'tab active' : 'tab'} onClick={() => setTab(i)}>
            {t}
          </button>
        ))}
        <span class="hint">{hint}</span>
        {s.positions.length > 0 && (
          <button disabled={!ctrl.canAdvance()} onClick={() => ctrl.closeAllPositions()} title="按现价全部平仓">
            全部平仓
          </button>
        )}
        <button class="icon" title={collapsed ? '展开' : '收起'} onClick={toggle}>
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <div class="panel-body">
          {tab === 0 && <OpenPositions ctrl={ctrl} view={view} />}
          {tab === 1 && <PendingOrders ctrl={ctrl} view={view} />}
          {tab === 2 && <ClosedTrades ctrl={ctrl} view={view} />}
          {tab === 3 && <Transfers ctrl={ctrl} />}
        </div>
      )}
    </section>
  );
}

function usePriceFormat(view: PracticeView) {
  const p = view.market.price_precision;
  return (x: number | null) => quote(x, p);
}

function OpenPositions({ ctrl, view }: { ctrl: PracticeController; view: PracticeView }) {
  const fmt = usePriceFormat(view);
  const [editing, setEditing] = useState<string | null>(null); // 例 "sl3"：正在改 3 号仓位的止损
  const [closing, setClosing] = useState<{ id: number; rect: DOMRect } | null>(null); // 正在弹部分平仓菜单的持仓
  const s = ctrl.account.s;
  const spec = ctrl.marketSpec;
  if (s.positions.length === 0 && s.queue.length === 0) return <p class="muted pad">暂无持仓。用右侧面板的「卖出 / 买入」下单。</p>;
  const can = ctrl.canAdvance();
  const toNum = (t: string) => (t.trim() === '' ? null : Number(t.replace(/,/g, '')));
  const closingPos = closing ? s.positions.find((p) => p.id === closing.id) : undefined;
  return (
    <>
    <table class="data-table compact">
      <thead>
        <tr>
          <th>#</th><th>品种</th><th>方向</th><th class="num">手数（可部分平仓）</th><th class="num">开仓价</th><th class="num">现价</th>
          <th class="num">止盈</th><th class="num">止损</th><th class="num">盈亏</th><th />
        </tr>
      </thead>
      <tbody>
        {/* D80：排队等成交的市价单排在最上面，灰色；按「下一根」或空格后变成真正的持仓（排队中不能撤，D76） */}
        {s.queue.map((q) => (
          <tr key={`q${q.id}`} class="queued-row">
            <td class="muted">—</td>
            <td>{view.symbol}</td>
            <td class={q.direction === 1 ? 'buy-text' : 'sell-text'}>{q.direction === 1 ? '买入' : '卖出'}</td>
            <td class="num">{qtyText(q.qty, spec.qty_step)}</td>
            <td class="num">待成交</td>
            <td class="num">—</td>
            <td class="num">{price2(q.tp)}</td>
            <td class="num">{price2(q.sl)}</td>
            <td class="num">—</td>
            <td class="muted small">按「下一根」或空格成交</td>
          </tr>
        ))}
        {s.positions.map((p) => {
          const pnl = ctrl.positionPnl(p);
          const cell = (key: string) => ({ editing: editing === `${key}${p.id}`, start: () => can && setEditing(`${key}${p.id}`), stop: () => setEditing(null) });
          return (
            <tr key={p.id}>
              <td class="muted">#{ctrl.positionNo(p.id)}</td>
              <td>{view.symbol}</td>
              <td class={p.direction === 1 ? 'buy-text' : 'sell-text'}>{p.direction === 1 ? '买入' : '卖出'}</td>
              <td class={`num editable${closing?.id === p.id ? ' active' : ''}`} title="点击选择部分平仓"
                onClick={(e) => can && setClosing(closing?.id === p.id ? null : { id: p.id, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>
                {qtyText(p.qty, spec.qty_step)}
              </td>
              <td class="num">{fmt(p.entry_price)}</td>
              <td class="num">{fmt(s.last_bid === null ? null : closePrice(p.direction, s.last_bid, spec))}</td>
              <InlineCell {...cell('tp')} title="点击修改止盈（清空 = 取消），回车保存，Esc 取消" display={price2(p.tp)}
                initial={p.tp === null ? '' : String(p.tp)} placeholder="未设置"
                onCommit={(t) => ctrl.setStops(p.id, p.sl, toNum(t))} />
              <InlineCell {...cell('sl')} title="点击修改止损（清空 = 取消），回车保存，Esc 取消" display={price2(p.sl)}
                initial={p.sl === null ? '' : String(p.sl)} placeholder="未设置"
                onCommit={(t) => ctrl.setStops(p.id, toNum(t), p.tp)}
                extra={{ label: '保本', title: '止损移到开仓价', value: String(p.entry_price) }} />
              <td class={`num ${pnl > 0 ? 'profit' : pnl < 0 ? 'loss' : ''}`}>
                {signedMoney(pnl)}
                {/* D78：盈亏只算剩下的仓位；部分平过仓时，灰字写已平部分的盈亏（已进余额） */}
                {p.exits.length > 0 && <span class="muted small closed-part" title="已经平掉的部分的盈亏，钱已进交易账户余额">已平 {signedMoney(ctrl.closedPartPnl(p))}</span>}
              </td>
              <td class="row-actions">
                <button class="link" disabled={!can} title="按现价全部平掉这一笔" onClick={() => ctrl.closePosition(p.id)}>平仓 ×</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    {closing && closingPos && can && <PartialCloseMenu ctrl={ctrl} p={closingPos} rect={closing.rect} onDone={() => setClosing(null)} />}
    </>
  );
}

/** 交易规则里平仓数量的取整（与 order_fills_and_costs.ts 的 closePosition 一致）：向下取到步长；剩余低于最小单位则全平 */
function effectiveCloseQty(p: Position, qty: number, step: number, minQty: number): number {
  const q = floorToStep(qty, step);
  return q > p.qty - minQty + 1e-9 ? p.qty : q;
}

/** 部分平仓小菜单：浮在手数格子上方（position: fixed，不撑宽表格）；点别处或 Esc 关闭 */
function PartialCloseMenu({ ctrl, p, rect, onDone }: { ctrl: PracticeController; p: Position; rect: DOMRect; onDone: () => void }) {
  const spec = ctrl.marketSpec;
  const exness = spec.platform === 'exness';
  const unit = exness ? '手' : ctrl.view.symbol.replace(/USDT$/, '');
  const [text, setText] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onDone();
    const onDown = (e: PointerEvent) => !(e.target as Element).closest?.('.partial-close-menu, td.editable.active') && onDone();
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, []);
  const bid = ctrl.account.s.last_bid;
  const price = bid === null ? null : closePrice(p.direction, bid, spec);
  const tooSmall = (q: number) => q < spec.min_qty - 1e-9;
  const option = (q: number) => {
    const all = Math.abs(q - p.qty) < 1e-9;
    return `${qtyText(q, spec.qty_step)} ${unit}${all ? '（全部）' : ''} ≈ ${signedMoney(ctrl.partialCloseEstimate(p, q))}`;
  };
  const close = (q: number) => {
    if (ctrl.closePosition(p.id, q)) onDone();
  };
  // 自定义：Exness 填手数；币圈填 USDT 名义价值，按现价换算成数量
  const typed = Number(text.replace(/,/g, '').trim());
  const rawQty = text.trim() === '' || !Number.isFinite(typed) || typed <= 0 ? null : exness ? typed : price ? typed / price : null;
  const customQty = rawQty === null ? null : effectiveCloseQty(p, Math.min(rawQty, p.qty), spec.qty_step, spec.min_qty);
  const customReason = rawQty === null ? null
    : exness && Math.abs(floorToStep(typed, spec.qty_step) - typed) > 1e-9 ? `手数要是 ${spec.qty_step} 的倍数`
    : tooSmall(customQty!) ? `不足最小 ${spec.min_qty} ${unit}`
    : null;
  return (
    <div class="partial-close-menu" style={{ left: `${Math.round(rect.left)}px`, bottom: `${Math.round(window.innerHeight - rect.top + 4)}px` }}>
      <div class="pc-title">部分平仓 #{ctrl.positionNo(p.id)}（持有 {qtyText(p.qty, spec.qty_step)} {unit}）</div>
      {[0.25, 0.5, 0.75].map((r) => {
        const q = effectiveCloseQty(p, p.qty * r, spec.qty_step, spec.min_qty);
        const small = tooSmall(q);
        return (
          <button key={r} class="pc-option" disabled={small} onClick={() => close(q)}
            title={small ? `按 ${r * 100}% 算不足最小 ${spec.min_qty} ${unit}` : `按现价平掉 ${qtyText(q, spec.qty_step)} ${unit}`}>
            <b>{r * 100}%</b>
            <span>{small ? `不足最小 ${spec.min_qty} ${unit}` : option(q)}</span>
          </button>
        );
      })}
      <div class="pc-custom">
        <input type="text" inputMode="decimal" value={text} placeholder={exness ? '自定义手数' : '自定义金额'} ref={(el) => el?.focus()}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && customQty !== null && !customReason && close(customQty)} />
        <span class="muted">{exness ? '手' : 'USDT'}</span>
        <button class="primary" disabled={customQty === null || customReason !== null} onClick={() => customQty !== null && close(customQty)}>平仓</button>
      </div>
      <div class="pc-note">
        {customReason ?? (customQty !== null ? `将平 ${option(customQty)}` : exness ? `填 ${spec.qty_step} 的倍数` : '按现价名义价值换算成数量')}
      </div>
    </div>
  );
}

/**
 * 点一下就地变成输入框的表格格子：回车提交（提交成功才收起），Esc 或点别处取消。
 * extra：输入框旁的快捷按钮（止损格的「保本」：填入开仓价并立即提交）。
 */
function InlineCell(props: {
  editing: boolean; start: () => void; stop: () => void; display: string; initial: string; placeholder: string; title: string;
  onCommit: (text: string) => boolean | undefined; extra?: { label: string; title: string; value: string };
}) {
  const [text, setText] = useState(props.initial);
  useEffect(() => {
    if (props.editing) setText(props.initial);
  }, [props.editing]);
  if (!props.editing) {
    return (
      <td class="num editable" title={props.title} onClick={props.start}>
        {props.display}
      </td>
    );
  }
  const commit = (t: string) => {
    if (props.onCommit(t)) props.stop();
  };
  return (
    <td class="num editing">
      <input type="text" inputMode="decimal" value={text} placeholder={props.placeholder} ref={(el) => el?.focus()}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); // 直接读输入框里此刻的内容
          if (e.key === 'Escape') props.stop();
        }}
        onBlur={props.stop} />
      {props.extra && (
        <button class="link" title={props.extra.title} onMouseDown={(e) => e.preventDefault()} onClick={() => commit(props.extra!.value)}>
          {props.extra.label}
        </button>
      )}
    </td>
  );
}

/** 挂单列表：点挂单价 / 手数 / 止盈 / 止损格子就地修改（价位越过现价时类型自动切换），行尾「撤单 ×」 */
function PendingOrders({ ctrl, view }: { ctrl: PracticeController; view: PracticeView }) {
  const fmt = usePriceFormat(view);
  const [editing, setEditing] = useState<string | null>(null);
  const s = ctrl.account.s;
  const spec = ctrl.marketSpec;
  const offset = ctrl.settingsSnapshot.utc_offset_hours;
  if (s.pending.length === 0) return <p class="muted pad">暂无挂单。用价格轴上的「+」或右侧面板的「挂单」下单。</p>;
  const can = ctrl.canAdvance();
  const toNum = (t: string) => (t.trim() === '' ? null : Number(t.replace(/,/g, '')));
  return (
    <table class="data-table compact">
      <thead>
        <tr>
          <th>品种</th><th>类型</th><th class="num">手数</th><th class="num">挂单价</th><th class="num">现价</th>
          <th class="num">止盈</th><th class="num">止损</th><th>挂出时刻</th><th />
        </tr>
      </thead>
      <tbody>
        {s.pending.map((o) => {
          const cell = (key: string) => ({ editing: editing === `${key}${o.id}`, start: () => can && setEditing(`${key}${o.id}`), stop: () => setEditing(null) });
          const market = s.last_bid === null ? null : o.direction === 1 ? s.last_bid + spreadOf(spec) : s.last_bid;
          return (
            <tr key={o.id}>
              <td>{view.symbol}</td>
              <td class={o.direction === 1 ? 'buy-text' : 'sell-text'}>{KIND_TEXT[pendingName(o.direction, o.kind)]}</td>
              <InlineCell {...cell('qty')} title="点击修改手数，回车保存" display={qtyText(o.qty, spec.qty_step)} initial={qtyText(o.qty, spec.qty_step)}
                placeholder="手数" onCommit={(t) => toNum(t) !== null && ctrl.modifyPending(o.id, o.price, toNum(t)!, o.sl, o.tp)} />
              <InlineCell {...cell('price')} title="点击修改挂单价，回车保存（越过现价时类型自动切换）" display={fmt(o.price)} initial={String(o.price)}
                placeholder="挂单价" onCommit={(t) => toNum(t) !== null && ctrl.modifyPending(o.id, toNum(t)!, o.qty, o.sl, o.tp)} />
              <td class="num">{fmt(market)}</td>
              <InlineCell {...cell('tp')} title="点击修改止盈（清空 = 取消），回车保存" display={price2(o.tp)} initial={o.tp === null ? '' : String(o.tp)}
                placeholder="未设置" onCommit={(t) => ctrl.modifyPending(o.id, o.price, o.qty, o.sl, toNum(t))} />
              <InlineCell {...cell('sl')} title="点击修改止损（清空 = 取消），回车保存" display={price2(o.sl)} initial={o.sl === null ? '' : String(o.sl)}
                placeholder="未设置" onCommit={(t) => ctrl.modifyPending(o.id, o.price, o.qty, toNum(t), o.tp)} />
              <td>{weekdayTime(o.placed_ms, offset)}</td>
              <td class="row-actions">
                <button class="link" title="撤销这张挂单" onClick={() => ctrl.cancelPending(o.id)}>撤单 ×</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ClosedTrades({ ctrl, view }: { ctrl: PracticeController; view: PracticeView }) {
  const fmt = usePriceFormat(view);
  const s = ctrl.account.s;
  const offset = ctrl.settingsSnapshot.utc_offset_hours;
  if (s.trades.length === 0) return <p class="muted pad">还没有平仓的交易。</p>;
  return (
    <table class="data-table compact">
      <thead>
        <tr>
          <th>方向</th><th class="num">手数</th><th class="num">开仓价</th><th class="num">平仓价</th><th>出场</th>
          <th class="num">盈亏</th><th class="num">交易成本</th><th>开仓</th><th>平仓</th>
        </tr>
      </thead>
      <tbody>
        {[...s.trades].reverse().map((t) => (
          <tr key={t.position_id}>
            <td class={t.direction === 1 ? 'buy-text' : 'sell-text'}>{t.direction === 1 ? '买入' : '卖出'}</td>
            <td class="num">{qtyText(t.qty, ctrl.marketSpec.qty_step)}</td>
            <td class="num">{fmt(t.entry_price)}</td>
            <td class="num">{fmt(t.exit_price_avg)}</td>
            <td>{CLOSE_REASON_TEXT[t.close_reason] ?? t.close_reason}{t.exits.length > 1 ? `（分 ${t.exits.length} 次）` : ''}</td>
            <td class={`num ${t.pnl > 0 ? 'profit' : 'loss'}`}>{signedMoney(t.pnl)}</td>
            <td class="num" title={`点差 ${money(t.spread_cost)} · 滑点 ${money(t.slippage_cost)} · 手续费 ${money(t.fees)}`}>
              {money(t.spread_cost + t.slippage_cost + t.fees)}
            </td>
            <td>{weekdayTime(t.open_ms, offset)}</td>
            <td>{weekdayTime(t.close_ms, offset)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Transfers({ ctrl }: { ctrl: PracticeController }) {
  const s = ctrl.account.s;
  const offset = ctrl.settingsSnapshot.utc_offset_hours;
  if (s.transfers.length === 0) return <p class="muted pad">还没有出入金。点顶栏的账户摘要可以划转。</p>;
  return (
    <table class="data-table compact">
      <thead>
        <tr>
          <th>时刻</th><th>方向</th><th class="num">金额</th><th class="num">当时交易账户净值</th><th>当时有持仓</th>
        </tr>
      </thead>
      <tbody>
        {[...s.transfers].reverse().map((t, i) => (
          <tr key={i}>
            <td>{weekdayTime(t.ms, offset)}</td>
            <td>{t.direction === 'to_funding' ? '出金（交易 → 资金）' : '入金（资金 → 交易）'}</td>
            <td class="num">{money(t.amount)}</td>
            <td class="num">{money(t.equity_before)}</td>
            <td>{t.had_positions ? '是' : '否'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
