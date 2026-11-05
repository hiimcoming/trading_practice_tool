// 单轮简报页和已完成轮次的静态 K 线图页（第 5a 阶段，规格书 7.1、15.6 节）。
//   #/u/{用户名}/report/{轮次}           单轮简报：结束本轮后自动进入。服务器还在复算或排队时显示三步进度（保存记录 → 服务器复算 → 生成简报）
//                                        和「前面还有 N 个任务」，每秒问一次；出错显示原因和「重新生成」。
//                                        简报只列事实：揭晓信息、资产曲线和最大回撤、基本数字、纪律违规清单、逐笔交易；
//                                        服务器复算与浏览器结果不一致时顶部标红并列出差异。点违规或某一笔 → 静态 K 线图并移到那一笔。
//   #/u/{用户名}/review/{轮次}[/{时刻}]   静态 K 线图：只画开平仓箭头和连线（用户 2026-10-22 定），可切周期、缩放、往左拖加载更早的 K 线。
//   #/u/{用户名}/review/{轮次}/{起}-{止}/{持仓编号,…}/{第几笔,…}   从统计页点连续亏损段过来（第 5b-2 阶段，D71）：
//                                        自动选一个能看清整段的周期（整段不超过约 200 根），缩放到正好框住这一段，
//                                        这几笔加粗、标 #编号，其他交易变浅灰；「取消高亮」回到普通看法。
//   点违规或逐笔交易的某一行（D72）也走这个地址：只高亮这一笔（起止 = 开平仓时刻），框住这一笔并在两边留出前后行情（至少约 150 根）。
// 页面路径（D72）：左上角「首页 › 我的练习 › 第 N 轮简报 › K 线图」像 Finder 的完整路径，每一级都能点，当前页面带底色；
//   K 线图页另有醒目的「← 返回简报」；统计页从简报点进来时地址带 /from/{轮次}，路径里多一级「第 N 轮简报」。
// 金额带货币（D72）：Exness 写 $1,234.56，币安写 1,234.56 USDT。
// 时间一律 UTC（轮次已结束，日期已揭晓）。
import { LineSeries, LineStyle, createChart, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, api, type MarketSpec, type ReportStatus, type RoundBrief, type SessionRow } from '../backend_api_client/api_client';
import { ReviewChart, timeframeForSpan, type ReviewStreak } from '../chart_and_drawing/review_chart';
import { loadSavedTheme } from '../chart_and_drawing/theme_palettes';
import type { Bar, Timeframe, WeekStart } from '../trading_rules/kline_synthesis';
import { navigate } from './app';
import { CLOSE_REASON_TEXT, END_REASON_TEXT, cash, currencyOf, money as plainMoney, pct, price2, qtyText, quote, signedCash, signedMoney as plainSigned, signedR } from './format_helpers';
import { KIND_TEXT } from './practice_controller';

const POLL_MS = 1000;
const SINGLE_TRADE_MAX_BARS = 100; // 看单笔时：这一笔最多占约 100 根（选周期用），屏幕上至少显示 150 根（D72）
const SINGLE_TRADE_MIN_BARS = 150;
const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const userPath = (u: string) => `/u/${encodeURIComponent(u)}`;
const reviewPath = (u: string, id: string, ms?: number) => `${userPath(u)}/review/${encodeURIComponent(id)}${ms ? `/${ms}` : ''}`;
const decisionText = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`);
const sourceText = (s: string) => (s === 'market' ? '市价' : KIND_TEXT[s] ?? s);

/** 统计页连续亏损段的链接（#/u/…/review/轮次/起-止/持仓编号/第几笔）；只有一笔时就是「看这一笔」（D72） */
export const streakReviewHref = (u: string, id: string, s: ReviewStreak) =>
  `#${userPath(u)}/review/${encodeURIComponent(id)}/${s.from}-${s.to}/${s.pids.join(',')}/${s.nos.join(',')}`;
/** 简报页地址；统计页的地址（fromSession = 从哪一轮的简报点进来，D72） */
export const reportHref = (u: string, id: string) => `#${userPath(u)}/report/${encodeURIComponent(id)}`;
export const statsHref = (u: string, symbol: string, fromSession?: string) =>
  `#${userPath(u)}/stats/${encodeURIComponent(symbol)}${fromSession ? `/from/${encodeURIComponent(fromSession)}` : ''}`;
const roundLabel = (n: number | null | undefined) => (n ? `第 ${n} 轮简报` : '单轮简报');

export interface Crumb {
  label: string;
  href?: string;
}
/** 首页 › 我的练习（各页路径的开头两级） */
export const userCrumbs = (u: string): Crumb[] => [{ label: '首页', href: '#/' }, { label: '我的练习', href: `#${userPath(u)}` }];

