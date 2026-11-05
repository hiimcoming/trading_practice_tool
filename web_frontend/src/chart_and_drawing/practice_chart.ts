// 练习页的 K 线图（Lightweight Charts）：配色、盲练时间轴、最小 K 线间距、切周期保持视图、往左拖到头加载更早历史、画线工具、测量尺（measure_ruler.ts）。
// 画线（第 4b 阶段，D64）：开图时导入这一轮保存过的画线，之后每完成一次操作通知外面保存；⌘Z / ⌘⇧Z 撤销重做；
//   选中画线时顶栏第 2 行出现设置工具条（drawing_settings_bar.ts）。
// 盲练（规格书 5.3 节、D48）：横轴在任何周期都不显示任何时间内容；十字线的时间标签只显示 K 线序号
// （本轮起点之后第一根为 #1，背景 K 线为 #0、#−1……）。关闭盲练时按 UTC 或 UTC+8 显示日期时间。
// 性能（规格书 5.5 节）：推进时只更新最后一根（update），不重画整张图；一屏最多约 3000 根。
// 交易标记（第 4 阶段）：订单线（持仓、止损止盈、挂单、草稿单、强平、买价）由 order_lines_layer.ts 画、贴标签、处理拖动；
//   开仓 / 平仓箭头及两者之间的连线（D57、D58，可在设置里隐藏）由 trade_markers.ts 画（与已完成轮次的静态 K 线图共用）。

