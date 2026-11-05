// 「统计与审查」页（第 5b 阶段，D68；取代规格书 7.2 节原「每 5 轮一份阶段报告」）：#/u/{用户名}/stats/{品种}[/from/{轮次}]
//   顶部（D72）：页面路径「首页 › 我的练习 › [第 N 轮简报 ›] XAUUSD 统计与审查」；从简报点进来（地址带 /from/{轮次}）时
//   右上角有「← 返回第 N 轮简报」。标题下一行写所选范围：第几轮到第几轮、练习日期起止和跨了几天。金额带货币（$ / USDT）。
//   ① 进步曲线（全部轮次，默认显示最近 30 轮，可拖动、可看全部，「更多」可勾选）；
//   ①b 每 5 轮一组的对比（第 5b-2 阶段，D71）：每组一行的表 + 各组胜率折线（不满 5 轮的组标「未满」、画浅色点），不受范围影响；
//   ② 范围：最近 5 轮 / 最近 10 轮 / 最近 30 天 / 全部 / 自定义日期（D71：按练习完成日期，「一天」按设置页的显示时区）
//      —— 下面三块按范围算；交易少于 20 笔时顶部标「样本少，仅供参考」；
//   ③ 问题提示；④ MT4 式统计表（附逐笔累计的净值曲线）；⑤ 纪律审查，分三层（D75）：
//      第一层 六种犯错行为的卡片（犯了的 vs 没犯的胜率，代价大的标红排前面，样本少的不下结论）；
//      第二层 对比横条（进场方式市价 vs 挂单、方向、时段、止损风险、决策用时、止损后间隔；横条 = 胜率，竖线 = 全部交易胜率）
//              和一句话的计划执行 / 持仓；第三层 明细默认收起（资金使用与风险、连续亏损段、交易频率、止盈和跟进止损）。
// 数字都由后端算好（website_server/review_statistics.py），这里只负责排版。连续亏损段可点开到静态 K 线图看那几笔
// （D71：自动缩放到整段、这几笔高亮，见 report_page.tsx 的 ReviewPage）。
import { LineSeries, createChart, createSeriesMarkers, type UTCTimestamp } from 'lightweight-charts';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, api, type Currency, type RangeChoice, type ReviewBehavior, type ReviewRow, type StatisticsPage } from '../backend_api_client/api_client';
import { DetailChart, METRICS, METRIC_GROUPS, cardSummary, sparkline, type Metric } from '../chart_and_drawing/progress_chart';
import { loadSavedTheme } from '../chart_and_drawing/theme_palettes';
import { cash, signedCash } from './format_helpers';
import { Breadcrumb, reportHref, streakReviewHref, userCrumbs, type Crumb } from './report_page';
import { local } from './shared_settings';

type RangeKey = StatisticsPage['range'];
const RANGES: Array<[RangeKey, string]> = [['last5', '最近 5 轮'], ['last10', '最近 10 轮'], ['days30', '最近 30 天'], ['all', '全部'], ['custom', '自定义日期']];
const p0 = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(0)}%`);
const p1 = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const n1 = (x: number | null | undefined, unit = '') => (x === null || x === undefined ? '—' : `${x.toFixed(1)}${unit}`);
const n2 = (x: number | null | undefined, unit = '') => (x === null || x === undefined ? '—' : `${x.toFixed(2)}${unit}`);
/** 轮次列表：连续的写成「1–40」，否则用顿号隔开 */
const roundsText = (xs: number[]) => {
  if (!xs.length) return '—';
  const parts: string[] = [];
  let a = xs[0];
  for (let i = 1; i <= xs.length; i++) {
    if (i === xs.length || xs[i] !== xs[i - 1] + 1) {
      parts.push(a === xs[i - 1] ? String(a) : `${a}–${xs[i - 1]}`);
      a = xs[i];
    }
  }
  return parts.join('、');
};
/** 累计回撤相当于几个单轮本金：不足 1 个写百分比，超过写「约 x 个」（各轮相加的亏损可以超过一轮的本金） */
const ddRatio = (r: number | null | undefined, capital: number | null | undefined, cur: Currency) =>
  r === null || r === undefined ? '—' : r < 1 ? `相当于单轮初始资金 ${cash(capital, cur)} 的 ${(r * 100).toFixed(1)}%` : `约 ${r.toFixed(1)} 个单轮初始资金（${cash(capital, cur)}）`;
const rr = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(2)}R`);

