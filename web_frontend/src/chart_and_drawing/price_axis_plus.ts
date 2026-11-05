// 价格轴「+」（规格书 6.7 节主入口，照 Exness 网页版和 OKX；D17）：鼠标在图上移动时，图表右边缘跟着十字线出现「+」，
// 点它弹出小菜单，只列出这个价位可能的两种挂单（现价上方：卖出限价、买入止损；下方：买入限价、卖出止损），
// 菜单里的手数 = 下单面板当前的手数；选一项就生成草稿单（不会直接下单）。
// 来源：第 1 阶段手感原型 tm_feel_prototype/prototype_code/prototype_feel_test/price_axis_plus.ts（用户实测通过，D44），2026-10-21 复制后改写：
//   挂单类型改由交易规则 classifyPending 判断（买单看买价、卖单看卖价），菜单选项改为生成草稿单。
// 做法（思路参考 Lightweight Charts 官方插件示例 user-price-alerts）：
//   · 「+」是叠在图表上的小方块，本身不接收鼠标（pointer-events: none），是否点中由我们在图表外层元素上按坐标判断，
//     所以鼠标移过去时十字线不会消失；
//   · 在「+」上按下时拦下事件，图表不会因此开始平移，画线工具也不会在这里落点。
//   · D73：在图上其他地方按住鼠标（拖方框、拖线、平移）期间「+」不出现，拖到价格轴边上也碰不到它；松开后恢复。
//     选中画线工具时也不出现（由 isBusy 判断）。

import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { snapToTick, toPanePoint, type PanePoint } from './chart_mouse';

const BUTTON_SIZE = 20;

export interface PriceAxisPlusOptions {
  tick: number;
  precision: number;
  /** 菜单里显示的手数（下单面板当前的手数） */
  qtyText: () => string;
  /** 这个方向在这个价位是什么挂单（如「买入限价」）；不能挂（等于现价、还没有价格）时返回 null */
  kindName: (direction: 1 | -1, price: number) => string | null;
  /** 正在拖线、选中了画线工具、或不能交易时「+」不出现 */
  isBusy: () => boolean;
  onChoose: (direction: 1 | -1, price: number) => void;
}

