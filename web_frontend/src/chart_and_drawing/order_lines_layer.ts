// 图上的订单线层（规格书 6.4、6.5、6.7 节，D59）：持仓线、止损止盈线、挂单线、草稿单线、强平线、买价线。
// 这一层只管「画、标签、拖」，不懂交易含义：每条线画在哪、什么颜色、标签写什么、能不能拖、能不能点 ×，都由练习页控制中心算好传进来；
// 拖动中和松开时把新价格告诉控制中心，由它判断合法性、更新标签、写进交易账户（松开即生效，D59）。
//   · 线：用图表自带的价格线（只保留价格轴上的数字标签）；
//   · 标签：照 Exness 网页版「TP ｜ SL ｜ 文字 ｜ ×」，是叠在图上的网页小块，跟着线的高度走；按住标签也能拖这条线；
//     点 × 或 TP / SL（还没设止盈止损时才显示，点了按预设距离出一条线）由控制中心决定做什么；
//     挨得太近的几张标签（同价位的几笔持仓等）以价位为中心上下竖着叠开，各用一条竖直虚线连回自己的价位（D82，取代 D81 的横排），每张单独点、单独拖；
//     按住 TP / SL 往上或往下拖（移动超过 3 像素）就直接拉出一条止盈 / 止损线，松开定在那里（拖动的编号为 quick|线|tp 或 sl）；
//     草稿单的标签在 × 左边多一个「提交」按钮（卖出红、买入蓝）；现在不能下单时按钮变灰，鼠标放上去显示原因（与下单面板一致）；
//   · 拖线：来源是第 1 阶段手感原型 tm_feel_prototype/prototype_code/prototype_feel_test/draggable_test_lines.ts（用户实测通过，D44），
//     2026-10-21 复制后改写——鼠标离线 5 像素以内就算抓住，光标变成上下箭头；在图表外层元素上「抢先」（捕获阶段）拦下按下事件，
//     图表和画线库都收不到，所以拖线时图表不平移、不缩放（订单线 > 画线 > 图表平移）；拖动中临时关掉图表自身的拖动缩放，松开后恢复。

import type { IChartApi, IPriceLine, ISeriesApi, ISeriesPrimitive, LineStyle, PrimitiveHoveredItem, SeriesType, Time } from 'lightweight-charts';
import { toPanePoint } from './chart_mouse';

const GRAB_DISTANCE_PX = 5;
/** 标签竖着叠开时（D82）：每张占多高（标签 20 + 间隔 2）；标签离开自己价位超过多少像素才画虚线 */
const LABEL_STEP_PX = 22;
const LEADER_MIN_PX = 3;

/** 一条线（由控制中心算好） */
export interface OverlayLine {
  key: string;
  price: number;
  color: string;
  style: LineStyle;
  width: 1 | 2;
  /** 线旁标签的文字；null = 不显示标签 */
  label: string | null;
  /** 标签上有没有 × */
  closable: boolean;
  /** 标签左边显示哪些快捷按钮：TP = 按预设距离设止盈，SL = 设止损（还没设时才显示） */
  quick?: { tp: boolean; sl: boolean };
  /** 标签上的「提交」按钮（只有草稿单有）：side 决定颜色，reason 不为 null 时按钮变灰、悬停显示原因 */
  submit?: { side: 'buy' | 'sell'; reason: string | null };
  draggable: boolean;
  /** 拖到不合法的位置时为 true：线和标签变红 */
  invalid?: boolean;
}

export interface OrderLinesHandlers {
  /** 拖动中（每次移动）：新价格，控制中心据此更新标签和合法性后重新 setLines */
  onDrag: (key: string, price: number) => void;
  /** 松开：最终价格 */
  onDrop: (key: string, price: number) => void;
  /** 点了标签上的 × */
  onClose: (key: string) => void;
  /** 点了标签上的 TP / SL */
  onQuick: (key: string, kind: 'tp' | 'sl') => void;
  /** 点了标签上的「提交」 */
  onSubmit: (key: string) => void;
}

/** 只负责「鼠标悬停在可拖的线上时显示上下箭头光标」的图表插件（不画任何东西） */
class CursorPrimitive implements ISeriesPrimitive<Time> {
  constructor(private readonly hit: (y: number) => OverlayLine | null) {}
  hitTest(_x: number, y: number): PrimitiveHoveredItem | null {
    const line = this.hit(y);
    return line ? { cursorStyle: 'ns-resize', externalId: `order-line-${line.key}`, zOrder: 'top' } : null;
  }
}

