// 测量尺（用户 2026-10-22 提出，照 TradingView 的测量工具；D61）：在图上按住拖动，显示一个框和两行数字——
//   第一行：价差（终点价 − 起点价，美元 / USDT）和涨跌百分比；第二行：横跨多少根 K 线（按当前显示周期）和经过的时长。
//   往上为绿色、往下为红色。
// 用法（用户 2026-10-22 定，照 TradingView，全程不用按住鼠标）：点左侧工具栏的尺子（或随时按住 Shift 单击，画线工具没选中时，
//   因为画线时 Shift 用来锁 45°）→ 单击定起点，之后框跟着鼠标走 → 再单击固定范围 → 再点任意地方就消失并退出测量；Esc 随时取消。
// 为什么不用画线库 B 自带的「日期和价格范围」：它画完一直留在图上、文字是英文，和「量完点一下就消失」不一样。
// 做法：在整个页面上「抢先」（捕获阶段）拿到按下事件，比订单线、画线库、图表平移都早；测量中（起点到消失之间）
//   临时关掉图表自身的拖动缩放，消失后恢复；框和数字是叠在图上的网页小块。时长只显示长短、不显示日期（盲练不漏信息）。

import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { Bar } from '../trading_rules/kline_synthesis';
import { toPanePoint } from './chart_mouse';

export interface MeasureRulerOptions {
  precision: number;
  /** 当前图上的 K 线（序号与图表的逻辑序号一一对应） */
  bars: () => Bar[];
  /** 是否有画线工具正在使用（此时 Shift 留给画线） */
  drawingToolActive: () => boolean;
  onHint: (text: string | null) => void;
}