// ============================================================
// 自定义日期（统计页和用户页「下载我的数据」共用）
// ============================================================

/** 本机日期 YYYY-MM-DD（往前推 daysAgo 天） */
const localDate = (daysAgo = 0) => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export interface CustomDates {
  start: string;
  end: string;
}
/** 上次填的起止日期（存在本浏览器）；第一次默认最近 30 天 */
export const savedCustomDates = (): CustomDates => local.get<CustomDates>('stats_custom_dates', { start: localDate(30), end: localDate() });
/** 起止日期有问题时的中文提示；没问题返回 null */
export const customDatesProblem = (c: CustomDates) =>
  !c.start || !c.end ? '请选择起止日期' : c.start > c.end ? '起始日期晚于结束日期，请重新选择' : null;
/** 把范围和自定义日期合成接口参数 */
export const rangeChoice = (range: RangeKey, c: CustomDates): RangeChoice => (range === 'custom' ? { range, ...c } : { range });

/** 起止两个日期框；改了就记住（统计页和下载共用一份） */
export function CustomDateInputs({ value, onChange }: { value: CustomDates; onChange: (c: CustomDates) => void }) {
  const latest = useRef(value); // 两个框在页面刷新前接连改动时，第二次要在第一次的基础上改
  latest.current = value;
  const set = (k: keyof CustomDates, v: string) => {
    const next = { ...latest.current, [k]: v };
    latest.current = next;
    local.set('stats_custom_dates', next);
    onChange(next);
  };
  const problem = customDatesProblem(value);
  return (
    <span class="custom-dates">
      <input type="date" value={value.start} onInput={(e) => set('start', (e.target as HTMLInputElement).value)} aria-label="起始日期" />
      <span>至</span>
      <input type="date" value={value.end} onInput={(e) => set('end', (e.target as HTMLInputElement).value)} aria-label="结束日期" />
      {problem ? <span class="loss small">{problem}</span> : <span class="muted small">按练习完成日期，含首尾两天</span>}
    </span>
  );
}

/** 标题下一行（D72）：第 1–12 轮（共 12 轮）· 练习于 2026-10-21 至 2026-10-25（5 天）· 范围：最近 5 轮 */
function rangeSubtitle(d: StatisticsPage): string {
  const r = d.range_summary;
  if (!r) return `范围：${d.range_label} · 这段时间没有完成的轮次`;
  const rounds = r.first_round === r.last_round ? `第 ${r.first_round} 轮` : `第 ${r.first_round}–${r.last_round} 轮（共 ${r.rounds} 轮）`;
  const dates = !r.from_date ? null : r.from_date === r.to_date ? `练习于 ${r.from_date}（1 天）` : `练习于 ${r.from_date} 至 ${r.to_date}（${r.days} 天）`;
  return [rounds, dates, `范围：${d.range_label}`].filter(Boolean).join(' · ');
}

