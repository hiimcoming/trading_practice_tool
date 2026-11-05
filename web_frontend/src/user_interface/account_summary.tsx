// 顶栏账户摘要（规格书 5.6、6.1、6.6 节，D56、D63；在顶栏第 2 行右侧）：总资产（交易账户净值 + 资金账户）、初始资金（开局总资产）、
// 交易账户净值和浮动盈亏（绿盈红亏）、真实杠杆、保证金占用——杠杆和保证金紧跟交易账户，因为它们按交易账户算；超过阈值变色
// （阈值在 common_settings/default_settings.json 的 account_warnings：真实杠杆 ≥ 3 倍为重仓，D31）。
// 点一下展开：交易账户（余额、净值、已用 / 可用保证金、保证金水平、预估强平价）和资金账户，以及划转表单。
// 出金上限 = min(余额, 可用保证金)：浮动盈利不能提走；可用保证金已扣挂单预占（D60）；入金不超过资金账户余额。
import { useEffect, useRef, useState } from 'preact/hooks';
import { maxWithdraw } from '../trading_rules/margin_and_liquidation';
import { money, pct, price2, signedMoney } from './format_helpers';
import type { PracticeController, PracticeView } from './practice_controller';
import { DEFAULTS } from './shared_settings';

export function AccountSummary({ ctrl, view }: { ctrl: PracticeController; view: PracticeView }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const m = ctrl.account.metrics();
  const usage = m.equity > 0 ? m.used_margin / m.equity : null;
  const warn = DEFAULTS.account_warnings;
  const levHot = m.real_leverage !== null && m.real_leverage >= warn.real_leverage;
  const usageHot = usage !== null && usage >= warn.margin_usage;
  return (
    <div class="account-wrap" ref={ref}>
      <button class="account-summary" onClick={() => setOpen(!open)} title="交易账户与资金账户（点开可划转）">
        {/* 窄屏也保留短标签，否则只剩数字看不懂（D63）：总资产 · 初始资金 │ 交易账户 浮动盈亏 · 杠杆 · 保证金 */}
        <span class="muted">总资产 </span>
        <b>{money(m.equity + ctrl.account.s.funding)}</b>
        {view.initialTotalAssets !== null && <span class="muted"> · 初始资金 {money(view.initialTotalAssets)}</span>}
        <span class="sep" />
        <span class="muted">交易账户 </span>
        <b>{money(m.equity)}</b>
        <span class={m.floating_pnl > 0 ? 'profit' : m.floating_pnl < 0 ? 'loss' : 'muted'} title="浮动盈亏（绿色盈利、红色亏损）"> {signedMoney(m.floating_pnl)}</span>
        <span class={levHot ? 'warn' : 'muted'} title="真实杠杆 = 全部持仓名义价值 ÷ 交易账户净值">
          {' '}· 杠杆 {m.real_leverage === null ? '—' : `${m.real_leverage.toFixed(2)} 倍`}
        </span>
        <span class={usageHot ? 'warn' : 'muted'} title="保证金占用 = 已用保证金 ÷ 交易账户净值">
          {' '}· 保证金 {pct(usage, 1)}
        </span>
        <span class="muted"> ▾</span>
      </button>
      {open && (
        <div class="account-dropdown">
          <AccountDetails ctrl={ctrl} view={view} />
          <TransferForm ctrl={ctrl} />
        </div>
      )}
    </div>
  );
}

export function AccountDetails({ ctrl }: { ctrl: PracticeController; view?: PracticeView }) {
  const s = ctrl.account.s;
  const m = ctrl.account.metrics();
  const bid = s.last_bid;
  const dist = m.liquidation_price !== null && bid !== null ? Math.abs(m.liquidation_price - bid) / bid : null;
  return (
    <div class="account-details">
      <div class="account-col">
        <b>交易账户</b>（杠杆 1:{s.leverage}）
        <dl>
          <dt>余额</dt><dd>{money(s.balance)}</dd>
          <dt>净值</dt><dd>{money(m.equity)}</dd>
          <dt>浮动盈亏</dt><dd class={m.floating_pnl > 0 ? 'profit' : m.floating_pnl < 0 ? 'loss' : ''}>{signedMoney(m.floating_pnl)}</dd>
          <dt>已用保证金</dt><dd>{money(m.used_margin)}</dd>
          {m.pending_margin > 0 && (
            <>
              <dt>挂单预占</dt><dd>{money(m.pending_margin)}</dd>
            </>
          )}
          <dt>可用保证金</dt><dd>{money(m.free_margin)}</dd>
          <dt>保证金水平</dt><dd>{m.margin_level === null ? '—' : pct(m.margin_level, 0)}</dd>
          <dt>真实杠杆</dt><dd>{m.real_leverage === null ? '—' : `${m.real_leverage.toFixed(2)} 倍`}</dd>
          <dt>预估强平价</dt>
          <dd>
            {m.liquidation_price === null ? '无' : price2(m.liquidation_price)}
            {dist !== null && <small>（距现价 {pct(dist)}）</small>}
          </dd>
        </dl>
      </div>
      <div class="account-col">
        <b>资金账户</b>（不参与交易）
        <dl>
          <dt>余额</dt><dd>{money(s.funding)}</dd>
          <dt>总资产</dt><dd>{money(m.equity + s.funding)}</dd>
        </dl>
      </div>
    </div>
  );
}

/** 划转表单（顶栏下拉、强平暂停的对话框共用）。onlyIn：只允许转入（强平暂停时） */
export function TransferForm({ ctrl, onlyIn = false, onDone }: { ctrl: PracticeController; onlyIn?: boolean; onDone?: () => void }) {
  const s = ctrl.account.s;
  const m = ctrl.account.metrics();
  const [dir, setDir] = useState<'to_trading' | 'to_funding'>(onlyIn ? 'to_trading' : 'to_funding');
  const [text, setText] = useState('');
  const limit = dir === 'to_funding' ? maxWithdraw(s.balance, m.free_margin) : s.funding;
  const amount = Number(text);
  const submit = () => {
    if (ctrl.transfer(dir, amount)) {
      setText('');
      onDone?.();
    }
  };
  return (
    <div class="transfer-form">
      {!onlyIn && (
        <div class="segmented">
          <button class={dir === 'to_funding' ? 'active' : ''} onClick={() => setDir('to_funding')}>出金（交易 → 资金）</button>
          <button class={dir === 'to_trading' ? 'active' : ''} onClick={() => setDir('to_trading')}>入金（资金 → 交易）</button>
        </div>
      )}
      <div class="transfer-row">
        <input type="text" inputMode="decimal" value={text} placeholder="金额" onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <button class="link" onClick={() => setText(String(Math.floor(limit * 100) / 100))}>全部 {money(limit)}</button>
        <button class="primary" disabled={!(amount > 0)} onClick={submit}>
          {dir === 'to_funding' ? '转出' : onlyIn ? '转入并继续' : '转入'}
        </button>
      </div>
      {dir === 'to_funding' && <div class="field-note">最多可转出 min(余额, 可用保证金)：浮动盈利不能转出。</div>}
    </div>
  );
}