/** 页面路径（D72）：每一级都能点，最后一级是当前页面（带底色、不能点） */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav class="breadcrumb" aria-label="页面路径">
      {items.map((it, i) => (
        <span key={i}>
          {i > 0 && <span class="crumb-sep">›</span>}
          {it.href && i < items.length - 1 ? <a href={it.href}>{it.label}</a> : <span class="crumb-current">{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}
// ============================================================
// 单轮简报
// ============================================================

export function ReportPage({ username, sessionId }: { username: string; sessionId: string }) {
  const [st, setSt] = useState<ReportStatus | null>(null);
  const [market, setMarket] = useState<MarketSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // 点「重新生成」后重新开始轮询

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const poll = async () => {
      try {
        const s = await api.report(username, sessionId);
        if (stop) return;
        setSt(s);
        setError(null);
        if (s.status === 'queued' || s.status === 'running') timer = window.setTimeout(poll, POLL_MS);
        if (s.status === 'done' && s.report) {
          const m = await api.markets();
          if (!stop) setMarket(m.markets[s.report.reveal.symbol] ?? null);
        }
      } catch (e) {
        if (stop) return;
        setError(e instanceof ApiError ? e.message : '读取简报失败（网络问题？），稍后自动重试');
        timer = window.setTimeout(poll, POLL_MS * 3);
      }
    };
    void poll();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [username, sessionId, tick]);

  const regenerate = async () => {
    try {
      setSt(await api.requestReport(username, sessionId));
      setTick(tick + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '重新生成失败');
    }
  };

  const b = st?.status === 'done' ? st.report : undefined;
  return (
    <div class="page report-page">
      <header class="page-header with-crumbs">
        <div class="page-title">
          <Breadcrumb items={[...userCrumbs(username), { label: roundLabel(b?.round_no) }]} />
          <h1>{b ? briefTitle(b, st?.practice_date) : '单轮简报'}</h1>
        </div>
        <nav>
          {b && <a href={`#${reviewPath(username, sessionId)}`}>查看 K 线图</a>}
          {b && <a href={statsHref(username, b.reveal.symbol, sessionId)}>统计与审查</a>}
        </nav>
      </header>
      {error && <div class="error card">{error}</div>}
      {!st && !error && <div class="card muted">读取中…</div>}
      {st && st.status !== 'done' && <Progress st={st} onRetry={regenerate} />}
      {st?.status === 'done' && st.report && <Brief username={username} sessionId={sessionId} b={st.report} market={market} />}
    </div>
  );
}

function Progress({ st, onRetry }: { st: ReportStatus; onRetry: () => void }) {
  const steps = st.steps ?? ['保存记录', '服务器复算成本和盈亏', '生成简报'];
  if (st.status === 'none' || st.status === 'failed' || st.status === 'unavailable') {
    return (
      <div class="card">
        <p>{st.status === 'none' ? '这一轮还没有简报。' : `简报没有生成：${st.error ?? '原因不明'}`}</p>
        <button class="primary" onClick={onRetry}>{st.status === 'none' ? '生成简报' : '重新生成'}</button>
      </div>
    );
  }
  const cur = st.step ?? 1;
  return (
    <div class="card report-progress">
      {st.status === 'queued' && (st.queue_ahead ?? 0) > 0 && <p class="muted">排队中：前面还有 {st.queue_ahead} 个任务</p>}
      <ol>
        {steps.map((name, i) => (
          <li key={name} class={i + 1 < cur ? 'done' : i + 1 === cur ? 'current' : ''}>
            {i + 1 < cur ? '✓' : i + 1 === cur ? '…' : '·'} {name}
          </li>
        ))}
      </ol>
      <div class="progress-bar"><div style={{ width: `${Math.round(((cur - 1) / steps.length) * 100)}%` }} /></div>
      <p class="muted">可以离开这个页面，完成后在「我的练习」的历史列表里查看。</p>
    </div>
  );
}

/** 简报标题（D72）：第 5 轮 · XAUUSD · 行情 2023-03-01 至 2023-03-05（4.2 天）· 练习于 2026-10-25 */
function briefTitle(b: RoundBrief, practiceDate: string | null | undefined): string {
  const r = b.reveal;
  return [b.round_no ? `第 ${b.round_no} 轮` : null, r.symbol, `行情 ${r.start_utc.slice(0, 10)} 至 ${r.end_utc.slice(0, 10)}（${r.days} 天）`,
    practiceDate ? `练习于 ${practiceDate}` : null].filter(Boolean).join(' · ');
}

function Brief({ username, sessionId, b, market }: { username: string; sessionId: string; b: RoundBrief; market: MarketSpec | null }) {
  const r = b.reveal;
  const fmt = (x: number | null) => quote(x, market?.price_precision ?? 2);
  const unit = market?.qty_unit ?? (market?.platform === 'binance' ? r.symbol.replace(/USDT$/, '') : '手');
  const cur = currencyOf(market?.platform ?? (r.symbol.endsWith('USDT') ? 'binance' : 'exness'));
  const money = (x: number | null | undefined) => cash(x, cur);
  const signedMoney = (x: number | null | undefined) => signedCash(x, cur);
  /** 看某一笔（D72）：静态图只高亮这一笔，框住开平仓并留出前后行情 */
  const goTrade = (positionId: number) => {
    const t = b.trades.find((x) => x.position_id === positionId);
    if (t) navigate(streakReviewHref(username, sessionId, { from: t.open_ms, to: t.close_ms, pids: [t.position_id], nos: [t.no] }).slice(1));
  };
  const ret = b.equity.initial_total ? (b.equity.final_total - b.equity.initial_total) / b.equity.initial_total : null;
  return (
    <>
      {b.round_no && b.round_no % 5 === 0 && (
        <div class="card notice-card">
          这是 {r.symbol} 的第 {b.round_no} 轮，已经攒了 5 轮新的练习——
          <a href={statsHref(username, r.symbol, sessionId)}>去看统计与审查（进步曲线、纪律审查）</a>
        </div>
      )}
      {!b.check.consistent && (
        <div class="card error">
          <b>结果不一致</b>：服务器复算和浏览器算的结果有差异，以下数字以服务器为准。
          <ul>{b.check.differences.map((d) => <li key={d}>{d}</li>)}</ul>
        </div>
      )}
      <section class="card">
        <h2>揭晓</h2>
        <div class="kv-grid">
          <span>品种</span><b>{r.symbol} · 起始周期 {r.start_timeframe}</b>
          <span>真实时间段</span><b>{r.start_utc} → {r.end_utc} UTC（经历 {r.days} 天）</b>
          <span>走了</span><b>{r.bars_played} 根 {r.start_timeframe}</b>
          <span>从开局到结束</span><b>{r.real_minutes === null ? '—' : `${Math.floor(r.real_minutes / 60)} 小时 ${r.real_minutes % 60} 分钟`}（含中途离开的时间）</b>
          <span>结束方式</span><b>{END_REASON_TEXT[r.end_reason] ?? r.end_reason}</b>
        </div>
      </section>
      <section class="card">
        <h2>资产曲线</h2>
        <EquityChart points={b.equity.points} />
        <div class="kv-grid">
          <span>总资产</span><b>{money(b.equity.initial_total)} → {money(b.equity.final_total)}（{ret === null ? '—' : `${ret > 0 ? '+' : ''}${pct(ret)}`}）</b>
          <span>最大回撤</span><b>{money(b.equity.max_drawdown)}（{pct(b.equity.max_drawdown_pct)}）</b>
        </div>
      </section>
      <section class="card">
        <h2>基本数字</h2>
        <div class="kv-grid">
          <span>交易笔数</span><b>{b.basics.trades}（盈利 {b.basics.wins} 笔 · 亏损 {b.basics.losses} 笔）</b>
          <span>净盈亏</span><b class={b.basics.net_pnl > 0 ? 'profit' : b.basics.net_pnl < 0 ? 'loss' : ''}>{signedMoney(b.basics.net_pnl)}</b>
          <span>交易成本合计</span><b>{money(b.basics.cost_total)}（点差 {money(b.basics.spread_cost)} · 滑点 {money(b.basics.slippage_cost)} · 手续费 {money(b.basics.fees)}）</b>
          <span>出入金</span>
          <b>{b.basics.transfers.length === 0 ? '无' : b.basics.transfers.map((t) => `${t.direction === 'to_funding' ? '出金' : '入金'} ${money(t.amount)}`).join(' · ')}</b>
          <span>强平</span><b>{b.basics.liquidations} 次</b>
        </div>
      </section>
      <section class="card">
        <h2>纪律违规清单</h2>
        {b.violations.length === 0 ? <p class="muted">本轮没有发现违规。</p> : (
          <ul class="violations">
            {b.violations.map((v) => (
              <li key={`${v.kind}${v.no}${v.ms}`}><a href="#" onClick={(e) => { e.preventDefault(); goTrade(v.position_id); }}>{v.text}</a></li>
            ))}
          </ul>
        )}
      </section>
      <section class="card">
        <h2>逐笔交易</h2>
        {b.trades.length === 0 ? <p class="muted">本轮没有交易。</p> : (
          <table class="data-table compact clickable-rows">
            <thead>
              <tr>
                <th>#</th><th>方向</th><th class="num">数量</th><th>进场方式</th><th>进场（UTC）</th><th>出场（UTC）</th>
                <th class="num">进场价</th><th class="num">出场价</th><th class="num">第一次止损</th><th class="num">平仓时止损 / 止盈</th>
                <th>出场原因</th><th class="num">盈亏（{cur}）</th><th class="num">R</th><th class="num">交易成本（{cur}）</th><th class="num">决策用时</th>
              </tr>
            </thead>
            <tbody>
              {b.trades.map((t) => (
                <tr key={t.position_id} onClick={() => goTrade(t.position_id)} title="在 K 线图上看这一笔">
                  <td class="muted">{t.no}</td>
                  <td class={t.direction === 1 ? 'buy-text' : 'sell-text'}>{t.direction === 1 ? '买入' : '卖出'}</td>
                  <td class="num">{qtyText(t.qty, Number(market?.qty_step ?? 0.001))} {unit}</td>
                  <td>{sourceText(t.source)}</td>
                  <td>{utc(t.open_ms)}</td>
                  <td>{utc(t.close_ms)}</td>
                  <td class="num">{fmt(t.entry_price)}</td>
                  <td class="num">{fmt(t.exit_price)}</td>
                  <td class="num">{price2(t.initial_sl)}</td>
                  <td class="num">{price2(t.sl_at_close)} / {price2(t.tp_at_close)}</td>
                  <td>{CLOSE_REASON_TEXT[t.close_reason] ?? t.close_reason}{t.exits > 1 ? `（分 ${t.exits} 次）` : ''}</td>
                  <td class={`num ${t.pnl > 0 ? 'profit' : 'loss'}`}>{plainSigned(t.pnl)}</td>
                  <td class="num">{signedR(t.r)}</td>
                  <td class="num">{plainMoney(t.cost)}</td>
                  <td class="num">{t.decision_ms == null ? '无记录' : decisionText(t.decision_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/** 资产曲线：总资产（主线）和交易账户净值（参考线） */
function EquityChart({ points }: { points: Array<[number, number, number]> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || points.length === 0) return;
    const theme = loadSavedTheme();
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { color: theme.chartBackground }, textColor: theme.chartText },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: theme.axisBorder },
      rightPriceScale: { borderColor: theme.axisBorder },
      localization: { locale: 'zh-CN', timeFormatter: (t: unknown) => `${utc((t as number) * 1000)} UTC` },
      handleScroll: false,
      handleScale: false,
    });
    const toT = (ms: number) => (ms / 1000) as UTCTimestamp;
    const total = chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 2, title: '总资产' });
    const trading = chart.addSeries(LineSeries, { color: theme.chartText, lineWidth: 1, lineStyle: LineStyle.Dashed, title: '交易账户', lastValueVisible: false });
    total.setData(points.map((p) => ({ time: toT(p[0]), value: p[1] })));
    trading.setData(points.map((p) => ({ time: toT(p[0]), value: p[2] })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);
  return <div class="equity-chart" ref={ref} />;
}

// ============================================================
// 静态 K 线图
// ============================================================

export function ReviewPage({ username, sessionId, focusMs, streak = null }: { username: string; sessionId: string; focusMs: number | null; streak?: ReviewStreak | null }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReviewChart | null>(null);
  const [sess, setSess] = useState<SessionRow | null>(null);
  const [tf, setTf] = useState<Timeframe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roundNo, setRoundNo] = useState<number | null>(null);
  const state = useRef<{ bars: Bar[]; loading: boolean; noMore: boolean }>({ bars: [], loading: false, noMore: false });
  const single = streak !== null && streak.pids.length === 1;
  const weekStartRef = useRef<WeekStart>('monday'); // 周线起点（D74），读到品种档案后设置 // 从简报点某一笔 / 某条违规过来（D72）

  // 路径里写「第 N 轮简报」要知道第几轮：读一下简报（读不到就写「单轮简报」）
  useEffect(() => {
    api.report(username, sessionId).then((r) => setRoundNo(r.report?.round_no ?? null)).catch(() => setRoundNo(null));
  }, [username, sessionId]);

  // 读这一轮和品种档案，建图
  useEffect(() => {
    let chart: ReviewChart | null = null;
    (async () => {
      try {
        const [list, m] = await Promise.all([api.sessions(username), api.markets()]);
        const s = list.sessions.find((x) => x.id === sessionId);
        if (!s) throw new ApiError('找不到这一轮练习（可能已被清除）', 404);
        if (s.status !== 'completed') throw new ApiError('这一轮还没有结束', 409);
        const spec = m.markets[s.symbol];
        weekStartRef.current = (spec.week_start as WeekStart | undefined) ?? 'monday';
        chart = new ReviewChart(boxRef.current!, loadSavedTheme(), spec.price_precision, spec.tick_size, () => void loadEarlier(s));
        chartRef.current = chart;
        setSess(s);
        setTf(streak ? timeframeForSpan(streak.from, streak.to, s.start_timeframe, single ? SINGLE_TRADE_MAX_BARS : undefined) : s.start_timeframe);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : '打开 K 线图失败');
      }
    })();
    return () => {
      chart?.destroy();
      chartRef.current = null;
    };
  }, [username, sessionId]);

  const markerTrades = (s: SessionRow, timeframe: Timeframe) => {
    const acc = (s.state as { account?: { trades: Array<{ position_id: number; direction: number; entry_price: number; open_ms: number; pnl: number; exits: Array<{ ms: number; price: number }> }> } }).account;
    return { timeframe, dayAnchor: s.day_anchor, weekStart: weekStartRef.current, positions: [], trades: acc?.trades ?? [], show: true, highlight: streak?.pids };
  };

  // 切周期：取这一周期在本轮结束之前的最后 2000 根
  useEffect(() => {
    const chart = chartRef.current;
    if (!sess || !tf || !chart) return;
    let stop = false;
    (async () => {
      try {
        const bars = await api.historyBars(username, sessionId, tf, sess.replay_ms, 2000);
        if (stop) return;
        const first = state.current.bars.length === 0;
        state.current = { bars, loading: false, noMore: bars.length < 2000 };
        chart.setBars(bars, !first);
        chart.setTrades(markerTrades(sess, tf));
        if (first && streak) chart.fitRange(streak.from, streak.to, single ? SINGLE_TRADE_MIN_BARS : 0);
        else if (first && focusMs) chart.centerOn(focusMs);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : '读取 K 线失败');
      }
    })();
    return () => {
      stop = true;
    };
  }, [sess, tf]);

  /** 往左拖到头：再取更早的 2000 根接在前面 */
  async function loadEarlier(s: SessionRow) {
    const st = state.current;
    const chart = chartRef.current;
    if (st.loading || st.noMore || !st.bars.length || !chart) return;
    st.loading = true;
    const timeframe = (tfRef.current ?? s.start_timeframe) as Timeframe;
    try {
      const older = await api.historyBars(username, sessionId, timeframe, st.bars[0].t, 2000);
      st.noMore = older.length < 2000;
      st.bars = [...older, ...st.bars];
      chart.setBars(st.bars, true);
    } finally {
      st.loading = false;
    }
  }
  const tfRef = useRef<Timeframe | null>(null);
  tfRef.current = tf;

  return (
    <div class="review-page">
      <header class="review-bar">
        <a class="back-button" href={reportHref(username, sessionId)}>← 返回简报</a>
        <Breadcrumb items={[...userCrumbs(username), { label: roundLabel(roundNo), href: reportHref(username, sessionId) }, { label: 'K 线图' }]} />
        {sess && <b>{sess.symbol}</b>}
        {sess && <span class="muted">{utc(sess.segment_start_ms)} → {utc(sess.replay_ms)} UTC</span>}
        <span class="tf-buttons">
          {TIMEFRAMES.map((x) => (
            <button key={x} class={x === tf ? 'active' : ''} onClick={() => { state.current.noMore = false; setTf(x); }}>{x}</button>
          ))}
        </span>
        <span class="muted">箭头：蓝色向上 = 买入，深红向下 = 卖出；虚线连接开仓和平仓（绿赚红亏）</span>
      </header>
      {streak && (
        <div class="card notice-card review-streak">
          {single
            ? <>正在看第 {streak.nos[0]} 笔（#{streak.pids[0]}：大箭头、标编号、连线加粗；其他交易变浅灰）{tf && ` · 用 ${tf} 周期，两边留出前后行情`}</>
            : <>连续亏损段：第 {streak.nos.join('、')} 笔（大箭头、标 #持仓编号、连线加粗；其他交易变浅灰）{tf && ` · 用 ${tf} 周期框住整段`}</>}
          {' '}<a href={`#${reviewPath(username, sessionId)}`}>取消高亮</a>
        </div>
      )}
      {error && <div class="error card">{error}</div>}
      <div class="review-chart" ref={boxRef} />
    </div>
  );
}