export function StatsPage({ username, symbol, fromSession = null, focusReview = false }:
  { username: string; symbol: string; fromSession?: string | null; focusReview?: boolean }) {
  const [fromRound, setFromRound] = useState<number | null>(null);
  // 从哪一轮的简报点进来：读一下它是第几轮（路径和返回按钮上写「第 N 轮简报」）
  useEffect(() => {
    if (!fromSession) return;
    api.report(username, fromSession).then((r) => setFromRound(r.report?.round_no ?? null)).catch(() => setFromRound(null));
  }, [username, fromSession]);
  const [range, setRange] = useState<RangeKey>(() => local.get<RangeKey>('stats_range', 'last5'));
  const [dates, setDates] = useState<CustomDates>(savedCustomDates);
  const badDates = range === 'custom' ? customDatesProblem(dates) : null;
  const [data, setData] = useState<StatisticsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (badDates) return; // 日期没选好：不发请求，保留上一次的结果，日期框旁边已有提示
    let stop = false;
    setBusy(true);
    api.statistics(username, symbol, rangeChoice(range, dates))
      .then((d) => !stop && (setData(d), setError(null)))
      .catch((e) => !stop && setError(e instanceof ApiError ? e.message : '读取统计失败'))
      .finally(() => !stop && setBusy(false));
    return () => {
      stop = true;
    };
  }, [username, symbol, range, dates.start, dates.end]);

  // D79：从用户页「直接看纪律审查」进来：第一次有数据时滚到纪律审查（之后换范围不再跳）
  const scrolled = useRef(false);
  useEffect(() => {
    if (!focusReview || scrolled.current || !data) return;
    scrolled.current = true;
    requestAnimationFrame(() => document.querySelector('section.review')?.scrollIntoView({ block: 'start' }));
  }, [data, focusReview]);

  const choose = (r: RangeKey) => {
    setRange(r);
    local.set('stats_range', r);
  };
  const briefName = fromRound ? `第 ${fromRound} 轮简报` : '单轮简报';
  const crumbs: Crumb[] = [...userCrumbs(username), ...(fromSession ? [{ label: briefName, href: reportHref(username, fromSession) }] : []),
    { label: `${symbol} 统计与审查` }];
  return (
    <div class="page stats-page">
      <header class="page-header with-crumbs">
        <div class="page-title">
          <Breadcrumb items={crumbs} />
          <h1>{symbol} 统计与审查</h1>
          {data && data.rounds_total > 0 && <div class="page-subtitle">{rangeSubtitle(data)}</div>}
        </div>
        {fromSession && <nav><a class="back-button" href={reportHref(username, fromSession)}>← 返回{briefName}</a></nav>}
      </header>
      {error && <div class="error card">{error}</div>}
      {!data && !error && <div class="card muted">{busy ? '统计中…（第一次打开时会把旧简报重新复算一遍，可能要几秒）' : ''}</div>}
      {data && data.rounds_total === 0 && <div class="card muted">这个品种还没有可以统计的轮次（要有交易账户的已完成轮次，即第 4 阶段以后开的）。</div>}
      {data && data.rounds_total > 0 && (
        <>
          <Progress data={data} />
          <Groups data={data} />
          <section class="card range-bar">
            <span>下面的统计范围：</span>
            <span class="segmented">
              {RANGES.map(([k, label]) => <button key={k} class={k === range ? 'active' : ''} onClick={() => choose(k)}>{label}</button>)}
            </span>
            {range === 'custom' && <CustomDateInputs value={dates} onChange={setDates} />}
            <span class="muted">
              {busy ? '统计中…' : badDates ? '（日期选好后自动统计）' : data.range_rounds.length
                ? `${data.range === 'custom' ? `${data.range_label}：` : ''}包含第 ${roundsText(data.range_rounds)} 轮，共 ${data.review.trades} 笔交易`
                : `${data.range_label}：这段时间没有完成的轮次`}
            </span>
          </section>
          {data.review.sample_small && <div class="card warn-card">样本少（{data.review.trades} 笔，少于 20 笔），以下比率仅供参考。</div>}
          <Hints hints={data.hints} />
          <Mt4Table s={data.stats} cur={data.currency} />
          <Review username={username} data={data} />
        </>
      )}
    </div>
  );
}

