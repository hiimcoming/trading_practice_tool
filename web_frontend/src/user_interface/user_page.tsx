// 用户页（规格书 5.1、5.7、7 节末尾）：
//   · 开始练习：只放品种、起始周期，全部有默认值并记住上次选择，直接点「开始」即可；背景根数、杠杆、
//     交易账户和资金账户的初始资金放在「高级设置」（D73：不再折叠，放在右侧，浅色小字、标「一般不用改」，引导只选品种和周期；
//     杠杆按品种分别记住上次的选择）；
//   · 品种、周期下面一行小字（D86）：可抽数据几个月（约几年）、按当前周期和背景根数约可练几轮不重复；
//     少于 5 轮橙色提醒「容易抽到练过的行情」，0 轮红色并让「开始」变灰；首尾之间缺月时补一句并链接数据概况页；
//     背景根数按起始周期分别记住（4h、1d 默认 50 根，其余 400 根），想看更早的行情在练习页往左拖即可；
//   · 有进行中的一轮时，显示「继续」和「结束」；
//   · 历史练习列表（第 5a 阶段加：交易笔数、收益率、「简报」「K 线图」入口；D77：最左列「第 N 轮」= 该品种已完成的第几轮，
//     与统计页、简报一致；去掉「片段来源」列，只有复练 / 重复练习模式才在行情片段后加小字）；
//   · 历史练习按品种分开（D79）：顶上一排品种标签（只列练过的，数字 = 已完成轮数）切换下面的表格（表格不再有品种列），
//     默认选最近练过的品种，手动切换后记在这台电脑上；标签旁是当前品种的「统计与审查 →」和「直接看纪律审查」入口；
//     下面「下载我的数据」的品种跟着标签走（下载区自己的选择框仍可改）；
//   · 页面底部：下载我的数据（第 5c 阶段，D70：选品种和范围，下载一份 Markdown 文件）、清除我的全部历史（输入用户名确认，不可恢复）。
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api, type MarketSpec, type PracticeCapacity, type SessionRow, type StatisticsPage } from '../backend_api_client/api_client';
import type { Timeframe } from '../trading_rules/kline_synthesis';
import { navigate } from './app';
import { END_REASON_TEXT, PICK_MODE_TEXT } from './format_helpers';
import { DEFAULTS, backgroundBarsFor, local, withDefaults, type UserSettings } from './shared_settings';
import { CustomDateInputs, customDatesProblem, rangeChoice, savedCustomDates, type CustomDates } from './stats_page';

