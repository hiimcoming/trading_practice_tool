// 画线设置工具条（第 4b 阶段，D64）：放在顶栏第 2 行左边（D63 预留的 .drawing-settings-slot），选中画线后出现、取消选中后消失。
// 内容（照 TradingView 的浮动工具条）：工具名 · 颜色（色块 + 不透明度滑杆）· 线宽 1–4 · 线型（实线 / 虚线 / 点线）· 锁定 · 删除。
// 「颜色 + 不透明度」对各工具的含义：
//   - 水平线、水平射线、线段：颜色和不透明度都作用在线本身；
//   - 方框：边框和填充一起换成同一种颜色，不透明度只调填充（边框保持不透明）；
//   - 斐波那契：保留多彩分档，颜色只改连接起点和终点的那条斜线，不透明度调分档填色（用户 2026-10-22 选 B）。
// 线宽、线型对斐波那契作用在各档位线上，对方框作用在边框上。
// 锁定：可以选中，但拖不动、按 Delete 键删不掉；本工具条的 🗑 和「清除全部」仍然会删（都能 ⌘Z 撤销）。
// 同时选中多条时，改动作用在全部选中的线上，工具条显示第一条的样式。
// 每次改样式都通知外面「这类工具用了这个样式」（样式记忆，新画的线沿用）。
// 弹出的色板和菜单挂在 document.body 上（顶栏 overflow: hidden，挂在里面会被裁掉）。

import type { Drawing, DrawingManager, DrawingStyle } from 'lightweight-charts-drawing';

type LineStyleName = DrawingStyle['lineStyle'];

/** 工具条显示的样式（颜色不带透明度，不透明度 0–100） */
export interface StyleView {
  color: string;
  opacity: number;
  width: number;
  lineStyle: LineStyleName;
}

/** 一次改动（只改其中一项） */
export type StyleChange = Partial<StyleView>;

const LINE_KINDS = ['horizontal-line', 'horizontal-ray', 'trend-line'];
const FIB_TREND_DEFAULT = { visible: true, color: '#808080', width: 2, style: 'dashed' as LineStyleName };

const KIND_NAMES: Record<string, string> = {
  'horizontal-line': '水平线',
  'horizontal-ray': '水平射线',
  'trend-line': '线段',
  'fib-retracement': '斐波那契回撤',
  rectangle: '方框',
};

// ---------------- 颜色换算 ----------------

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** 把 #RGB / #RRGGBB / rgba() 拆成「#RRGGBB + 不透明度 0–100」；认不出时当作不透明的黑色 */
export function splitColor(c: string | undefined): { hex: string; opacity: number } {
  const v = (c ?? '').trim();
  const m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i);
  if (m) {
    const a = m[4] === undefined ? 1 : Number(m[4]);
    return { hex: `#${hex2(+m[1])}${hex2(+m[2])}${hex2(+m[3])}`.toUpperCase(), opacity: Math.round(a * 100) };
  }
  const h = v.replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(h)) return { hex: `#${h.split('').map((x) => x + x).join('')}`.toUpperCase(), opacity: 100 };
  if (/^[0-9a-f]{6}$/i.test(h)) return { hex: `#${h}`.toUpperCase(), opacity: 100 };
  return { hex: '#000000', opacity: 100 };
}

/** 合成颜色：不透明度 100 时用 #RRGGBB，否则用 rgba() */
export function joinColor(hex: string, opacity: number): string {
  const { hex: h } = splitColor(hex);
  if (opacity >= 100) return h;
  const n = parseInt(h.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${(Math.max(0, opacity) / 100).toFixed(2)})`;
}

/** 按白色 / 黑色混合出浅色和深色（色板用） */
function mix(hex: string, toward: '#FFFFFF' | '#000000', ratio: number): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(toward.slice(1), 16);
  const ch = (x: number, y: number) => x + (y - x) * ratio;
  return `#${hex2(ch(a >> 16, b >> 16))}${hex2(ch((a >> 8) & 255, (b >> 8) & 255))}${hex2(ch(a & 255, b & 255))}`.toUpperCase();
}

// 色板：一行灰阶 + 一行 TradingView 的 10 种主色，下面是主色的浅色（混白 75% / 50% / 25%）和深色（混黑 25% / 50%）
const GRAYS = ['#FFFFFF', '#EBEBEB', '#D6D6D6', '#BFBFBF', '#A8A8A8', '#8F8F8F', '#757575', '#5C5C5C', '#434343', '#000000'];
const HUES = ['#F23645', '#FF9800', '#FFEB3B', '#4CAF50', '#089981', '#00BCD4', '#2962FF', '#673AB7', '#9C27B0', '#E91E63'];
export const PALETTE_ROWS: string[][] = [
  GRAYS,
  HUES,
  HUES.map((h) => mix(h, '#FFFFFF', 0.75)),
  HUES.map((h) => mix(h, '#FFFFFF', 0.5)),
  HUES.map((h) => mix(h, '#FFFFFF', 0.25)),
  HUES.map((h) => mix(h, '#000000', 0.25)),
  HUES.map((h) => mix(h, '#000000', 0.5)),
];