/** 进步曲线：上面一排指标卡片（最新值、和 5 轮前比、小趋势线），点卡片在下面的大图画它；按住 ⌘ / Ctrl 再点一张叠加对比 */
function Progress({ data }: { data: StatisticsPage }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<DetailChart | null>(null);
  const [picked, setPicked] = useState<string[]>(() => local.get<string[]>('progress_picked', ['win_rate']));
  const points = data.progress.points;
  const chosen = picked.map((k) => METRICS.find((m) => m.key === k)).filter((m): m is Metric => !!m);
  const key = JSON.stringify(points.map((p) => p.round_no)) + picked.join(',');
  useEffect(() => {
    if (!boxRef.current || !legendRef.current) return;
    chartRef.current ??= new DetailChart(boxRef.current, legendRef.current, loadSavedTheme());
    chartRef.current.render(points, chosen.length ? chosen : [METRICS[0]], data.violation_kinds);
  }, [key]);
  useEffect(() => () => chartRef.current?.destroy(), []);
  const pick = (k: string, add: boolean) => {
    let next = add ? (picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k].slice(-2)) : [k];
    if (!next.length) next = [k];
    setPicked(next);
    local.set('progress_picked', next);
  };
  const few = data.rounds_total < 5;
  return (
    <section class="card">
      <div class="card-head">
        <h2>进步曲线（全部 {data.rounds_total} 轮）</h2>
      </div>
      {few && (
        <div class="few-rounds-note">
          目前只有 {data.rounds_total} 轮（少于 5 轮）：下面的数字和趋势还不客观，仅供参考；练满 5 轮后卡片上会出现「和 5 轮前相比」。
        </div>
      )}
      <p class="muted small">
        卡片显示最新一轮的数，以及和 5 轮前相比（绿 = 变好，红 = 变差）。胜率、盈亏比、守纪律占比按「截至该轮的最近 {data.progress.rolling_trades} 笔」算；其余按该轮自己的数。
        点卡片在下面画它的走势，按住 ⌘（Windows 按 Ctrl）再点一张可叠加对比。
      </p>
      {METRIC_GROUPS.map((g) => (
        <div key={g} class="kpi-section">
          <h3 class="kpi-section-title">{g}</h3>
          <div class="kpi-grid">
            {METRICS.filter((m) => m.group === g).map((m) => {
              const c = cardSummary(m, points);
              return (
                <button key={m.key} class={`kpi-card ${picked.includes(m.key) ? 'on' : ''}`} onClick={(e) => pick(m.key, e.metaKey || e.ctrlKey)}>
                  <span class="kpi-label">{m.name}</span>
                  <span class="kpi-value">{c.value === null ? '—' : m.fmt(c.value)}{m.cap && c.value !== null && c.value > m.cap ? '（接近强平）' : ''}</span>
                  {c.text && <span class={`kpi-delta ${c.tone}`}>{c.text}</span>}
                  <span class="kpi-spark" dangerouslySetInnerHTML={{ __html: sparkline(m, points) }} />
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div class="detail-head">
        <div class="detail-legend" ref={legendRef} />
        <span class="segmented">
          <button onClick={() => chartRef.current?.showRecent(30)}>最近 30 轮</button>
          <button onClick={() => chartRef.current?.showAll()}>全部</button>
        </span>
      </div>
      <div class="detail-chart" ref={boxRef} />
      <p class="muted small">拖动图表看更早的轮次；浅色的点 = 那一轮之前不足 {data.progress.rolling_trades} 笔，仅供参考。</p>
    </section>
  );
}

/** 每 5 轮一组的对比（D71）：表格 + 各组胜率折线；看的是全部轮次，不受下面的范围影响 */
function Groups({ data }: { data: StatisticsPage }) {
  const ref = useRef<HTMLDivElement>(null);
  const groups = data.groups;
  const size = data.group_size;
  const cur = data.currency;
  const label = (g: StatisticsPage['groups'][number]) => `第 ${g.first}–${g.last} 轮`;
  useEffect(() => {
    if (!ref.current || groups.length < 2) return;
    const t = loadSavedTheme();
    const chart = createChart(ref.current, {
      autoSize: true, handleScroll: false, handleScale: false,
      layout: { background: { color: t.chartBackground }, textColor: t.chartText },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.axisBorder },
      timeScale: { borderColor: t.axisBorder, tickMarkFormatter: (x: unknown) => label(groups[x as number]) },
      localization: { timeFormatter: (x: unknown) => label(groups[x as number]), priceFormatter: (v: number) => `${v.toFixed(0)}%` },
    });
    const line = chart.addSeries(LineSeries, {
      color: '#2962ff', lineWidth: 2, pointMarkersVisible: true, pointMarkersRadius: 4, lastValueVisible: false, priceLineVisible: false,
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }), // 胜率纵轴固定 0–100%（同 D69）
    });
    // 没有交易的组留空不画；不满 5 轮的组画浅色（数字还会变）
    line.setData(groups.map((g, i) => (g.win_rate === null ? { time: i as UTCTimestamp }
      : { time: i as UTCTimestamp, value: g.win_rate * 100, ...(g.complete ? {} : { color: 'rgba(41, 98, 255, 0.35)' }) })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [groups]);
  return (
    <section class="card">
      <h2>每 {size} 轮一组的对比（全部 {data.rounds_total} 轮）</h2>
      <p class="muted small">按第几轮分组（第 1–{size} 轮、第 {size + 1}–{size * 2} 轮……），各组只用组内的交易算；不受下面的范围影响。</p>
      {groups.length >= 2 ? <div class="equity-chart small" ref={ref} /> : <p class="muted small">满两组（{size * 2} 轮）后在这里画各组胜率的折线。</p>}
      <table class="data-table compact">
        <thead><tr>
          <th>组</th><th class="num">笔数</th><th class="num">胜率</th><th class="num">盈亏比</th><th class="num">利润因子</th>
          <th class="num">守纪律占比</th><th class="num">违规次数</th><th class="num">净盈亏</th>
        </tr></thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.first}>
              <td>{label(g)}{!g.complete && <span class="muted small">（未满 {size} 轮，已有 {g.round_nos.length} 轮）</span>}</td>
              <td class="num">{g.trades}</td><td class="num">{p0(g.win_rate)}</td><td class="num">{n2(g.payoff_ratio)}</td>
              <td class="num">{n2(g.profit_factor)}</td><td class="num">{p0(g.disciplined_share)}</td><td class="num">{g.violations}</td>
              <td class={`num ${g.net_pnl > 0 ? 'profit' : g.net_pnl < 0 ? 'loss' : ''}`}>{signedCash(g.net_pnl, cur)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Hints({ hints }: { hints: string[] }) {
  return (
    <section class="card">
      <h2>问题提示</h2>
      {hints.length === 0 ? <p class="muted">没有发现明显的问题（样本少于 5 笔的项目不提示）。</p> : (
        <ul class="hints">{hints.map((h) => <li key={h}>{h}</li>)}</ul>
      )}
    </section>
  );
}

function Mt4Table({ s, cur }: { s: StatisticsPage['stats']; cur: Currency }) {
  const v = s as Record<string, number | null>;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || s.cum_pnl.length < 2) return;
    const t = loadSavedTheme();
    const chart = createChart(ref.current, {
      autoSize: true, handleScroll: false, handleScale: false,
      layout: { background: { color: t.chartBackground }, textColor: t.chartText },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.axisBorder },
      timeScale: { borderColor: t.axisBorder, tickMarkFormatter: (x: unknown) => `第 ${x as number} 笔` },
      localization: { timeFormatter: (x: unknown) => `第 ${x as number} 笔之后` },
    });
    const line = chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
    line.setData(s.cum_pnl.map((value, i) => ({ time: i as UTCTimestamp, value })));
    line.createPriceLine({ price: 0, color: t.axisBorder, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
    // 每轮从第几笔开始：在那一笔上方标 #轮次
    createSeriesMarkers(line, s.round_marks.map((m) => ({
      time: m.index as UTCTimestamp, position: 'aboveBar' as const, shape: 'arrowDown' as const, color: '#868e96', text: `#${m.round_no}`,
    })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [s]);
  // 照 MT4 测试报告的排版（D73）：三列「名称：数值」，行首的「最大 / 平均 / 最多」管这一行后两格
  const sc = (x: { count: number; amount: number }) => `${x.count} 笔（${signedCash(x.amount, cur)}）`;
  const amt = (x: { count: number; amount: number }) => `${signedCash(x.amount, cur)}（${x.count} 笔）`;
  const share = (k: number | null) => (v.trades ? p0((k ?? 0) / (v.trades as number)) : '—');
  type Cell = [string, string] | null;
  const rows: Array<[Cell, Cell, Cell]> = [
    [['总盈利', cash(v.gross_profit, cur)], ['总亏损', signedCash(v.gross_loss, cur)], ['净盈亏', signedCash(v.net_pnl, cur)]],
    [['利润因子', n2(v.profit_factor)], ['期望收益（平均每笔）', signedCash(v.avg_pnl, cur)], ['交易成本合计', cash(v.cost_total, cur)]],
    [['绝对回撤', cash(v.absolute_drawdown, cur)], ['最大回撤', `${cash(v.max_drawdown, cur)}（${ddRatio(v.max_drawdown_of_round_capital, v.round_capital, cur)}）`], null],
    [['交易总笔数', String(v.trades)], ['做空（胜率）', `${v.shorts}（${p0(v.short_win_rate)}）`], ['做多（胜率）', `${v.longs}（${p0(v.long_win_rate)}）`]],
    [null, ['盈利交易（占总数）', `${v.wins}（${p0(v.win_rate)}）`], ['亏损交易（占总数）', `${v.losses}（${share(v.losses)}）`]],
    [['最大', ''], ['盈利交易', signedCash(v.largest_win, cur)], ['亏损交易', signedCash(v.largest_loss, cur)]],
    [['平均', ''], ['盈利交易', signedCash(v.avg_win, cur)], ['亏损交易', signedCash(v.avg_loss, cur)]],
    [['最多', ''], ['连续盈利笔数（金额）', sc(s.longest_win_streak)], ['连续亏损笔数（金额）', sc(s.longest_loss_streak)]],
    [['最大', ''], ['连续盈利金额（笔数）', amt(s.max_win_streak_amount)], ['连续亏损金额（笔数）', amt(s.max_loss_streak_amount)]],
    [['平均', ''], ['连续盈利笔数', n1(v.avg_win_streak)], ['连续亏损笔数', n1(v.avg_loss_streak)]],
  ];
  const extra: Array<[string, string]> = [
    ['时间段', s.periods.map((p) => `#${p.round_no} ${p.start_utc} → ${p.end_utc}`).join('\n')],
    ['合计经历', `${v.days} 天 · ${v.bars} 根 K 线（${v.rounds} 轮）`],
    ['盈亏比（平均盈利 ÷ 平均亏损）', n2(v.payoff_ratio)],
    ['最严重一轮的回撤', s.worst_round_drawdown ? `${p1(s.worst_round_drawdown.pct)}（第 ${s.worst_round_drawdown.round_no} 轮，按该轮总资产算）` : '—'],
  ];
  return (
    <section class="card">
      <h2>统计表（MT4 式）</h2>
      <p class="muted small">
        曲线是<b>累计盈亏（{cur === '$' ? '美元' : 'USDT'}）</b>：把所选各轮的逐笔盈亏首尾相接、从 0 开始，横轴是第几笔；▼#n 标出第 n 轮从哪一笔开始。
        每轮都从初始资金重新开始，所以这不是一条账户净值曲线。
      </p>
      <div class="equity-chart small" ref={ref} />
      <div class="mt4-scroll"><table class="mt4-table">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (c === null ? <><td key={`a${j}`} /><td key={`b${j}`} /></> : (
                <><th key={`a${j}`}>{c[0]}{c[1] !== '' ? '：' : ''}</th><td key={`b${j}`}>{c[1]}</td></>
              )))}
            </tr>
          ))}
        </tbody>
      </table></div>
      <p class="muted small">
        绝对回撤 = 累计盈亏最低跌到 0 以下多少（没跌破为 0）；最大回撤 = 累计盈亏从前高回落的最大金额。各轮都从初始资金重开，所以不算 MT4 的「相对回撤」。
      </p>
      <h3 class="mt4-extra-title">补充</h3>
      <div class="kv-grid">{extra.map(([k, val]) => <><span key={k}>{k}</span><b class="pre">{val}</b></>)}</div>
    </section>
  );
}

function Rows({ rows, overall, extra }: { rows: Array<ReviewRow | null>; overall: number | null; extra?: (r: ReviewRow) => string }) {
  return (
    <table class="data-table compact review-table">
      <thead><tr><th>项目</th><th class="num">笔数</th><th class="num">占比</th><th class="num">胜率</th><th class="num">平均 R</th>{extra && <th>说明</th>}</tr></thead>
      <tbody>
        {rows.filter((r): r is ReviewRow => r !== null).map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td class="num">{r.count}</td>
            <td class="num">{p0(r.share)}</td>
            <td class={`num ${r.win_rate !== null && overall !== null ? (r.win_rate < overall ? 'loss' : r.win_rate > overall ? 'profit' : '') : ''}`}>{p0(r.win_rate)}</td>
            <td class="num">{rr(r.avg_r)}</td>
            {extra && <td class="muted">{extra(r)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 犯错卡片的结论：没犯 / 样本少 / 犯了且胜率比对照组低（代价大）/ 犯了但看不出吃亏 */
type Verdict = 'bad' | 'few' | 'neutral' | 'ok';
const VERDICT_ORDER: Verdict[] = ['bad', 'few', 'neutral', 'ok'];
function verdictOf(b: ReviewBehavior, k: number): Verdict {
  if (b.bad.count === 0) return 'ok';
  if (b.bad.count < k) return 'few';
  if (b.good.count === 0 || b.bad.win_rate === null || b.good.win_rate === null) return 'bad';
  return b.bad.win_rate < b.good.win_rate ? 'bad' : 'neutral';
}

/** 第一层：一种犯错行为一张卡片 */
function BehaviorCard({ b, k }: { b: ReviewBehavior; k: number }) {
  const v = verdictOf(b, k);
  const times = b.times !== undefined && b.times !== b.bad.count ? `（${b.times} 次）` : '';
  return (
    <div class={`behavior-card ${v}`}>
      <span class="behavior-label">{b.label}</span>
      <span class="behavior-value">{v === 'ok' ? '没有' : `${b.bad.count} 笔${times}`}</span>
      {v === 'ok' ? <span class="muted small">这一项做得好</span>
        : v === 'few' ? <span class="muted small">不足 {k} 笔，先不下结论</span>
        : <span class="small">胜率 {p0(b.bad.win_rate)} · {b.good_label} {p0(b.good.win_rate)}{b.good.count < k ? `（只有 ${b.good.count} 笔）` : ''}</span>}
      {v !== 'ok' && v !== 'few' && b.bad.avg_r !== null && b.good.avg_r !== null && (
        <span class="muted small">平均 {rr(b.bad.avg_r)} · {b.good_label} {rr(b.good.avg_r)}</span>
      )}
      {b.note && (b.note_count ?? 0) > 0 && <span class="muted small">{b.note} {b.note_count} 笔</span>}
    </div>
  );
}

/** 第二层：一组横条。横条长度 = 胜率；竖线 = 全部交易胜率；少于 k 笔的画灰色、不标红绿；0 笔的行不画（keepZero 时照画） */
function CompareCard({ title, rows, overall, k, keepZero, children }:
  { title: string; rows: ReviewRow[]; overall: number | null; k: number; keepZero?: boolean; children?: ComponentChildren }) {
  const shown = keepZero ? rows : rows.filter((r) => r.count > 0);
  return (
    <div class="compare-card">
      <div class="compare-title">{title}</div>
      {shown.length === 0 ? <p class="muted small">没有数据。</p> : shown.map((r) => {
        const tone = r.count < k || r.win_rate === null || overall === null ? 'few'
          : r.win_rate < overall ? 'loss' : r.win_rate > overall ? 'profit' : 'even';
        return (
          <div class="compare-row" key={r.label} title={`${r.label}：${r.count} 笔，占 ${p0(r.share)}，胜率 ${p0(r.win_rate)}，平均 ${rr(r.avg_r)}`}>
            <span class="compare-label">{r.label}</span>
            <span class="compare-track">
              <i class={`compare-fill ${tone}`} style={{ width: `${(r.win_rate ?? 0) * 100}%` }} />
              {overall !== null && <i class="compare-overall" style={{ left: `${overall * 100}%` }} />}
            </span>
            <span class="compare-num">{p0(r.win_rate)} · {r.count} 笔</span>
          </div>
        );
      })}
      {children}
    </div>
  );
}

function Review({ username, data }: { username: string; data: StatisticsPage }) {
  const rv = data.review;
  const cur = data.currency;
  const o = rv.overall_win_rate;
  const k = rv.min_samples;
  const r = rv.risk;
  const behaviors = [...rv.behaviors].sort((a, b) => VERDICT_ORDER.indexOf(verdictOf(a, k)) - VERDICT_ORDER.indexOf(verdictOf(b, k)));
  const [limit, stop] = [rv.entry_types[1], rv.entry_types[2]];
  const hold = rv.holding;
  return (
    <section class="card review">
      <h2>纪律审查 <span class="muted small">全部交易胜率 {p0(o)}（{rv.trades} 笔）；不足 {k} 笔的组只列数字、不下结论</span></h2>
      <h3>我犯了哪些错，代价多大</h3>
      <div class="behavior-grid">
        {behaviors.map((b) => <BehaviorCard key={b.key} b={b} k={k} />)}
      </div>
      <h3>在哪种情况下做得好 / 差 <span class="muted small">横条 = 胜率；竖线 = 全部交易胜率 {p0(o)}；高于它绿、低于它红</span></h3>
      <div class="compare-grid">
        <CompareCard title="进场方式" rows={rv.entry_compare} overall={o} k={k} keepZero>
          {rv.entry_compare[1].count > 0 && (
            <p class="muted small">挂单里：限价 {limit.count} 笔（胜率 {p0(limit.win_rate)}）、止损挂单 {stop.count} 笔（胜率 {p0(stop.win_rate)}）</p>
          )}
        </CompareCard>
        <CompareCard title="方向" rows={rv.directions} overall={o} k={k} />
        <CompareCard title="时段（UTC）" rows={rv.sessions} overall={o} k={k} />
        <CompareCard title="开仓时止损风险" rows={r.stop_risk_buckets} overall={o} k={k} />
        <CompareCard title="决策用时（从 K 线出现到下单）" rows={rv.decision} overall={o} k={k} />
        <CompareCard title="止损后隔几根再开仓" rows={rv.after_stop.gaps} overall={o} k={k} />
        <div class="compare-card">
          <div class="compare-title">计划执行与持仓</div>
          <p class="small">开仓时同时设了止损和止盈的 {rv.plan.with_plan} 笔：计划平均 {rr(rv.plan.planned_r_avg)}，实际平均 {rr(rv.plan.actual_r_avg)}。</p>
          <p class="small">设了止盈、还没到就手动平掉的盈利单（拿不住）：{rv.plan.cut_winners.count} 笔。</p>
          <p class="small">盈利单平均拿 {n1(hold.win_bars, ' 根')}，亏损单平均拿 {n1(hold.loss_bars, ' 根')}。</p>
        </div>
      </div>
      <details class="review-details">
        <summary>明细：资金使用与风险、连续亏损段（{rv.loss_streaks.count} 段）、交易频率、止盈和跟进止损</summary>
        <h3>资金使用与风险</h3>
        <div class="kv-grid">
          <span>最高真实杠杆</span><b>{r.max_leverage ? `${r.max_leverage.value.toFixed(1)} 倍（第 ${r.max_leverage.round_no} 轮第 ${r.max_leverage.no} 笔）` : '—'}</b>
          <span>持仓期间平均真实杠杆</span><b>{n1(r.avg_leverage_holding, ' 倍')}</b>
          <span>持仓时间占全程</span><b>{p0(r.holding_time_share)}</b>
          <span>最小强平距离</span><b>{p1(r.min_liq_distance)}</b>
          <span>止损风险最大值</span><b>{p1(r.max_stop_risk)}{r.stop_unlimited_trades ? `（另有 ${r.stop_unlimited_trades} 笔持仓中出现过没设止损 = 无上限）` : ''}</b>
          <span>实际止损占权益</span>
          <b>{r.stop_pct ? `${p1(r.stop_pct.min)}–${p1(r.stop_pct.max)}，中位数 ${p1(r.stop_pct.median)}，中间一半在 ${p1(r.stop_pct.q1)}–${p1(r.stop_pct.q3)}（${r.stop_pct.count} 次止损）` : '—'}</b>
          <span>计划止损风险 vs 实际</span>
          <b>{r.planned_vs_actual_stop.count ? `开仓时计划 ${p1(r.planned_vs_actual_stop.planned_avg)}，实际 ${p1(r.planned_vs_actual_stop.actual_avg)}（差距大说明有跳空、滑点或挪过止损）` : '—'}</b>
          <span>每轮实际止损占权益（中位数）</span><b>{r.stop_pct_by_round.map((x) => `#${x.round_no} ${p1(x.median)}`).join(' · ')}</b>
        </div>
        <h3>连续亏损（≥ 3 笔，一轮之内）</h3>
        {rv.loss_streaks.count === 0 ? <p class="muted">没有。</p> : (
          <ul class="streaks">
            {rv.loss_streaks.items.map((s) => (
              <li key={`${s.round_no}-${s.nos[0]}`}>
                <a href={streakReviewHref(username, s.session_id, { from: s.start_ms, to: s.end_ms, pids: s.position_ids, nos: s.nos })}
                  title="在 K 线图上看这一段（自动框住整段、这几笔高亮）">第 {s.round_no} 轮 第 {s.nos.join('、')} 笔</a>
                ：连亏 {s.count} 笔，跨 {s.span_bars} 根 K 线，之间隔 {s.gaps_bars.join(' / ')} 根，手数{s.size_up ? '变大过' : '没变大'}，
                合计 {signedCash(s.total_pnl, cur)}{s.total_r !== null ? `（${rr(s.total_r)}）` : ''}，时段 {s.sessions.join('、')}
              </li>
            ))}
          </ul>
        )}
        <h3>交易频率</h3>
        <p>平均每 100 根 K 线开 {n1(rv.frequency.trades_per_100_bars)} 笔。</p>
        {rv.frequency.busiest && <Rows rows={[rv.frequency.busiest, rv.frequency.others]} overall={o} />}
        <h3>止盈和跟进止损（不算犯错）</h3>
        <Rows rows={[rv.stops[2], rv.stops[3], rv.stops[5]]} overall={o} extra={(x) => (x.times !== undefined ? `共 ${x.times} 次` : '')} />
      </details>
    </section>
  );
}
