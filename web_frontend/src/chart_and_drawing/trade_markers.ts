// 图上的开仓 / 平仓箭头和两者之间的连线（D57、D58）。练习页的 K 线图（practice_chart.ts）和已完成轮次的静态 K 线图
// （review_chart.ts，第 5a 阶段）共用这一份，两边画出来的完全一样。
// 每次成交按成交方向画：买入 = 蓝色向上箭头（K 线下方），卖出 = 深红向下箭头（K 线上方）；平多单是一次卖出、平空单是一次买入。
// 箭头尖落在实际成交价上（D83，2026-10-25 取代 D58 的「在 K 线上方 / 下方」：跳空止损时箭头画在 K 线最低点，看起来像赚钱）；
// 连线连开仓价到每一次平仓的成交价（分批平仓就有几条），赚钱绿、亏钱红；同一根 K 线里开平仓只有箭头、不画线。
// 颜色：只平过一次的按这笔的净盈亏；分批平仓的每条线按那一次的价格方向（平仓记录里没有单次的净盈亏）。
// 时刻对齐到当前周期 K 线的开盘，早于已加载 K 线的不画。手动平仓按「此刻」成交，记的时刻是下一分钟的开始；
// 若那一分钟属于图上还没出现的新 K 线，就画在最后一根上（平仓价本来就是最后一根的收盘价）——否则这笔的箭头和连线会缺失（2026-10-22 用户发现）。
// （2026-10-22 从 practice_chart.ts 原样搬出，逻辑未改。）
// 高亮（第 5b-2 阶段，D71，只有静态 K 线图用）：传 highlight = 要突出的持仓编号时，这几笔的箭头加大、标「#编号」、连线加粗，
// 其余交易的箭头和连线变成浅灰；不传时和原来完全一样。
// 待成交（D76，只有练习图用）：市价单还在排队时，在最后一根上画一个半透明箭头并写「待成交 ×N」（D80：关掉开平仓箭头时也画）；按「下一根」成交后它消失，
// 换成画在新 K 线上的正常开仓箭头。（不画在右边空白处：那需要给图表塞假的空白 K 线，会影响缩放拖动。）