// ---------------- 样式读写（不碰界面，方便单独测试） ----------------

/** 不透明度滑杆调的是什么：线本身 / 填充 */
export function opacityMeaning(kind: string): string {
  return LINE_KINDS.includes(kind) ? '不透明度' : '填充不透明度';
}

/** 读出一条画线在工具条上显示的样式 */
export function styleViewOf(d: Drawing): StyleView {
  const s = d.style;
  if (d.kind === 'rectangle') {
    return { color: splitColor(s.color).hex, opacity: 100 - (s.transparency ?? 85), width: s.width, lineStyle: s.lineStyle };
  }
  if (d.kind === 'fib-retracement') {
    const tl = s.fibTrendLine ?? FIB_TREND_DEFAULT;
    return { color: splitColor(tl.color).hex, opacity: 100 - (s.transparency ?? 80), width: s.width, lineStyle: s.lineStyle };
  }
  const c = splitColor(s.color);
  return { color: c.hex, opacity: c.opacity, width: s.width, lineStyle: s.lineStyle };
}

/** 把一次改动套到画线样式上，返回新样式（不改原来的） */
export function applyStyleChange(d: Drawing, ch: StyleChange): DrawingStyle {
  const s: DrawingStyle = { ...d.style };
  const cur = styleViewOf(d);
  if (ch.width !== undefined) s.width = ch.width;
  if (ch.lineStyle !== undefined) s.lineStyle = ch.lineStyle;
  const hex = ch.color ?? cur.color;
  const opacity = ch.opacity ?? cur.opacity;
  if (ch.color === undefined && ch.opacity === undefined) return s;
  if (d.kind === 'rectangle') {
    s.color = hex;
    s.backgroundColor = hex;
    s.transparency = 100 - opacity;
  } else if (d.kind === 'fib-retracement') {
    s.fibTrendLine = { ...(s.fibTrendLine ?? FIB_TREND_DEFAULT), color: hex };
    s.transparency = 100 - opacity;
  } else {
    s.color = joinColor(hex, opacity);
    s.textColor = hex; // 价格标签文字保持不透明，免得看不清
  }
  return s;
}

// ---------------- 界面 ----------------

const dashSvg = (style: LineStyleName, width: number) => {
  const dash = style === 'dashed' ? `stroke-dasharray="${4 + width} ${3 + width}"` : style === 'dotted' ? `stroke-dasharray="${width} ${width + 2}"` : '';
  return `<svg viewBox="0 0 28 10" width="28" height="10"><line x1="1" y1="5" x2="27" y2="5" stroke="currentColor" stroke-width="${width}" ${dash}/></svg>`;
};
const LINE_STYLES: Array<{ value: LineStyleName; name: string }> = [
  { value: 'solid', name: '实线' },
  { value: 'dashed', name: '虚线' },
  { value: 'dotted', name: '点线' },
];

