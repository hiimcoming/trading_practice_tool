// 「统计与审查」页的进步曲线（第 5b 阶段，D68；2026-10-22 用户选「指标卡片 + 一张大图」）：
//   METRICS 定义每个指标：名称、分组、怎么从每轮的点取数、显示格式、「变大是好事还是坏事」（卡片上的对比颜色）、纵轴范围。
//   DetailChart 是卡片下面的大图：横轴是第几轮（#001…），一次画 1–2 个指标（第一个用左纵轴、第二个用右纵轴），
//   默认显示最近 30 轮、可拖动看更早、showAll() 看全部；图例在图上方（不盖住数据），跟着鼠标显示那一轮的数值。
//   纵轴规则：占比类固定 0–100%；其余不会为负的从 0 起；真实杠杆最高只画到 50 倍，超过的点贴在 50 倍处、
//   图例显示真实数字并注明「接近强平」（快被强平时净值接近 0，杠杆会算出几千倍，照实画会把其他轮次压成一条线）。
//   每轮违规次数画成五类叠起来的柱子。胜率等「最近 30 笔」类指标，样本不足 30 笔的点画浅色。
// 横轴用「假日期」承载轮次：第 n 轮 = 基准时刻 + n 天，刻度和十字线标签都换成 #n。

import {
  HistogramSeries,
  LineSeries,
  createChart,
  type AutoscaleInfo,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ThemePalette } from './theme_palettes';

export interface ProgressPoint {
  round_no: number;
  sample_small: boolean;
  [key: string]: unknown;
}

export interface Metric {
  key: string;
  name: string;
  group: string;
  kind: 'line' | 'bar' | 'stack';
  color: string;
  get: (p: ProgressPoint) => number | null;
  fmt: (v: number) => string;
  /** 两轮之差怎么写（占比类写「个点」） */
  delta: (d: number) => string;
  /** 变大是好事（up）、坏事（down），还是说不上（null） */
  better: 'up' | 'down' | null;
  /** 按「最近 30 笔」滚动算的指标：样本不足时画浅色 */
  rolling?: boolean;
  /** 占比类：纵轴固定 0–100% */
  share?: boolean;
  /** 可以为负（收益率、R）：纵轴不从 0 起 */
  signed?: boolean;
  /** 最高画到多少（超过的贴顶） */
  cap?: number;
}

const BASE = 1_000_000_000; // 假日期基准（秒）
const DAY = 86_400;
const toTime = (no: number) => (BASE + no * DAY) as UTCTimestamp;
const toNo = (t: Time) => Math.round(((t as number) - BASE) / DAY);
const field = (k: string) => (p: ProgressPoint) => (typeof p[k] === 'number' ? (p[k] as number) : null);
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
const pts = (d: number) => `${Math.abs(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)} 个点`;
const num = (dig: number, unit: string) => (v: number) => `${v.toFixed(dig)}${unit}`;
const absNum = (dig: number, unit: string) => (d: number) => `${Math.abs(d).toFixed(dig)}${unit}`;

/** 五类违规的颜色（叠柱，从下到上） */
export const VIOLATION_COLORS: Record<string, string> = {
  no_stop_at_entry: '#e0464b', stop_moved_against: '#f08c00', quick_reentry: '#9c36b5', heavy_position: '#1c7ed6', size_up_after_loss: '#5c940d',
};

const violationsTotal = (p: ProgressPoint) => {
  const v = p.violations as Record<string, number> | null;
  return v ? Object.values(v).reduce((s, x) => s + x, 0) : null;
};

/** 卡片分三排（D73，用户定）：结果、风险、纪律；其余指标（计划 R 等）不再显示 */
export const METRIC_GROUPS = ['结果', '风险', '纪律'] as const;