import {
  CandlestickSeries,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { DrawingManager, DrawingStyle, FutureAxis } from 'lightweight-charts-drawing';
import type { Bar, DayAnchor, Timeframe, WeekStart } from '../trading_rules/kline_synthesis';
import { DrawingSettingsBar } from './drawing_settings_bar';
import { attachDrawingHistory, rememberDrawingStyle, setDrawingPalette, setDrawingStyleMemory, setupDrawingTools, type DrawingStyleMemory } from './drawing_toolbar';
import { MeasureRuler } from './measure_ruler';
import { OrderLinesLayer, type OverlayLine } from './order_lines_layer';
import { TradeMarkers } from './trade_markers';
import type { ThemePalette } from './theme_palettes';

export interface PracticeChartOptions {
  precision: number;
  tickSize: number;
  maxBarsPerScreen: number;
  theme: ThemePalette;
  blind: boolean;
  /** 显示时区：0 = UTC，8 = UTC+8（只是标签） */
  utcOffsetHours: number;
  /** 本轮起点（UTC 毫秒），用于算 K 线序号 */
  startMs: number;
  toolbar: HTMLElement;
  onHint: (text: string | null) => void;
  /** 往左拖到最早一根附近时调用（加载更早的历史） */
  onNearLeftEdge: () => void;
  /** 右侧未来区的「往后第几根」（D74）：给出最后一根之后、已预取的后续 K 线开盘时刻（毫秒，升序）和当前周期长度 */
  futureBars: (lastMs: number) => { opens: number[]; tfMs: number };
  /** 顶栏第 2 行左边的空位，放画线设置工具条 */
  drawingSettingsSlot: HTMLElement;
  /** 这一轮保存过的画线（画线库 B 导出的 JSON 列表） */
  savedDrawings: unknown[];
  /** 用户设置里的样式记忆（每类工具最后一次用的样式） */
  drawingStyles: unknown;
  /** 画线完成一次操作（含撤销、重做）后调用，json 是全部画线 */
  onDrawingsChanged: (json: string) => void;
  /** 样式记忆变了（改了某条线的样式）：外面存进用户设置 */
  onDrawingStylesChanged: (m: DrawingStyleMemory) => void;
}

const toTime = (ms: number) => (ms / 1000) as UTCTimestamp;

/** 图上要画的交易信息（由练习页控制中心按交易账户算好传进来；线的颜色、标签、能否拖动都在 lines 里） */
export interface TradeOverlay {
  timeframe: Timeframe;
  dayAnchor: DayAnchor;
  weekStart: WeekStart;
  lines: OverlayLine[];
  /** 持仓的开仓箭头 */
  positions: Array<{ direction: number; entry_price: number; open_ms: number }>;
  trades: Array<{ direction: number; entry_price: number; open_ms: number; pnl: number; exits: Array<{ ms: number; price: number }> }>;
  showMarkers: boolean;
  /** 排队等成交的市价单（D76）：画在最后一根上的半透明「待成交 ×N」箭头；null = 没有 */
  queued: { direction: number; count: number } | null;
}


export class PracticeChart {
  readonly chart: IChartApi;
  readonly series: ISeriesApi<'Candlestick'>;
  readonly drawings: DrawingManager;
  private bars: Bar[] = [];
  private blind: boolean;
  private utcOffsetHours: number;
  private readonly resizeObserver: ResizeObserver;
  private readonly tradeMarkers: TradeMarkers;
  readonly orderLines: OrderLinesLayer;
  readonly ruler: MeasureRuler;
  private readonly settingsBar: DrawingSettingsBar;
  private readonly detachHistory: () => void;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: PracticeChartOptions,
  ) {
    this.blind = opts.blind;
    this.utcOffsetHours = opts.utcOffsetHours;
    this.chart = createChart(container, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 12 },
      localization: { locale: 'zh-CN', timeFormatter: (t: Time) => this.formatCrosshairTime(t as number) },
    });
    this.series = this.chart.addSeries(CandlestickSeries, {
      borderVisible: false,
      priceFormat: { type: 'price', precision: opts.precision, minMove: opts.tickSize },
    });
    this.applyTimeAxisFormat();
    this.setTheme(opts.theme);
    setDrawingStyleMemory(opts.drawingStyles);
    this.drawings = setupDrawingTools(this.chart, this.series, opts.toolbar, opts.onHint, () => futureAxisFromBars(opts.futureBars));
    this.loadSavedDrawings(opts.savedDrawings);
    this.detachHistory = attachDrawingHistory(this.drawings, opts.onDrawingsChanged);
    this.settingsBar = new DrawingSettingsBar(opts.drawingSettingsSlot, this.drawings, (kind: string, style: DrawingStyle) =>
      opts.onDrawingStylesChanged(rememberDrawingStyle(kind, style)),
    );
    // 测量尺：按钮放在 4 种画线工具后面（D61）
    this.ruler = new MeasureRuler(this.chart, this.series, container, {
      precision: opts.precision,
      bars: () => this.bars,
      drawingToolActive: () => this.drawings.tool() !== null,
      onHint: opts.onHint,
    });
    opts.toolbar.insertBefore(this.ruler.button, opts.toolbar.querySelector('hr'));
    this.tradeMarkers = new TradeMarkers(this.chart, this.series);
    // 止盈止损、挂单价拖动时按 2 位小数吸附（D58），最小价格单位更大的品种按它吸附
    this.orderLines = new OrderLinesLayer(this.chart, this.series, container, Math.max(opts.tickSize, 0.01));
    this.resizeObserver = new ResizeObserver(() => this.applyMinBarSpacing());
    this.resizeObserver.observe(container);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => this.checkLeftEdge(r));
  }

  setTheme(theme: ThemePalette): void {
    this.chart.applyOptions({
      layout: { background: { color: theme.chartBackground }, textColor: theme.chartText },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      crosshair: { vertLine: { color: theme.crosshair }, horzLine: { color: theme.crosshair } },
      rightPriceScale: { borderColor: theme.axisBorder },
      timeScale: { borderColor: theme.axisBorder },
    });
    this.series.applyOptions({ upColor: theme.up, downColor: theme.down, wickUpColor: theme.up, wickDownColor: theme.down });
    setDrawingPalette(theme);
    this.drawings?.redraw();
  }

  setTimeDisplay(blind: boolean, utcOffsetHours: number): void {
    this.blind = blind;
    this.utcOffsetHours = utcOffsetHours;
    this.applyTimeAxisFormat();
  }

  /** 换一整套 K 线（开局、切周期、加载更早历史）。keepView：保持右边缘对准同一时刻、屏幕上根数不变 */
  setBars(bars: Bar[], keepView: boolean): void {
    const range = keepView ? this.chart.timeScale().getVisibleLogicalRange() : null;
    const old = this.bars;
    this.bars = bars;
    this.series.setData(bars.map((b) => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
    this.applyMinBarSpacing();
    if (range && old.length && bars.length) {
      const width = range.to - range.from;
      const oldLast = old.length - 1;
      const rightIdx = Math.min(Math.max(Math.floor(range.to), 0), oldLast);
      const extra = Math.max(0, range.to - oldLast);
      const rightTime = old[rightIdx].t;
      let idx = bars.length - 1;
      while (idx > 0 && bars[idx].t > rightTime) idx--;
      this.chart.timeScale().setVisibleLogicalRange({ from: idx + extra - width, to: idx + extra });
    }
    this.drawings.redraw();
  }

  /** 切周期专用：换一整套 K 线，屏幕上根数不变，跳到最新一根，最新一根右侧留出屏幕宽度 15% 的空白。
   *  不对准原来看的历史时刻：新周期只加载了最近一段，那个时刻多半不在里面，对过去画面就是空的 */
  setBarsAtLatest(bars: Bar[]): void {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    this.setBars(bars, false);
    if (range && bars.length) {
      const width = range.to - range.from;
      const to = bars.length - 1 + 0.5 + width * 0.15;
      this.chart.timeScale().setVisibleLogicalRange({ from: to - width, to });
    }
  }

  /** 推进后只更新最后一根（或新增一根） */
  updateLast(bar: Bar): void {
    const last = this.bars[this.bars.length - 1];
    if (last && last.t === bar.t) this.bars[this.bars.length - 1] = bar;
    else this.bars.push(bar);
    this.series.update({ time: toTime(bar.t), open: bar.o, high: bar.h, low: bar.l, close: bar.c });
  }

  /** 画订单线（交给订单线层）和开平仓箭头、连线（交给 trade_markers.ts，与静态 K 线图共用；每次推进、交易、拖线时调用） */
  setTradeOverlay(o: TradeOverlay): void {
    this.orderLines.setLines(o.lines);
    this.tradeMarkers.draw(this.bars, { timeframe: o.timeframe, dayAnchor: o.dayAnchor, weekStart: o.weekStart, positions: o.positions, trades: o.trades, show: o.showMarkers, queued: o.queued });
  }

  /** 回到最新一根（快进之后用） */
  scrollToLatest(): void {
    this.chart.timeScale().scrollToRealTime();
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.orderLines.destroy();
    this.ruler.destroy();
    this.detachHistory();
    this.settingsBar.destroy();
    this.drawings.destroy();
    this.chart.remove();
  }

  // ---------------- 内部 ----------------

  /** 导入保存过的画线；数据坏了就当没有画线（不让整页打不开），并在控制台留个记录 */
  private loadSavedDrawings(list: unknown[]): void {
    if (!Array.isArray(list) || !list.length) return;
    try {
      const n = this.drawings.importJSON(list);
      console.info(`[画线] 恢复了 ${n} 条画线`);
    } catch (e) {
      console.error('[画线] 保存的画线读不出来，按没有画线处理', e);
    }
  }

  private applyMinBarSpacing(): void {
    const width = this.container.clientWidth || 1200;
    this.chart.timeScale().applyOptions({ minBarSpacing: Math.max(0.5, width / this.opts.maxBarsPerScreen) });
  }

  private applyTimeAxisFormat(): void {
    this.chart.applyOptions({
      timeScale: {
        // 盲练：横轴不显示任何时间内容（D48）
        tickMarkFormatter: (t: Time) => (this.blind ? '' : this.formatAxisTime(t as number)),
      },
    });
  }

  private formatAxisTime(sec: number): string {
    const d = new Date((sec + this.utcOffsetHours * 3600) * 1000);
    const hm = d.toISOString().slice(11, 16);
    return hm === '00:00' ? d.toISOString().slice(5, 10) : hm;
  }

  /** 十字线的时间标签：盲练时只显示 K 线序号 */
  private formatCrosshairTime(sec: number): string {
    if (!this.blind) {
      const d = new Date((sec + this.utcOffsetHours * 3600) * 1000);
      return `${d.toISOString().slice(0, 16).replace('T', ' ')} ${this.utcOffsetHours ? 'UTC+8' : 'UTC'}`;
    }
    return `#${this.barNumber(sec * 1000)}`;
  }

  /** K 线序号：起点之后第一根为 1，背景 K 线为 0、−1、−2…… */
  private barNumber(tMs: number): number {
    const bars = this.bars;
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].t < this.opts.startMs) lo = mid + 1;
      else hi = mid;
    }
    const firstAfterStart = lo;
    let i = 0;
    let j = bars.length - 1;
    while (i < j) {
      const mid = (i + j + 1) >> 1;
      if (bars[mid].t <= tMs) i = mid;
      else j = mid - 1;
    }
    return i - firstAfterStart + 1;
  }

  private checkLeftEdge(range: LogicalRange | null): void {
    if (range && range.from < 20) this.opts.onNearLeftEdge();
  }
}