export class OrderLinesLayer {
  private lines: OverlayLine[] = [];
  private readonly priceLines = new Map<string, IPriceLine>();
  private readonly labels = new Map<string, HTMLDivElement>();
  /** 每张标签的虚线引导线（标签被挤开、离开自己价位时才显示，D82） */
  private readonly leaders = new Map<string, HTMLDivElement>();
  private readonly labelBox: HTMLDivElement;
  private dragging: { key: string; price: number } | null = null;
  /** 在 TP / SL 按钮上按下、还没决定是「点一下」还是「拖」 */
  private quickPress: { key: string; kind: 'tp' | 'sl'; y: number } | null = null;
  /** 刚从 TP / SL 拖完：吞掉随后浏览器补发的那次「点击」 */
  private suppressClick = false;
  private savedChartOptions: { handleScroll: unknown; handleScale: unknown } | null = null;
  private handlers: OrderLinesHandlers | null = null;
  private raf = 0;
  private readonly onMove = (e: PointerEvent) => this.onPointerMove(e);
  private readonly onUp = () => this.onPointerUp();

  constructor(
    private readonly chart: IChartApi,
    private readonly series: ISeriesApi<SeriesType>,
    private readonly wrapper: HTMLElement,
    private readonly snapStep: number,
  ) {
    series.attachPrimitive(new CursorPrimitive((y) => (this.dragging ? null : this.lineNearY(y))));
    this.labelBox = document.createElement('div');
    this.labelBox.className = 'order-line-labels';
    wrapper.append(this.labelBox);
    // 捕获阶段：比图表、画线库、价格轴「+」都早拿到按下事件
    wrapper.addEventListener('pointerdown', (e) => this.onPointerDown(e), true);
    wrapper.addEventListener('mousedown', (e) => this.blockIfDragging(e), true);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    // 缩放、平移、价格轴伸缩都会改变线的高度：每帧对一次标签位置（只有几个小块，开销很小）；
    // 另外在图表滚动缩放、鼠标移动时也对一次（页面在后台时浏览器会暂停逐帧刷新）
    const loop = () => {
      this.placeLabels();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.placeLabels());
    chart.subscribeCrosshairMove(() => this.placeLabels());
  }

  setHandlers(h: OrderLinesHandlers): void {
    this.handlers = h;
  }

  isDragging(): boolean {
    return this.dragging !== null;
  }

  /** 换一整套线（每次推进、交易、拖动中都会调用） */
  setLines(lines: OverlayLine[]): void {
    this.lines = lines;
    const keys = new Set(lines.map((l) => l.key));
    for (const [key, pl] of this.priceLines) {
      if (!keys.has(key)) {
        this.series.removePriceLine(pl);
        this.priceLines.delete(key);
      }
    }
    for (const [key, el] of this.labels) {
      if (!keys.has(key) || lines.find((l) => l.key === key)!.label === null) {
        el.remove();
        this.labels.delete(key);
        this.leaders.get(key)?.remove();
        this.leaders.delete(key);
      }
    }
    for (const l of lines) {
      const color = l.invalid ? '#d50000' : l.color;
      const opts = { price: l.price, color, lineStyle: l.style, lineWidth: l.width, title: '', axisLabelVisible: true };
      const pl = this.priceLines.get(l.key);
      if (pl) pl.applyOptions(opts);
      else this.priceLines.set(l.key, this.series.createPriceLine(opts));
      if (l.label !== null) this.updateLabel(l, color);
    }
    this.placeLabels();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.leaders.clear();
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.labelBox.remove();
  }

  // ---------------- 标签 ----------------