export const METRICS: Metric[] = [
  { key: 'win_rate', name: '胜率（最近 30 笔）', group: '结果', kind: 'line', color: '#2962ff', get: field('win_rate'), fmt: pct, delta: pts, better: 'up', rolling: true, share: true },
  { key: 'payoff_ratio', name: '盈亏比（最近 30 笔）', group: '结果', kind: 'line', color: '#e67700', get: field('payoff_ratio'), fmt: num(2, ' 倍'), delta: absNum(2, ' 倍'), better: 'up', rolling: true },
  { key: 'avg_r', name: '实际 R（最近 30 笔平均）', group: '结果', kind: 'line', color: '#495057', get: field('avg_r'), fmt: num(2, 'R'), delta: absNum(2, 'R'), better: 'up', rolling: true, signed: true },
  { key: 'return', name: '每轮收益率', group: '结果', kind: 'bar', color: '#2962ff', get: field('return'), fmt: pct1, delta: pts, better: 'up', signed: true },
  { key: 'max_drawdown_pct', name: '每轮最大回撤', group: '结果', kind: 'line', color: '#862e9c', get: field('max_drawdown_pct'), fmt: pct1, delta: pts, better: 'down' },
  { key: 'max_leverage', name: '每轮最高真实杠杆', group: '风险', kind: 'line', color: '#c92a2a', get: field('max_leverage'), fmt: num(1, ' 倍'), delta: absNum(1, ' 倍'), better: 'down', cap: 50 },
  { key: 'stop_pct_median', name: '实际止损占权益（中位数）', group: '风险', kind: 'line', color: '#1098ad', get: field('stop_pct_median'), fmt: pct1, delta: pts, better: 'down' },
  { key: 'trades_per_100_bars', name: '每 100 根 K 线开几笔', group: '风险', kind: 'line', color: '#d6336c', get: field('trades_per_100_bars'), fmt: num(1, ' 笔'), delta: absNum(1, ' 笔'), better: null },
  { key: 'disciplined_share', name: '守纪律交易占比', group: '纪律', kind: 'line', color: '#0b9c7c', get: field('disciplined_share'), fmt: pct, delta: pts, better: 'up', rolling: true, share: true },
  { key: 'violations', name: '每轮违规次数', group: '纪律', kind: 'stack', color: '#e0464b', get: violationsTotal, fmt: num(0, ' 次'), delta: absNum(0, ' 次'), better: 'down' },
  { key: 'longest_loss_run', name: '最长连续亏损', group: '纪律', kind: 'bar', color: '#d9480f', get: field('longest_loss_run'), fmt: num(0, ' 笔'), delta: absNum(0, ' 笔'), better: 'down' },
  { key: 'after_stop_bars_median', name: '止损后隔几根再开仓', group: '纪律', kind: 'line', color: '#7048e8', get: field('after_stop_bars_median'), fmt: num(1, ' 根'), delta: absNum(1, ' 根'), better: 'up' },
  { key: 'hold_bars_win', name: '盈利单平均持仓', group: '纪律', kind: 'line', color: '#0b9c7c', get: field('hold_bars_win'), fmt: num(1, ' 根'), delta: absNum(1, ' 根'), better: null },
  { key: 'hold_bars_loss', name: '亏损单平均持仓', group: '纪律', kind: 'line', color: '#e0464b', get: field('hold_bars_loss'), fmt: num(1, ' 根'), delta: absNum(1, ' 根'), better: null },
];

export type Tone = 'good' | 'bad' | 'muted';

/** 卡片要显示的：最新一轮的值、和 5 轮前相比的文字和好坏 */
export function cardSummary(m: Metric, points: ProgressPoint[]): { value: number | null; roundNo: number | null; text: string; tone: Tone } {
  let i = points.length - 1;
  while (i >= 0 && m.get(points[i]) === null) i--;
  if (i < 0) return { value: null, roundNo: null, text: '还没有数据', tone: 'muted' };
  const value = m.get(points[i])!;
  const prev = i - 5 >= 0 ? m.get(points[i - 5]) : null;
  // 不足 5 轮时不写字（D73：只在「进步曲线」标题旁统一提示一次）
  if (prev === null) return { value, roundNo: points[i].round_no, text: '', tone: 'muted' };
  const d = value - prev;
  // 差值按显示精度四舍五入后是 0（如「0.0 个点」）也算持平
  if (Math.abs(d) < 1e-9 || /^0(\.0+)?(\D|$)/.test(m.delta(d))) return { value, roundNo: points[i].round_no, text: '与 5 轮前持平', tone: 'muted' };
  const good = m.better === null ? null : (d > 0) === (m.better === 'up');
  return { value, roundNo: points[i].round_no, text: `${d > 0 ? '↑' : '↓'} ${m.delta(d)} vs 5 轮前`, tone: good === null ? 'muted' : good ? 'good' : 'bad' };
}