/**
 * 右侧未来区的「交易日历」（D74，用户 2026-10-25 定）：未来区按「往后第几根 K 线」对齐——
 * 往后第 k 根的开盘时刻 = 已预取的后续行情（约 3 个交易日的 1m）合成出来的第 k 根真实 K 线的开盘时刻；
 * 走到那根时时刻正好对上，画在未来区的方框不会因周末、每日休市落进空档而缩回去。
 * 超出预取范围的部分按周期长度往后估算（用户同意：画得更远时按平均间隔估算即可）。
 * 时间单位：画线库用秒，这里收进来的是毫秒。
 */
export function futureAxisFromBars(get: (lastMs: number) => { opens: number[]; tfMs: number }): FutureAxis {
  const known = (lastSec: number) => {
    const { opens, tfMs } = get(lastSec * 1000);
    return { opens: opens.filter((t) => t > lastSec * 1000).map((t) => t / 1000), iv: tfMs / 1000 };
  };
  return {
    // 最后一根之后、到 time 为止（含）开盘的 K 线有几根
    slots: (time, lastTime) => {
      const { opens, iv } = known(lastTime);
      let n = 0;
      while (n < opens.length && opens[n] <= time) n++;
      if (n < opens.length) return n;
      const tail = opens.length ? opens[opens.length - 1] : lastTime;
      return n + Math.max(0, Math.floor((time - tail) / iv));
    },
    // 往后第 k 根（k ≥ 1）的开盘时刻
    time: (k, lastTime) => {
      const { opens, iv } = known(lastTime);
      if (k <= opens.length) return opens[k - 1];
      const tail = opens.length ? opens[opens.length - 1] : lastTime;
      return tail + (k - opens.length) * iv;
    },
  };
}