import {
  LineSeries,
  LineStyle,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { bucketOpenMs, type Bar, type DayAnchor, type Timeframe, type WeekStart } from '../trading_rules/kline_synthesis';

/** 要画的交易：持仓（只有开仓箭头）和已平仓交易（开仓、每次平仓的箭头和连线） */
export interface MarkerTrades {
  timeframe: Timeframe;
  dayAnchor: DayAnchor;
  /** 周线从星期几开始（D74；不填按周一） */
  weekStart?: WeekStart;
  positions: Array<{ direction: number; entry_price: number; open_ms: number }>;
  trades: Array<{ position_id?: number; direction: number; entry_price: number; open_ms: number; pnl: number; exits: Array<{ ms: number; price: number }> }>;
  show: boolean;
  /** 要突出显示的持仓编号（静态 K 线图看连续亏损段时用）；不传 = 不高亮 */
  highlight?: number[];
  /** 排队等成交的市价单（练习图用，D76）；不传或 null = 没有 */
  queued?: { direction: number; count: number } | null;
}

// 卖出箭头用比下跌 K 线更深的红，避免和红色 K 线混在一起（D58）
const COLORS = { buy: '#2962ff', sellArrow: '#b0002a', win: '#0b9c7c', loss: '#e0464b', dim: 'rgba(134, 142, 150, 0.45)',
  queuedBuy: 'rgba(41, 98, 255, 0.45)', queuedSell: 'rgba(176, 0, 42, 0.45)' };
const toTime = (ms: number) => (ms / 1000) as UTCTimestamp;

export class TradeMarkers {
  private readonly markers: ISeriesMarkersPluginApi<Time>;
  private lines: Array<ISeriesApi<'Line'>> = [];
  private linesKey = '';

  constructor(
    private readonly chart: IChartApi,
    series: ISeriesApi<SeriesType>,
  ) {
    this.markers = createSeriesMarkers(series, []);
  }

  /** bars = 图上当前的 K 线（升序） */
  draw(bars: Bar[], o: MarkerTrades): void {
    const first = bars[0]?.t ?? Infinity;
    const lastT = bars[bars.length - 1]?.t ?? -Infinity;
    const snap = (ms: number) => Math.min(bucketOpenMs(ms, o.timeframe, o.dayAnchor, o.weekStart), lastT);
    const markers: SeriesMarker<Time>[] = [];
    const hl = o.highlight ? new Set(o.highlight) : null;
    // look：normal = 原样；on = 高亮的那几笔（加大、标编号）；off = 有高亮时的其他交易（浅灰）
    // 箭头尖对准成交价：买入向上箭头整个在价格下方（atPriceBottom），卖出向下箭头整个在价格上方（atPriceTop）
    const arrow = (side: number, ms: number, price: number, look: 'normal' | 'on' | 'off' = 'normal', text?: string) => {
      const t = snap(ms);
      if (t < first) return;
      const color = look === 'off' ? COLORS.dim : side === 1 ? COLORS.buy : COLORS.sellArrow;
      const extra = look === 'on' ? { size: 2, text } : {};
      markers.push(side === 1
        ? { time: toTime(t), position: 'atPriceBottom', price, shape: 'arrowUp', color, ...extra }
        : { time: toTime(t), position: 'atPriceTop', price, shape: 'arrowDown', color, ...extra });
    };
    const lookOf = (tr: MarkerTrades['trades'][number]) => (!hl ? 'normal' : tr.position_id !== undefined && hl.has(tr.position_id) ? 'on' : 'off');
    if (o.show) {
      for (const p of o.positions) arrow(p.direction, p.open_ms, p.entry_price, hl ? 'off' : 'normal');
      for (const tr of o.trades) {
        const look = lookOf(tr);
        arrow(tr.direction, tr.open_ms, tr.entry_price, look, `#${tr.position_id}`);
        for (const e of tr.exits) arrow(-tr.direction, e.ms, e.price, look);
      }
    }
    // 待成交箭头不受「显示开平仓箭头」开关影响（D80）：它表示「有单在等成交」，不是历史记号，藏掉会让人以为没点上
    if (o.queued && lastT >= first) {
      const text = `待成交 ×${o.queued.count}`;
      markers.push(o.queued.direction === 1
        ? { time: toTime(lastT), position: 'belowBar', shape: 'arrowUp', color: COLORS.queuedBuy, text }
        : { time: toTime(lastT), position: 'aboveBar', shape: 'arrowDown', color: COLORS.queuedSell, text });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    this.markers.setMarkers(markers);
    // 连线：只在交易笔数、周期、已加载范围、K 线根数变化时重建（同一根 K 线内推进不增删线条）
    const key = `${o.show}|${o.timeframe}|${first}|${bars.length}|${o.trades.length}|${o.highlight?.join(',') ?? ''}`;
    if (key === this.linesKey) return;
    this.linesKey = key;
    for (const s of this.lines) this.chart.removeSeries(s);
    this.lines = [];
    if (!o.show) return;
    // 最多画最近 60 笔的连线；高亮的那几笔无论多早都画
    const recent = o.trades.slice(-60);
    const drawn = hl ? [...o.trades.filter((tr) => lookOf(tr) === 'on' && !recent.includes(tr)), ...recent] : recent;
    for (const tr of drawn) {
      const t0 = snap(tr.open_ms);
      if (t0 < first) continue;
      const look = lookOf(tr);
      for (const e of tr.exits) {
        const t1 = snap(e.ms);
        if (t1 <= t0) continue; // 同一根里开平仓：只有箭头，不画线
        const win = tr.exits.length === 1 ? tr.pnl > 0 : tr.direction * (e.price - tr.entry_price) > 0;
        const line = this.chart.addSeries(LineSeries, {
          color: look === 'off' ? COLORS.dim : win ? COLORS.win : COLORS.loss, lineWidth: look === 'on' ? 2 : 1, lineStyle: LineStyle.Dashed,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null,
        });
        line.setData([{ time: toTime(t0), value: tr.entry_price }, { time: toTime(t1), value: e.price }]);
        this.lines.push(line);
      }
    }
  }
}