/** 卡片里的小趋势线（最近 30 轮）：返回 SVG 字符串 */
export function sparkline(m: Metric, points: ProgressPoint[]): string {
  const ps = points.slice(-30);
  const vals = ps.map((p) => {
    const v = m.get(p);
    return v === null ? null : m.cap ? Math.min(v, m.cap) : v;
  });
  const real = vals.filter((v): v is number => v !== null);
  if (!real.length) return '';
  const lo = m.share ? 0 : Math.min(0, ...real);
  const hi = m.share ? 1 : Math.max(...real, lo + 1e-9);
  const W = 100;
  const H = 28;
  const x = (i: number) => (ps.length === 1 ? W / 2 : (i / (ps.length - 1)) * W);
  const y = (v: number) => H - 2 - ((v - lo) / (hi - lo)) * (H - 4);
  if (m.kind !== 'line') {
    const bw = Math.max(1.5, (W / ps.length) * 0.6);
    const bars = vals.map((v, i) => {
      if (v === null) return '';
      const top = Math.min(y(v), y(0));
      return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, Math.abs(y(0) - y(v))).toFixed(1)}"/>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark"><g fill="${m.color}">${bars}</g></svg>`;
  }
  const segs: string[][] = [];
  let cur: string[] = [];
  vals.forEach((v, i) => {
    if (v === null) {
      if (cur.length) segs.push(cur);
      cur = [];
    } else cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (cur.length) segs.push(cur);
  const shapes = segs.map((s) => {
    if (s.length > 1) return `<polyline points="${s.join(' ')}"/>`;
    const [cx, cy] = s[0].split(',');
    return `<circle cx="${cx}" cy="${cy}" r="1.5" fill="${m.color}"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark"><g fill="none" stroke="${m.color}" stroke-width="1.5" vector-effect="non-scaling-stroke">${shapes}</g></svg>`;
}

export class DetailChart {
  private chart: IChartApi | null = null;
  private points: ProgressPoint[] = [];
  private metrics: Metric[] = [];
  private kinds: Record<string, string> = {};

  constructor(
    private readonly box: HTMLElement,
    private readonly legend: HTMLElement,
    private readonly theme: ThemePalette,
  ) {}

  render(points: ProgressPoint[], metrics: Metric[], kinds: Record<string, string>): void {
    this.chart?.remove();
    this.points = points;
    this.metrics = metrics;
    this.kinds = kinds;
    const t = this.theme;
    const margins = { top: 0.08, bottom: 0.04 };
    const chart = createChart(this.box, {
      autoSize: true,
      layout: { background: { color: t.chartBackground }, textColor: t.chartText },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      leftPriceScale: { visible: true, borderColor: t.axisBorder, scaleMargins: margins },
      rightPriceScale: { visible: metrics.length > 1, borderColor: t.axisBorder, scaleMargins: margins },
      timeScale: { borderColor: t.axisBorder, rightOffset: 1, tickMarkFormatter: (time: Time) => `#${String(toNo(time)).padStart(3, '0')}` },
      localization: { timeFormatter: (time: Time) => `第 ${toNo(time)} 轮` },
    });
    this.chart = chart;
    metrics.forEach((m, i) => this.addMetric(chart, m, i === 0 ? 'left' : 'right'));
    chart.subscribeCrosshairMove((e) => this.updateLegend(e));
    // 轮次少时不按 30 轮留空（数据会挤在最右边），按至少 12 轮的宽度显示
    this.showRecent(Math.min(30, Math.max(12, points.length)));
    this.updateLegend(null);
  }

  /** 只显示最近 n 轮（不足 n 轮时左边留空，柱子不会被撑得很宽） */
  showRecent(n: number): void {
    if (!this.chart || !this.points.length) return;
    const last = this.points.length - 1;
    this.chart.timeScale().setVisibleLogicalRange({ from: last - n + 0.5, to: last + 0.5 });
  }

  /** 看全部轮次（不足 30 轮时和「最近 30 轮」一样） */
  showAll(): void {
    if (!this.chart) return;
    if (this.points.length < 12) this.showRecent(12);
    else this.chart.timeScale().fitContent();
  }

  destroy(): void {
    this.chart?.remove();
    this.chart = null;
  }

  private addMetric(chart: IChartApi, m: Metric, scale: 'left' | 'right'): void {
    const autoscale = (original: () => AutoscaleInfo | null): AutoscaleInfo | null => {
      if (m.share) return { priceRange: { minValue: 0, maxValue: 1 } };
      const r = original();
      if (!r?.priceRange) return r;
      return { ...r, priceRange: { minValue: m.signed ? Math.min(r.priceRange.minValue, 0) : 0, maxValue: Math.max(r.priceRange.maxValue, 0) } };
    };
    const common = {
      priceScaleId: scale, lastValueVisible: false, priceLineVisible: false, autoscaleInfoProvider: autoscale,
      priceFormat: { type: 'custom' as const, formatter: m.fmt, minMove: 0.001 },
    };
    if (m.kind === 'stack') {
      // 每类画「它和它下面各类的合计」，从最高的先画，后画的盖在上面
      const order = Object.keys(this.kinds);
      [...order].reverse().forEach((k) => {
        const upto = order.slice(0, order.indexOf(k) + 1);
        chart.addSeries(HistogramSeries, { ...common, color: VIOLATION_COLORS[k] ?? '#888' }).setData(this.points.map((p) => {
          const v = p.violations as Record<string, number> | null;
          return v ? { time: toTime(p.round_no), value: upto.reduce((s, x) => s + (v[x] ?? 0), 0) } : { time: toTime(p.round_no) };
        }));
      });
      return;
    }
    const data = this.points.map((p) => {
      const v = m.get(p);
      if (v === null) return { time: toTime(p.round_no) };
      const faint = m.rolling && p.sample_small;
      return { time: toTime(p.round_no), value: m.cap ? Math.min(v, m.cap) : v, ...(faint ? { color: `${m.color}55` } : {}) };
    });
    const s: ISeriesApi<'Line' | 'Histogram'> = m.kind === 'bar'
      ? chart.addSeries(HistogramSeries, { ...common, color: m.color })
      : chart.addSeries(LineSeries, { ...common, color: m.color, lineWidth: 2, pointMarkersVisible: true, pointMarkersRadius: 3 });
    s.setData(data);
    if (m.cap && this.points.some((p) => (m.get(p) ?? 0) > m.cap!)) {
      s.createPriceLine({ price: m.cap, color: m.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: `${m.cap} 倍以上贴顶（接近强平）` });
    }
  }

  /** 图上方的图例：第几轮 + 每个指标在这一轮的值（不在图上时显示最新一轮） */
  private updateLegend(e: MouseEventParams | null): void {
    const no = e?.time !== undefined ? toNo(e.time) : this.points[this.points.length - 1]?.round_no;
    const p = this.points.find((x) => x.round_no === no);
    if (!p) {
      this.legend.innerHTML = '';
      return;
    }
    const items = this.metrics.map((m) => {
      if (m.kind === 'stack') {
        const v = p.violations as Record<string, number> | null;
        if (!v) return `<span class="lg-item"><i style="background:${m.color}"></i>${m.name} <b>—</b></span>`;
        const parts = Object.keys(this.kinds).map((k) => `<span class="lg-item"><i style="background:${VIOLATION_COLORS[k]}"></i>${this.kinds[k]} <b>${v[k] ?? 0}</b></span>`);
        return `<span class="lg-item"><b>${m.name} ${violationsTotal(p)} 次：</b></span>${parts.join('')}`;
      }
      const v = m.get(p);
      const capped = v !== null && m.cap && v > m.cap ? '（接近强平）' : '';
      const faint = m.rolling && p.sample_small ? '（样本不足 30 笔）' : '';
      return `<span class="lg-item"><i style="background:${m.color}"></i>${m.name} <b>${v === null ? '—' : m.fmt(v)}</b>${capped}${faint}</span>`;
    });
    this.legend.innerHTML = `<span class="lg-round">第 ${p.round_no} 轮（${p.trades as number} 笔）</span>${items.join('')}`;
  }
}