export class PriceAxisPlus {
  private readonly button: HTMLDivElement;
  private readonly menu: HTMLDivElement;
  private pressedInButton = false;
  /** 在图上（不是「+」上）按住了鼠标：拖画线、拖订单线或平移中（D73） */
  private held = false;
  private readonly onDocPointerDown = (e: PointerEvent) => {
    if (!this.menu.contains(e.target as Node) && !this.pressedInButton) this.hideMenu();
  };
  /** 在图外松开鼠标也要解除「按住」 */
  private readonly onDocPointerUp = () => {
    this.held = false;
  };
  private readonly onDocKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.hideMenu();
  };

  constructor(
    private readonly chart: IChartApi,
    private readonly series: ISeriesApi<SeriesType>,
    private readonly wrapper: HTMLElement,
    private readonly opts: PriceAxisPlusOptions,
  ) {
    this.button = document.createElement('div');
    this.button.className = 'axis-plus-button';
    this.button.textContent = '+';
    this.menu = document.createElement('div');
    this.menu.className = 'axis-plus-menu';
    wrapper.append(this.button, this.menu);
    this.hideMenu();
    this.hideButton();
    wrapper.addEventListener('mousemove', (e) => this.onMove(e));
    wrapper.addEventListener('mouseleave', () => this.hideButton());
    // 捕获阶段：比图表、画线库都早拿到
    wrapper.addEventListener('pointerdown', (e) => this.onPointerDown(e), true);
    wrapper.addEventListener('pointerup', (e) => this.onPointerUp(e), true);
    document.addEventListener('keydown', this.onDocKey);
    document.addEventListener('pointerdown', this.onDocPointerDown);
    document.addEventListener('pointerup', this.onDocPointerUp);
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onDocKey);
    document.removeEventListener('pointerdown', this.onDocPointerDown);
    document.removeEventListener('pointerup', this.onDocPointerUp);
    this.button.remove();
    this.menu.remove();
  }

  private inButton(p: PanePoint): boolean {
    const top = this.buttonTop(p.y);
    return p.x >= p.paneWidth - BUTTON_SIZE - 2 && p.x < p.paneWidth && p.y >= top && p.y < top + BUTTON_SIZE;
  }

  private buttonTop(y: number): number {
    return Math.round(y - BUTTON_SIZE / 2);
  }

  private onMove(e: MouseEvent): void {
    if (this.held || this.opts.isBusy()) return this.hideButton();
    const p = toPanePoint(e, this.chart, this.series);
    if (!p.insidePane) return this.hideButton();
    // 鼠标已经在「+」上时不再跟着移动，避免按钮在手下乱跑
    if (this.button.style.display === 'flex' && this.inButton(p)) {
      this.button.classList.add('hover');
      return;
    }
    this.button.classList.remove('hover');
    this.button.style.display = 'flex';
    this.button.style.left = `${p.paneWidth - BUTTON_SIZE - 2}px`;
    this.button.style.top = `${this.buttonTop(p.y)}px`;
    this.button.dataset.y = String(p.y);
  }

  private hideButton(): void {
    this.button.style.display = 'none';
    this.button.classList.remove('hover');
  }

  private onPointerDown(e: PointerEvent): void {
    this.pressedInButton = false;
    const p = toPanePoint(e, this.chart, this.series);
    if (e.button !== 0 || this.button.style.display !== 'flex' || !p.insidePane || !this.inButton(p)) {
      this.held = true;
      this.hideButton();
      return;
    }
    this.pressedInButton = true;
    e.stopPropagation();
    e.preventDefault();
  }

  private onPointerUp(e: PointerEvent): void {
    this.held = false;
    if (!this.pressedInButton) return;
    this.pressedInButton = false;
    e.stopPropagation();
    const y = Number(this.button.dataset.y);
    const raw = this.series.coordinateToPrice(y);
    if (raw === null) return;
    this.showMenu(snapToTick(raw, this.opts.tick, this.opts.precision), y);
  }

  private showMenu(price: number, y: number): void {
    const priceText = price.toLocaleString('en-US', { minimumFractionDigits: this.opts.precision, maximumFractionDigits: this.opts.precision });
    this.menu.innerHTML = '';
    // 价位在现价上方时先列卖单（卖出限价、买入止损），下方时先列买单（照规格书 6.7 节的顺序）
    const items: Array<{ dir: 1 | -1; name: string }> = [];
    for (const dir of [-1, 1] as const) {
      const name = this.opts.kindName(dir, price);
      if (name) items.push({ dir, name });
    }
    if (items.some((i) => i.name === '买入限价')) items.reverse();
    if (items.length === 0) this.menu.append(this.menuNote(`挂单价不能等于现价 ${priceText}`));
    for (const it of items) {
      const item = document.createElement('button');
      item.className = it.dir === 1 ? 'buy' : 'sell';
      item.textContent = `${it.name} ${this.opts.qtyText()} @ ${priceText}`;
      item.addEventListener('click', () => {
        this.hideMenu();
        this.opts.onChoose(it.dir, price);
      });
      this.menu.append(item);
    }
    const paneWidth = this.chart.chartElement().clientWidth - this.series.priceScale().width();
    this.menu.style.display = 'flex';
    this.menu.style.top = `${Math.max(0, y - 10)}px`;
    this.menu.style.right = `${this.wrapper.clientWidth - paneWidth + BUTTON_SIZE + 6}px`;
  }

  private menuNote(text: string): HTMLDivElement {
    const d = document.createElement('div');
    d.className = 'note';
    d.textContent = text;
    return d;
  }

  private hideMenu(): void {
    this.menu.style.display = 'none';
  }
}