/** 时长：例如「1 天 3 小时」「45 分钟」 */
function spanText(ms: number): string {
  const min = Math.round(Math.abs(ms) / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  if (m && !d) parts.push(`${m} 分钟`);
  return parts.join(' ') || '0 分钟';
}

export class MeasureRuler {
  readonly button: HTMLButtonElement;
  private armed = false;
  /** 空闲 → 测量中（框跟着鼠标）→ 已固定 → 再点一下回到空闲 */
  private state: 'idle' | 'measuring' | 'fixed' = 'idle';
  private start: { x: number; y: number; logical: number; price: number } | null = null;
  private readonly box: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private savedChartOptions: { handleScroll: unknown; handleScale: unknown } | null = null;
  private readonly onMove = (e: PointerEvent) => this.move(e);
  private readonly onDown = (e: PointerEvent) => this.onPointerDown(e);
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && (this.armed || this.state !== 'idle')) this.clear();
  };

  constructor(
    private readonly chart: IChartApi,
    private readonly series: ISeriesApi<SeriesType>,
    private readonly wrapper: HTMLElement,
    private readonly opts: MeasureRulerOptions,
  ) {
    this.box = document.createElement('div');
    this.box.className = 'measure-box';
    this.label = document.createElement('div');
    this.label.className = 'measure-label';
    wrapper.append(this.box, this.label);
    this.hide();
    this.button = document.createElement('button');
    this.button.textContent = '📏';
    this.button.title = '测量：单击定起点、再单击固定、再点任意地方关闭（随时按住 Shift 单击也能量）';
    this.button.addEventListener('click', () => (this.armed || this.state !== 'idle' ? this.clear() : this.setArmed(true)));
    // 整个页面的捕获阶段：比图表、订单线层、画线库都早拿到按下事件（固定后点页面任何地方都能让它消失）
    window.addEventListener('pointerdown', this.onDown, true);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('keydown', this.onKey);
  }

  destroy(): void {
    window.removeEventListener('pointerdown', this.onDown, true);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('keydown', this.onKey);
    this.box.remove();
    this.label.remove();
  }

  private setArmed(on: boolean): void {
    this.armed = on;
    this.button.classList.toggle('active', on);
    this.wrapper.style.cursor = on ? 'crosshair' : '';
    this.opts.onHint(on ? '测量：在图上按住拖动，松手结束（Esc 取消）' : null);
  }

  /** 每次按下：空闲时（已点尺子或按着 Shift）在图上定起点；测量中再点一下固定；固定后再点任意地方消失 */
  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (e.target === this.button) return; // 点尺子按钮本身交给按钮处理
    const p = toPanePoint(e, this.chart, this.series);
    const inChart = p.insidePane && this.wrapper.contains(e.target as Node);
    if (this.state === 'fixed' || (this.state === 'measuring' && !inChart)) {
      if (inChart) this.swallow(e); // 在图上点的这一下只用来关掉尺子，不让图表或画线收到
      this.clear();
      return;
    }
    if (this.state === 'measuring') {
      this.swallow(e);
      this.state = 'fixed';
      this.opts.onHint('测量已固定：再点任意地方关闭');
      return;
    }
    if (!inChart || (!this.armed && !(e.shiftKey && !this.opts.drawingToolActive()))) return;
    const logical = this.chart.timeScale().coordinateToLogical(p.x);
    const price = this.series.coordinateToPrice(p.y);
    if (logical === null || price === null) return;
    this.swallow(e);
    this.start = { x: p.x, y: p.y, logical: Math.round(logical), price };
    this.state = 'measuring';
    const o = this.chart.options();
    this.savedChartOptions = { handleScroll: structuredClone(o.handleScroll), handleScale: structuredClone(o.handleScale) };
    this.chart.applyOptions({ handleScroll: false, handleScale: false });
    this.opts.onHint('测量中：移动鼠标，再单击固定（Esc 取消）');
    this.draw(p.x, p.y, Math.round(logical), price);
  }

  private swallow(e: PointerEvent): void {
    e.stopPropagation();
    e.preventDefault();
  }

  private move(e: PointerEvent): void {
    if (this.state !== 'measuring' || !this.start) return;
    const p = toPanePoint(e, this.chart, this.series);
    const x = Math.min(Math.max(p.x, 0), p.paneWidth - 1);
    const y = Math.min(Math.max(p.y, 0), p.paneHeight - 1);
    const logical = this.chart.timeScale().coordinateToLogical(x);
    const price = this.series.coordinateToPrice(y);
    if (logical === null || price === null) return;
    this.draw(x, y, Math.round(logical), price);
  }

  /** 画框和数字：价差（涨跌 %）、根数和时长 */
  private draw(x: number, y: number, logical: number, price: number): void {
    const s = this.start!;
    const diff = price - s.price;
    const pct = s.price !== 0 ? (diff / s.price) * 100 : 0;
    const bars = this.opts.bars();
    const n = Math.abs(logical - s.logical);
    const t0 = bars[s.logical]?.t;
    const t1 = bars[logical]?.t;
    const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
    const money = Math.abs(diff).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const line1 = `${sign}${money}（${sign}${Math.abs(pct).toFixed(2)}%）`;
    const line2 = `${n} 根${t0 !== undefined && t1 !== undefined ? ` · ${spanText(t1 - t0)}` : ''}`;
    const up = diff >= 0;
    this.box.className = `measure-box ${up ? 'up' : 'down'}`;
    this.label.className = `measure-label ${up ? 'up' : 'down'}`;
    Object.assign(this.box.style, {
      display: 'block', left: `${Math.min(s.x, x)}px`, top: `${Math.min(s.y, y)}px`,
      width: `${Math.abs(x - s.x)}px`, height: `${Math.abs(y - s.y)}px`,
    });
    this.label.innerHTML = `<div>${line1}</div><div>${line2}</div>`;
    // 数字放在终点那一侧：往上拖放在框的上方，往下拖放在下方
    this.label.style.display = 'block';
    this.label.style.left = `${(s.x + x) / 2}px`;
    this.label.style.top = up ? `${Math.min(s.y, y) - 4}px` : `${Math.max(s.y, y) + 4}px`;
    this.label.style.transform = up ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';
  }

  /** 关掉尺子：框和数字消失，恢复图表拖动缩放，退出测量状态 */
  private clear(): void {
    this.start = null;
    this.state = 'idle';
    this.hide();
    if (this.savedChartOptions) {
      this.chart.applyOptions(this.savedChartOptions as Parameters<IChartApi['applyOptions']>[0]);
      this.savedChartOptions = null;
    }
    this.setArmed(false);
  }

  private hide(): void {
    this.box.style.display = 'none';
    this.label.style.display = 'none';
  }
}