export class DrawingSettingsBar {
  private readonly root = document.createElement('div');
  private readonly nameEl = document.createElement('span');
  private readonly colorBtn = document.createElement('button');
  private readonly widthBtn = document.createElement('button');
  private readonly styleBtn = document.createElement('button');
  private readonly lockBtn = document.createElement('button');
  private readonly deleteBtn = document.createElement('button');
  private popup: HTMLElement | null = null;
  private readonly offs: Array<() => void> = [];
  private readonly onOutside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (this.popup && !this.popup.contains(t) && !this.root.contains(t)) this.closePopup();
  };
  private readonly onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.popup) {
      this.closePopup();
      e.stopPropagation();
    }
  };

  constructor(
    private readonly slot: HTMLElement,
    private readonly drawings: DrawingManager,
    /** 某类工具刚用了这个样式（样式记忆） */
    private readonly onStyleUsed: (kind: string, style: DrawingStyle) => void,
  ) {
    this.root.className = 'drawing-settings';
    this.nameEl.className = 'ds-name';
    this.colorBtn.className = 'ds-color';
    this.colorBtn.title = '颜色';
    this.widthBtn.title = '线宽';
    this.styleBtn.title = '线型';
    this.deleteBtn.textContent = '🗑';
    this.deleteBtn.title = '删除（Del；可 ⌘Z 撤销）';
    this.root.append(this.nameEl, this.colorBtn, this.widthBtn, this.styleBtn, this.lockBtn, this.deleteBtn);
    this.slot.append(this.root);

    this.colorBtn.addEventListener('click', () => this.togglePopup(this.colorBtn, () => this.colorPopup()));
    this.widthBtn.addEventListener('click', () => this.togglePopup(this.widthBtn, () => this.widthPopup()));
    this.styleBtn.addEventListener('click', () => this.togglePopup(this.styleBtn, () => this.lineStylePopup()));
    this.lockBtn.addEventListener('click', () => this.toggleLock());
    this.deleteBtn.addEventListener('click', () => {
      for (const d of this.selected()) this.drawings.remove(d.id);
    });
    this.offs.push(drawings.on('selection', () => this.refresh()));
    this.offs.push(drawings.on('change', () => this.refresh()));
    window.addEventListener('pointerdown', this.onOutside, true);
    window.addEventListener('keydown', this.onEsc, true);
    this.refresh();
  }

  destroy(): void {
    for (const off of this.offs) off();
    window.removeEventListener('pointerdown', this.onOutside, true);
    window.removeEventListener('keydown', this.onEsc, true);
    this.closePopup();
    this.root.remove();
  }

  private selected(): Drawing[] {
    return this.drawings.selection().map((id) => this.drawings.get(id)).filter((d): d is Drawing => !!d);
  }

  /** 按当前选中的线刷新工具条（没选中就隐藏） */
  private refresh(): void {
    const sel = this.selected();
    this.root.hidden = sel.length === 0;
    if (!sel.length) {
      this.closePopup();
      return;
    }
    const first = sel[0];
    const v = styleViewOf(first);
    this.nameEl.textContent = sel.length > 1 ? `已选 ${sel.length} 条` : (KIND_NAMES[first.kind] ?? first.kind);
    this.colorBtn.style.setProperty('--swatch', joinColor(v.color, LINE_KINDS.includes(first.kind) ? v.opacity : 100));
    this.widthBtn.innerHTML = `${dashSvg('solid', v.width)}<span>${v.width}px</span>`;
    this.styleBtn.innerHTML = dashSvg(v.lineStyle, 2);
    const locked = sel.every((d) => d.locked);
    this.lockBtn.textContent = locked ? '🔒' : '🔓';
    this.lockBtn.title = locked ? '已锁定（拖不动、Del 删不掉），点一下解锁' : '锁定（拖不动、Del 删不掉）';
    this.lockBtn.classList.toggle('active', locked);
  }

  /** 把一次改动作用在全部选中的线上，并记进样式记忆 */
  private apply(ch: StyleChange): void {
    for (const d of this.selected()) {
      const style = applyStyleChange(d, ch);
      this.drawings.update({ ...d, style } as Drawing);
      this.onStyleUsed(d.kind, style);
    }
  }

  private toggleLock(): void {
    const sel = this.selected();
    const lock = !sel.every((d) => d.locked);
    for (const d of sel) this.drawings.update({ ...d, locked: lock } as Drawing);
  }

  // ---------------- 弹出层 ----------------

  private togglePopup(anchor: HTMLElement, build: () => HTMLElement): void {
    const wasOpenHere = this.popup?.dataset.anchor === anchor.title;
    this.closePopup();
    if (wasOpenHere) return;
    const p = build();
    p.classList.add('ds-popup');
    p.dataset.anchor = anchor.title;
    const r = anchor.getBoundingClientRect();
    p.style.left = `${Math.round(r.left)}px`;
    p.style.top = `${Math.round(r.bottom + 4)}px`;
    document.body.append(p);
    this.popup = p;
  }

  private closePopup(): void {
    this.popup?.remove();
    this.popup = null;
  }

  private colorPopup(): HTMLElement {
    const first = this.selected()[0];
    const v = styleViewOf(first);
    const p = document.createElement('div');
    const grid = document.createElement('div');
    grid.className = 'ds-palette';
    for (const row of PALETTE_ROWS) {
      for (const c of row) {
        const b = document.createElement('button');
        b.style.background = c;
        b.title = c;
        b.classList.toggle('current', c === v.color);
        b.addEventListener('click', () => {
          this.apply({ color: c });
          for (const x of grid.querySelectorAll('button')) x.classList.toggle('current', x === b);
        });
        grid.append(b);
      }
    }
    const label = document.createElement('label');
    label.className = 'ds-opacity';
    const text = document.createElement('span');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(v.opacity);
    const showText = () => (text.textContent = `${opacityMeaning(first.kind)} ${slider.value}%`);
    slider.addEventListener('input', () => {
      showText();
      this.apply({ opacity: Number(slider.value) });
    });
    showText();
    label.append(text, slider);
    p.append(grid, label);
    return p;
  }

  private widthPopup(): HTMLElement {
    const cur = styleViewOf(this.selected()[0]).width;
    return this.menu([1, 2, 3, 4].map((w) => ({ html: `${dashSvg('solid', w)}<span>${w}px</span>`, current: w === cur, pick: () => this.apply({ width: w }) })));
  }

  private lineStylePopup(): HTMLElement {
    const cur = styleViewOf(this.selected()[0]).lineStyle;
    return this.menu(LINE_STYLES.map((s) => ({ html: `${dashSvg(s.value, 2)}<span>${s.name}</span>`, current: s.value === cur, pick: () => this.apply({ lineStyle: s.value }) })));
  }

  private menu(items: Array<{ html: string; current: boolean; pick: () => void }>): HTMLElement {
    const p = document.createElement('div');
    p.className = 'ds-menu';
    for (const it of items) {
      const b = document.createElement('button');
      b.innerHTML = it.html;
      b.classList.toggle('current', it.current);
      b.addEventListener('click', () => {
        it.pick();
        this.closePopup();
      });
      p.append(b);
    }
    return p;
  }
}