  private updateLabel(l: OverlayLine, color: string): void {
    let el = this.labels.get(l.key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'order-line-label';
      el.innerHTML = '<button class="q tp" title="按预设距离设止盈（4 倍 ATR）">TP</button>'
        + '<button class="q sl" title="按预设距离设止损（2 倍 ATR）">SL</button>'
        + '<span class="text"></span><button class="submit">提交</button><button class="x" title="取消">×</button>';
      const key = l.key;
      for (const btn of el.querySelectorAll('button')) btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.querySelector('.x')!.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handlers?.onClose(key);
      });
      el.querySelector('.submit')!.addEventListener('click', (e) => {
        e.stopPropagation();
        if ((e.currentTarget as HTMLElement).classList.contains('disabled')) return;
        this.handlers?.onSubmit(key);
      });
      for (const kind of ['tp', 'sl'] as const) {
        const btn = el.querySelector(`.q.${kind}`)!;
        btn.addEventListener('pointerdown', (e) => {
          if ((e as PointerEvent).button !== 0) return;
          e.preventDefault();
          this.quickPress = { key, kind, y: (e as PointerEvent).clientY };
        });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.suppressClick) return;
          this.handlers?.onQuick(key, kind);
        });
      }
      // 按住标签本身也能拖这条线
      el.addEventListener('pointerdown', (e) => {
        const line = this.lines.find((x) => x.key === key);
        if (e.button === 0 && line?.draggable) this.beginDrag(line, e);
      });
      this.labelBox.append(el);
      this.labels.set(l.key, el);
      const leader = document.createElement('div');
      leader.className = 'order-line-leader';
      this.labelBox.append(leader);
      this.leaders.set(l.key, leader);
    }
    this.leaders.get(l.key)!.style.borderLeftColor = color;
    (el.querySelector('.text') as HTMLSpanElement).textContent = l.label;
    (el.querySelector('.x') as HTMLButtonElement).style.display = l.closable ? '' : 'none';
    // 「提交」变灰时不用 disabled 属性：禁用的按钮收不到鼠标事件，就显示不了原因
    const submit = el.querySelector('.submit') as HTMLButtonElement;
    submit.style.display = l.submit ? '' : 'none';
    submit.className = `submit ${l.submit?.side ?? ''}${l.submit?.reason ? ' disabled' : ''}`;
    submit.title = l.submit?.reason ?? '提交这张单（与下单面板的提交按钮相同）';
    (el.querySelector('.q.tp') as HTMLButtonElement).style.display = l.quick?.tp ? '' : 'none';
    (el.querySelector('.q.sl') as HTMLButtonElement).style.display = l.quick?.sl ? '' : 'none';
    el.style.borderColor = color;
    el.style.color = color;
    el.classList.toggle('draggable', l.draggable);
    el.classList.toggle('dragging', this.dragging?.key === l.key);
  }

  /**
   * 标签放在线的高度、价格轴左侧（给价格轴「+」留出位置）；线在可见范围外时隐藏。
   * D82：挨得太近（会叠在一起）的几张标签组成一组，以它们价位的平均高度为中心上下对称竖着叠开，
   * 组内按价位、再按线的先后从上到下（#1、#2、#3、#4）；两组挤到一起时合并重排。被挤开的标签右边画一条竖直虚线连回自己的价位。
   */
  private placeLabels(): void {
    if (this.labels.size === 0) return;
    const paneWidth = this.chart.chartElement().clientWidth - this.series.priceScale().width();
    const paneHeight = this.chart.chartElement().clientHeight - this.chart.timeScale().height();
    const right = this.wrapper.clientWidth - paneWidth + 28;
    const visible: Array<{ key: string; el: HTMLDivElement; y: number }> = [];
    for (const l of this.lines) {
      const el = this.labels.get(l.key);
      if (!el) continue;
      const y = this.series.priceToCoordinate(l.price);
      if (y === null || y < 0 || y > paneHeight) {
        el.style.display = 'none';
        this.leaders.get(l.key)!.style.display = 'none';
        continue;
      }
      el.style.display = '';
      visible.push({ key: l.key, el, y });
    }
    // 排序是稳定的：同一价位时保持线的先后
    visible.sort((a, b) => a.y - b.y);
    // 分组：每组的标签中心 = 组中心 ± 半格；与上一组重叠就合并，直到不再重叠
    type Group = { items: typeof visible; top: number };
    const layout = (items: typeof visible): Group => {
      const center = items.reduce((sum, v) => sum + v.y, 0) / items.length;
      const top = Math.min(Math.max(center - (items.length * LABEL_STEP_PX) / 2, 0), Math.max(0, paneHeight - items.length * LABEL_STEP_PX));
      return { items, top };
    };
    const groups: Group[] = [];
    for (const v of visible) {
      let g = layout([v]);
      while (groups.length) {
        const prev = groups[groups.length - 1];
        if (prev.top + prev.items.length * LABEL_STEP_PX <= g.top) break;
        groups.pop();
        g = layout([...prev.items, ...g.items]);
      }
      groups.push(g);
    }
    for (const g of groups) {
      g.items.forEach((v, i) => {
        const center = g.top + i * LABEL_STEP_PX + LABEL_STEP_PX / 2;
        v.el.style.top = `${Math.round(center - 10)}px`;
        v.el.style.right = `${Math.round(right)}px`;
        // 虚线引导线：在标签右边，从标签中间竖直连到自己的价位
        const leader = this.leaders.get(v.key)!;
        if (Math.abs(center - v.y) <= LEADER_MIN_PX) {
          leader.style.display = 'none';
          return;
        }
        leader.style.display = '';
        leader.style.top = `${Math.round(Math.min(center, v.y))}px`;
        leader.style.height = `${Math.round(Math.abs(center - v.y))}px`;
        leader.style.right = `${Math.round(right - 6)}px`;
      });
    }
  }

  // ---------------- 拖线 ----------------

  /** 离鼠标纵坐标 5 像素以内、且最近的那条可拖的线 */
  private lineNearY(y: number): OverlayLine | null {
    let best: OverlayLine | null = null;
    let bestDist = GRAB_DISTANCE_PX + 0.01;
    for (const l of this.lines) {
      if (!l.draggable) continue;
      const ly = this.series.priceToCoordinate(l.price);
      if (ly === null) continue;
      const d = Math.abs(ly - y);
      if (d < bestDist) {
        best = l;
        bestDist = d;
      }
    }
    return best;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.dragging) return;
    if (e.target instanceof Element && e.target.closest('.order-line-label button')) return; // 点 ×、TP、SL 不算拖线
    const p = toPanePoint(e, this.chart, this.series);
    if (!p.insidePane) return;
    const line = this.lineNearY(p.y);
    if (line) this.beginDrag(line, e);
  }

  private beginDrag(line: OverlayLine, e: PointerEvent): void {
    // 抓住了：拦下这次按下，图表和画线库都收不到
    e.stopPropagation();
    e.preventDefault();
    this.startDragging(line.key, line.price);
  }

  /** 进入拖动状态：临时关掉图表自身的拖动和缩放 */
  private startDragging(key: string, price: number): void {
    this.dragging = { key, price };
    const o = this.chart.options();
    this.savedChartOptions = { handleScroll: structuredClone(o.handleScroll), handleScale: structuredClone(o.handleScale) };
    this.chart.applyOptions({ handleScroll: false, handleScale: false });
    document.body.style.cursor = 'ns-resize';
  }

  private blockIfDragging(e: MouseEvent): void {
    if (this.dragging) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  private onPointerMove(e: PointerEvent): void {
    // 在 TP / SL 上按下后移动超过 3 像素：变成「拉出一条新线」
    if (this.quickPress && !this.dragging && Math.abs(e.clientY - this.quickPress.y) > 3) {
      this.startDragging(`quick|${this.quickPress.key}|${this.quickPress.kind}`, NaN);
    }
    if (!this.dragging) return;
    const p = toPanePoint(e, this.chart, this.series);
    const y = Math.min(Math.max(p.y, 0), p.paneHeight - 1);
    const raw = this.series.coordinateToPrice(y);
    if (raw === null) return;
    // 吸附到步长（止盈止损、挂单价按 2 位小数，D58；步长不小于最小价格单位）
    const price = Number((Math.round(raw / this.snapStep) * this.snapStep).toFixed(6));
    if (price === this.dragging.price) return;
    this.dragging.price = price;
    this.handlers?.onDrag(this.dragging.key, price);
  }

  private onPointerUp(): void {
    this.quickPress = null;
    if (!this.dragging) return;
    const { key, price } = this.dragging;
    if (key.startsWith('quick|')) {
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false), 0);
    }
    this.dragging = null;
    if (this.savedChartOptions) {
      this.chart.applyOptions(this.savedChartOptions as Parameters<IChartApi['applyOptions']>[0]);
      this.savedChartOptions = null;
    }
    document.body.style.cursor = '';
    if (!Number.isNaN(price)) this.handlers?.onDrop(key, price);
  }
}
