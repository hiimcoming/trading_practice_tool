// 已完成轮次的静态 K 线图（第 5a 阶段，用户 2026-10-22 定：只画开平仓箭头和连线）：看当时每笔交易在哪里开、在哪里平。
// 和练习页的图同一套配色、同一套箭头连线（trade_markers.ts）；可缩放、平移、切周期，但不能推进、不能下单、没有画线工具。
// 轮次已结束，日期已经揭晓，横轴和十字线按 UTC 显示真实日期时间（报告里的时间一律 UTC，规格书 7.1 节）。
// 往左拖到最早一根附近时调用 onNearLeftEdge（外面去取更早的 K 线）。
// 看连续亏损段（第 5b-2 阶段，D71）：地址里带这一段的起止和持仓编号（parseReviewStreak），自动选周期（timeframeForSpan）、fitRange 框住整段。

import { CandlestickSeries, CrosshairMode, createChart, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import { TIMEFRAMES, TIMEFRAME_MS, type Bar, type Timeframe } from '../trading_rules/kline_synthesis';
import type { ThemePalette } from './theme_palettes';
import { TradeMarkers, type MarkerTrades } from './trade_markers';

const toTime = (ms: number) => (ms / 1000) as UTCTimestamp;
const utcText = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ');

/** 静态 K 线图上要突出的一段（连续亏损段）：起止时刻、持仓编号、第几笔（只用来写说明） */
export interface ReviewStreak {
  from: number;
  to: number;
  pids: number[];
  nos: number[];
}
/** 地址里的这一段 → ReviewStreak；格式不对返回 null（当成普通的静态图） */
export function parseReviewStreak(range?: string, pids?: string, nos?: string): ReviewStreak | null {
  const m = /^(\d+)-(\d+)$/.exec(range ?? '');
  if (!m || !pids) return null;
  const list = (x?: string) => (x ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return { from: Number(m[1]), to: Number(m[2]), pids: list(pids), nos: list(nos) };
}
/** 能看清整段的最小周期：不小于起始周期，整段的真实时长不超过约 200 根；都不行就用周线（D74 前是日线） */
export function timeframeForSpan(fromMs: number, toMs: number, start: Timeframe, maxBars = 200): Timeframe {
  const ok = TIMEFRAMES.slice(TIMEFRAMES.indexOf(start));
  return ok.find((tf) => (toMs - fromMs) / TIMEFRAME_MS[tf] <= maxBars) ?? '1w';
}

export class ReviewChart {
  private readonly chart: IChartApi;
  private readonly series: ISeriesApi<'Candlestick'>;
  private readonly markers: TradeMarkers;
  private bars: Bar[] = [];
  private trades: MarkerTrades | null = null;

  constructor(container: HTMLElement, theme: ThemePalette, precision: number, tickSize: number, onNearLeftEdge: () => void) {
    this.chart = createChart(container, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 6 },
      localization: { locale: 'zh-CN', timeFormatter: (t: Time) => `${utcText(t as number)} UTC` },
      layout: { background: { color: theme.chartBackground }, textColor: theme.chartText },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderColor: theme.axisBorder },
    });
    this.chart.timeScale().applyOptions({ borderColor: theme.axisBorder });
    this.series = this.chart.addSeries(CandlestickSeries, {
      borderVisible: false, upColor: theme.up, downColor: theme.down, wickUpColor: theme.up, wickDownColor: theme.down,
      priceFormat: { type: 'price', precision, minMove: tickSize },
    });
    this.markers = new TradeMarkers(this.chart, this.series);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (r && r.from < 20) onNearLeftEdge();
    });
  }

  /** 换一整套 K 线（切周期、加载更早的历史）；keepRight：保持右边缘对准同一时刻 */
  setBars(bars: Bar[], keepRight: boolean): void {
    const range = keepRight ? this.chart.timeScale().getVisibleLogicalRange() : null;
    const oldRightTime = range && this.bars.length ? this.bars[Math.min(Math.max(Math.floor(range.to), 0), this.bars.length - 1)].t : null;
    this.bars = bars;
    this.series.setData(bars.map((b) => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
    if (this.trades) this.markers.draw(this.bars, this.trades);
    if (range && oldRightTime !== null) {
      let idx = bars.length - 1;
      while (idx > 0 && bars[idx].t > oldRightTime) idx--;
      const width = range.to - range.from;
      this.chart.timeScale().setVisibleLogicalRange({ from: idx - width, to: idx });
    }
  }

  setTrades(t: MarkerTrades): void {
    this.trades = t;
    this.markers.draw(this.bars, t);
  }

  /** 把某一时刻移到屏幕中间（从简报点某一笔过来时用） */
  centerOn(ms: number, barsOnScreen = 120): void {
    let idx = this.bars.findIndex((b) => b.t > ms) - 1;
    if (idx < 0) idx = this.bars.length - 1;
    this.chart.timeScale().setVisibleLogicalRange({ from: idx - barsOnScreen / 2, to: idx + barsOnScreen / 2 });
  }

  /** 让 fromMs–toMs 这一段正好占满屏幕（两边各留约 15% 空白；看连续亏损段时用，第 5b-2 阶段）。
   *  minBars：屏幕上至少显示这么多根，不够时两边平均补上前后行情（看单笔交易时用，D72：一笔只持仓几根时不会放得过大） */
  fitRange(fromMs: number, toMs: number, minBars = 0): void {
    const idxOf = (ms: number) => {
      const i = this.bars.findIndex((b) => b.t > ms) - 1;
      return i < 0 ? (ms < (this.bars[0]?.t ?? 0) ? 0 : this.bars.length - 1) : i;
    };
    const a = idxOf(fromMs);
    const b = idxOf(toMs);
    const pad = Math.max(5, Math.round((b - a) * 0.15), Math.ceil((minBars - (b - a)) / 2));
    this.chart.timeScale().setVisibleLogicalRange({ from: a - pad, to: b + pad });
  }

  destroy(): void {
    this.chart.remove();
  }
}