export function UserPage({ username }: { username: string }) {
  const [display, setDisplay] = useState(username);
  const [active, setActive] = useState<SessionRow | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [markets, setMarkets] = useState<Record<string, MarketSpec>>({});
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 历史练习选中的品种（D79）：手动选过的（记在这台电脑上），否则最近练过的品种
  const [pickedSymbol, setPickedSymbol] = useState<string>(() => local.get(`history_symbol.${username}`, ''));
  const practiced = practicedSymbols(sessions);
  const histSymbol = practiced.includes(pickedSymbol) ? pickedSymbol : practiced[0] ?? '';
  const chooseHistSymbol = (sym: string) => {
    setPickedSymbol(sym);
    local.set(`history_symbol.${username}`, sym);
  };

  const reload = async () => {
    try {
      const [u, m, s] = await Promise.all([api.user(username), api.markets(), api.sessions(username)]);
      setDisplay(u.display_name);
      setActive(u.active_session);
      setSettings(withDefaults(u.settings));
      setMarkets(m.markets);
      setSessions(s.sessions);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '读取失败');
    }
  };
  useEffect(() => void reload(), [username]);

  const update = (patch: Partial<UserSettings>) => settings && setSettings({ ...settings, ...patch });

  const market = settings ? markets[settings.last_symbol] : undefined;
  const lev = market?.leverage as { default: number; min: number; max: number; presets: number[] } | undefined;
  const leverage = settings && lev ? (settings.leverage_by_symbol[settings.last_symbol] ?? lev.default) : 0;
  const setLeverage = (x: number) => settings && update({ leverage_by_symbol: { ...settings.leverage_by_symbol, [settings.last_symbol]: x } });
  const backgroundBars = settings ? backgroundBarsFor(settings, settings.last_start_timeframe) : 0;
  const setBackgroundBars = (x: number) =>
    settings && update({ background_bars_by_timeframe: { ...settings.background_bars_by_timeframe, [settings.last_start_timeframe]: x } });
  const capacity = usePracticeCapacity(settings?.last_symbol, settings?.last_start_timeframe, backgroundBars);

  const start = async () => {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveSettings(username, {
        last_symbol: settings.last_symbol,
        last_start_timeframe: settings.last_start_timeframe,
        background_bars_by_timeframe: settings.background_bars_by_timeframe,
        leverage_by_symbol: settings.leverage_by_symbol,
        trading_balance: settings.trading_balance,
        funding_balance: settings.funding_balance,
      });
      const r = await api.newSession(username, {
        symbol: settings.last_symbol,
        start_timeframe: settings.last_start_timeframe,
        background_bars: backgroundBars,
        leverage: leverage || undefined,
        trading_balance: settings.trading_balance,
        funding_balance: settings.funding_balance,
      });
      navigate(`/u/${encodeURIComponent(username)}/practice/${r.session_id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '开局失败');
      setBusy(false);
    }
  };

  const groups = Object.entries(markets).reduce<Record<string, Array<[string, MarketSpec]>>>((acc, [sym, m]) => {
    const g = m.platform === 'exness' ? 'Exness' : '币安';
    (acc[g] ??= []).push([sym, m]);
    return acc;
  }, {});
  const bg = DEFAULTS.practice_start.background_bars;

  return (
    <div class="page">
      <header class="page-header">
        <h1>{display}</h1>
        <nav>
          <a href="#/">首页</a>
          <a href={`#/u/${encodeURIComponent(username)}/settings`}>设置</a>
        </nav>
      </header>
      {error && <div class="error card">{error}</div>}

      {active && (
        <section class="card active-card">
          <div>
            <b>你有一轮练习还没有结束</b>：{active.symbol} · 起始周期 {active.start_timeframe} · 已走 {active.bars_played} 根
            {active.is_replay ? ' · 复练' : ''}
          </div>
          <div class="muted">未完成的一轮保存 {DEFAULTS.segment_rules.unfinished_keep_days} 天，超过后自动清除（满 300 根的自动结束）。</div>
          <button class="primary" onClick={() => navigate(`/u/${encodeURIComponent(username)}/practice/${active.id}`)}>
            继续练习
          </button>
        </section>
      )}

      {!active && settings && (
        <section class="card start-card">
          <h2>开始练习</h2>
          <div class="start-layout">
          <div class="start-main">
          <div class="form-row">
            <label>品种</label>
            <select value={settings.last_symbol} onChange={(e) => update({ last_symbol: (e.target as HTMLSelectElement).value })}>
              {Object.entries(groups).map(([g, list]) => (
                <optgroup key={g} label={g}>
                  {list.map(([sym, m]) => (
                    <option key={sym} value={sym}>
                      {m.display_name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div class="form-row">
            <label>起始周期</label>
            <div class="segmented">
              {(DEFAULTS.practice_start.start_timeframes as Timeframe[]).map((tf) => (
                <button key={tf} class={settings.last_start_timeframe === tf ? 'active' : ''} onClick={() => update({ last_start_timeframe: tf })}>
                  {tf}
                </button>
              ))}
            </div>
          </div>
          <CapacityLine capacity={capacity} />
          <button class="primary big" disabled={busy || capacity?.rounds === 0} onClick={start}>
            {busy ? '正在抽取片段…' : '开始'}
          </button>
          <div class="muted">选好品种和起始周期，点「开始」就行。满 {DEFAULTS.segment_rules.completion_bars} 根起始周期 K 线即算完成，可以继续练到你点「结束本轮」。</div>
          </div>
          <aside class="start-advanced">
            <h3>高级设置 <span class="muted">一般不用改</span></h3>
              <div class="form-row">
                <label>背景根数</label>
                <input
                  type="number"
                  min={bg.min}
                  max={bg.max}
                  step={50}
                  value={backgroundBars}
                  onInput={(e) => setBackgroundBars(Number((e.target as HTMLInputElement).value))}
                />
                <span class="muted">
                  起点之前先显示多少根 {settings.last_start_timeframe} K 线（{bg.min}–{bg.max}，每个周期分别记住）；越多能练的轮数越少，想看更早的行情在练习时往左拖即可。
                </span>
              </div>
              {lev && (
                <div class="form-row">
                  <label>杠杆</label>
                  <input
                    type="number"
                    min={lev.min}
                    max={lev.max}
                    value={leverage}
                    onInput={(e) => setLeverage(Number((e.target as HTMLInputElement).value))}
                  />
                  <div class="segmented">
                    {lev.presets.map((x) => (
                      <button key={x} class={leverage === x ? 'active' : ''} onClick={() => setLeverage(x)}>
                        {x}
                      </button>
                    ))}
                  </div>
                  <span class="muted">
                    {lev.min}–{lev.max} 倍（默认 {lev.default}）
                  </span>
                </div>
              )}
              <div class="form-row">
                <label>交易账户</label>
                <input
                  type="number"
                  min={1}
                  step={100}
                  value={settings.trading_balance}
                  onInput={(e) => update({ trading_balance: Number((e.target as HTMLInputElement).value) })}
                />
                <span class="muted">初始资金（美元 / USDT）；强平只清空这个账户。</span>
              </div>
              <div class="form-row">
                <label>资金账户</label>
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={settings.funding_balance}
                  onInput={(e) => update({ funding_balance: Number((e.target as HTMLInputElement).value) })}
                />
                <span class="muted">不参与交易；为 0 时强平后无钱可转入，本轮只能结束。</span>
              </div>
          </aside>
          </div>
        </section>
      )}

      <section class="card">
        <h2>历史练习</h2>
        <SymbolTabs username={username} sessions={sessions} chosen={histSymbol} onChoose={chooseHistSymbol} />
        <SessionsTable username={username} sessions={sessions.filter((x) => x.symbol === histSymbol)} />
      </section>

      <ExportData username={username} sessions={sessions} preferred={histSymbol} />
      <ClearHistory username={username} onCleared={() => void reload()} />
    </div>
  );
}

/** 可练轮数（D86）：品种、周期、背景根数变了就重新问后端；输入框连续打字时等停顿 400 毫秒再问，不合法的根数不问 */
function usePracticeCapacity(symbol: string | undefined, tf: Timeframe | undefined, backgroundBars: number): PracticeCapacity | null {
  const [cap, setCap] = useState<PracticeCapacity | null>(null);
  useEffect(() => {
    const bg = DEFAULTS.practice_start.background_bars;
    if (!symbol || !tf || !(backgroundBars >= bg.min && backgroundBars <= bg.max)) {
      setCap(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api
        .practiceCapacity(symbol, tf, backgroundBars)
        .then((r) => alive && setCap(r))
        .catch(() => alive && setCap(null)); // 算不出来只是不显示这一行，不影响开局
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [symbol, tf, backgroundBars]);
  return cap;
}

const FEW_ROUNDS = 5;

/** 「可练数据 60 个月（约 5 年）· 按 1d、背景 50 根约可练 5 轮不重复」；少于 5 轮橙色、0 轮红色（D86） */
function CapacityLine({ capacity: c }: { capacity: PracticeCapacity | null }) {
  if (!c) return null;
  const years = c.months >= 12 ? `（约 ${Math.round((c.months / 12) * 10) / 10} 年）` : '';
  const cls = c.rounds === 0 ? 'error' : c.rounds < FEW_ROUNDS ? 'warn' : 'muted';
  return (
    <div class="capacity-line">
      <span class="muted">
        可练数据 {c.months} 个月{years}
        {c.first_month && ` · ${c.first_month} 至 ${c.last_month}`}
      </span>
      {' · '}
      <span class={cls}>
        按 {c.timeframe}、背景 {c.background_bars} 根约可练 {c.rounds} 轮不重复
        {c.rounds === 0 && '：数据不够，请调小背景根数或换个周期'}
        {c.rounds > 0 && c.rounds < FEW_ROUNDS && '：这个周期容易抽到练过的行情'}
      </span>
      {c.missing_months.length > 0 && (
        <span class="warn-note">
          {' · '}中间缺 {c.missing_months.length} 个月（<a href="#/data">看数据概况</a>）
        </span>
      )}
    </div>
  );
}

/** 练过的品种（含只有进行中一轮的），按最近练习先后排；第一个就是「最近练过的品种」 */
function practicedSymbols(sessions: SessionRow[]): string[] {
  const latest = new Map<string, string>();
  for (const s of sessions) if ((latest.get(s.symbol) ?? '') < s.updated_at) latest.set(s.symbol, s.updated_at);
  return [...latest.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([sym]) => sym);
}

/** 历史练习的品种标签（D79）：点了切换下面的表格；右边是当前品种的统计与审查入口（第 5b 阶段的入口挪到这里） */
function SymbolTabs({ username, sessions, chosen, onChoose }:
  { username: string; sessions: SessionRow[]; chosen: string; onChoose: (sym: string) => void }) {
  const symbols = practicedSymbols(sessions);
  if (!symbols.length) return null;
  const done = (sym: string) => sessions.filter((x) => x.symbol === sym && x.status === 'completed').length;
  const stats = `#/u/${encodeURIComponent(username)}/stats/${encodeURIComponent(chosen)}`;
  return (
    <div class="stats-links">
      <span class="segmented symbol-tabs">
        {[...symbols].sort().map((sym) => (
          <button key={sym} class={sym === chosen ? 'active' : ''} onClick={() => onChoose(sym)}>{sym}（{done(sym)} 轮）</button>
        ))}
      </span>
      {done(chosen) > 0 && (
        <>
          <a class="button-link strong" href={stats}>{chosen} 统计与审查 →</a>
          <a href={`${stats}/review`}>直接看纪律审查</a>
        </>
      )}
    </div>
  );
}

const REPORT_TEXT: Record<string, string> = { queued: '排队中', running: '生成中', failed: '失败，点开重新生成', done: '简报' };

function SessionsTable({ username, sessions }: { username: string; sessions: SessionRow[] }) {
  const base = `#/u/${encodeURIComponent(username)}`;
  if (!sessions.length) return <div class="muted empty">还没有练习记录。</div>;
  return (
    <table class="data-table">
      <thead>
        <tr>
          <th class="num">轮次</th>
          <th>开始时间（UTC）</th>
          <th>起始周期</th>
          <th>状态</th>
          <th>已走根数</th>
          <th>行情片段（随机抽取，结束后揭晓）</th>
          <th class="num">笔数</th>
          <th class="num">收益率</th>
          <th>查看</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.id}>
            <td class="num">{s.round_no ? `第 ${s.round_no} 轮` : s.status === 'active' ? '进行中' : '—'}</td>
            <td>{s.created_at.slice(0, 16)}</td>
            <td>{s.start_timeframe}</td>
            <td>{s.status === 'active' ? '进行中' : (END_REASON_TEXT[s.end_reason ?? ''] ?? s.end_reason)}</td>
            <td class="num">{s.bars_played}</td>
            <td>
              {s.status === 'completed' ? `${utc(s.segment_start_ms)} → ${utc(s.replay_ms)}` : '—'}
              {/* D77：随机抽的不写来源；复练、重复练习模式才在后面加灰色小字 */}
              {s.pick_mode && s.pick_mode !== 'random' && <span class="muted small">（{PICK_MODE_TEXT[s.pick_mode] ?? s.pick_mode}）</span>}
            </td>
            <td class="num">{s.status === 'completed' ? s.trade_count ?? 0 : '—'}</td>
            <td class="num">{returnText(s)}</td>
            <td>
              {s.status === 'completed' && s.report_status && (
                <a href={`${base}/report/${encodeURIComponent(s.id)}`}>{REPORT_TEXT[s.report_status] ?? '简报'}</a>
              )}
              {s.status === 'completed' && <> <a href={`${base}/review/${encodeURIComponent(s.id)}`}>K 线图</a></>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/** 每轮收益率 =（结束时总资产 − 开始时总资产）÷ 开始时总资产（规格书 15.1 节）；没有数字的旧轮次显示 — */
function returnText(s: SessionRow): string {
  if (s.status !== 'completed' || !s.initial_total_assets || s.final_total_assets == null) return '—';
  const r = (s.final_total_assets - s.initial_total_assets) / s.initial_total_assets;
  return `${r > 0 ? '+' : ''}${(r * 100).toFixed(2)}%`;
}

const EXPORT_RANGES: Array<[StatisticsPage['range'], string]> = [
  ['all', '全部'], ['last5', '最近 5 轮'], ['last10', '最近 10 轮'], ['days30', '最近 30 天'], ['custom', '自定义日期'],
];

/** 下载我的数据：按品种（必选，不混在一起）和范围导出一份 Markdown 文件，给自己看或交给 AI 分析（规格书 5.10 节、D70） */
function ExportData({ username, sessions, preferred }: { username: string; sessions: SessionRow[]; preferred: string }) {
  const symbols = [...new Set(sessions.filter((s) => s.status === 'completed').map((s) => s.symbol))].sort();
  const [symbol, setSymbol] = useState(preferred);
  useEffect(() => setSymbol(preferred), [preferred]); // D79：跟着历史练习的品种标签走
  const [range, setRange] = useState<StatisticsPage['range']>('all');
  const [dates, setDates] = useState<CustomDates>(savedCustomDates); // 与统计页的自定义日期共用一份（D70、D71）
  const chosen = symbols.includes(symbol) ? symbol : symbols[0];
  const badDates = range === 'custom' ? customDatesProblem(dates) : null;
  return (
    <section class="card">
      <h2>下载我的数据</h2>
      {!chosen ? <p class="muted">还没有已完成的轮次。</p> : (
        <div class="form-row">
          <label>品种</label>
          <select value={chosen} onChange={(e) => setSymbol((e.target as HTMLSelectElement).value)}>
            {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label>范围</label>
          <select value={range} onChange={(e) => setRange((e.target as HTMLSelectElement).value as StatisticsPage['range'])}>
            {EXPORT_RANGES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          {range === 'custom' && <CustomDateInputs value={dates} onChange={setDates} />}
          {badDates ? <span class="button-link disabled" title={badDates}>下载（Markdown）</span>
            : <a class="button-link" href={api.exportUrl(username, chosen, rangeChoice(range, dates))} download>下载（Markdown）</a>}
        </div>
      )}
      <p class="muted small">
        一个文本文件：开头是字段说明和统计口径，接着是统计与审查的全部数字、每轮简报和逐笔交易，末尾附一段可以直接复制给 AI 的提问模板。
        只能查看，不能再导入。
      </p>
    </section>
  );
}

function ClearHistory({ username, onCleared }: { username: string; onCleared: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    try {
      await api.clearHistory(username, confirm);
      setMsg('已清除全部练习历史');
      setOpen(false);
      setConfirm('');
      onCleared();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '清除失败');
    }
  };
  return (
    <section class="card danger-zone">
      {!open ? (
        <button class="danger-link" onClick={() => setOpen(true)}>
          清除我的全部练习历史…
        </button>
      ) : (
        <div class="form-row">
          <span>
            不可恢复，会同时清空防重复记录。建议先用上面的「下载我的数据」把记录存一份。请输入你的用户名确认：
          </span>
          <input value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} />
          <button class="danger" disabled={confirm.toLowerCase() !== username.toLowerCase()} onClick={run}>
            确认清除
          </button>
          <button onClick={() => setOpen(false)}>取消</button>
        </div>
      )}
      {msg && <div class="muted">{msg}</div>}
    </section>
  );
}
