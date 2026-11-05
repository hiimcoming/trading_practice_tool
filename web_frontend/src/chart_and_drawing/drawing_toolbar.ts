// 画线库 B（web_frontend/vendor/ 里的 lightweight-charts-drawing 0.6.2）及左侧画线工具栏（规格书 6.8 节）。
// 来源：第 1 阶段手感原型（用户实测过）。
// 第 4b 阶段（D64）：
//   - 撤销 / 重做（⌘Z、⌘⇧Z，Windows 上 Ctrl+Z、Ctrl+Y）：只针对画线。每完成一次操作（放下、拖完松手、改样式、删除、清除全部）
//     记一份全部画线的快照；拖动途中不记，松手才记，所以拖一次算一步。光标在输入框里时不拦截（留给输入框自己撤销）。
//     撤销记录只在本页有效，最多 100 步。每次记快照都通知外面保存（随「保存进度」一起送到服务器）。
//   - 样式记忆：每类工具记住最后一次用的样式（颜色、线宽、线型等，不含锁定），新画的线直接沿用；存在用户设置 drawing_styles 里。
// 开放 5 种工具（规格书 6.8 节，D62 加水平射线）：水平线、水平射线（只向右）、线段、斐波那契回撤、方框。
// 线类工具的图标照 TradingView：带小圆点的线（D62：原来的文字符号「—」「╱」看起来和水平线没区别）。
// 我们的默认配置：斐波那契显示 0、0.236、0.382、0.5、0.618、0.786、1，加上新增的 1.382；其余扩展档隐藏；分档填色调淡；
// 线和方框的默认颜色跟随当前配色（方框边框 1 像素、填充偏淡）。
// 快捷键：B 本身不处理 Alt+H 这类工具快捷键（只处理 Esc、Delete），这里补上；Mac 上按 Option 会改变字符，所以按物理键位判断。

import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { DrawingManager, factoryStyleFor, setDefaultStyleOverride, type DrawingKind, type DrawingStyle, type FutureAxis } from 'lightweight-charts-drawing';

interface ToolDef {
  kind: DrawingKind;
  /** 文字图标，或以「<svg」开头的矢量图标 */
  icon: string;
  name: string;
  hotkey: string;
  /** 物理键位 + 是否要 Shift */
  code: string;
  shift: boolean;
}

// 矢量图标（18×18，线条用当前文字颜色，小圆点内部用面板底色）
const DOT = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="2.2" fill="var(--panel)" stroke="currentColor" stroke-width="1.4"/>`;
const svg = (body: string) => `<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">${body}</svg>`;
const ICON_HLINE = svg(`<line x1="1.5" y1="9" x2="16.5" y2="9"/>${DOT(9, 9)}`);
const ICON_HRAY = svg(`<line x1="4" y1="9" x2="16.5" y2="9"/>${DOT(4, 9)}`);
const ICON_TREND = svg(`<line x1="4" y1="14" x2="14" y2="4"/>${DOT(4, 14)}${DOT(14, 4)}`);

const TOOLS: ToolDef[] = [
  { kind: 'horizontal-line', icon: ICON_HLINE, name: '水平线', hotkey: '⌥H', code: 'KeyH', shift: false },
  { kind: 'horizontal-ray', icon: ICON_HRAY, name: '水平射线（向右）', hotkey: '⌥J', code: 'KeyJ', shift: false },
  { kind: 'trend-line', icon: ICON_TREND, name: '线段', hotkey: '⌥T', code: 'KeyT', shift: false },
  { kind: 'fib-retracement', icon: 'F', name: '斐波那契回撤', hotkey: '⌥F', code: 'KeyF', shift: false },
  { kind: 'rectangle', icon: '▭', name: '方框', hotkey: '⌥⇧R', code: 'KeyR', shift: true },
];

const FIB_SHOWN = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.382];

/** 新画线的默认颜色（随配色切换；已经画好的线保持原样，与 TradingView 一致） */
export interface DrawingPalette {
  drawingLine: string;
  boxBorder: string;
  boxFill: string;
  boxFillTransparency: number;
  fibFillTransparency: number;
}

let palette: DrawingPalette | null = null;

/** 切换配色时调用：之后新画的线用新的默认颜色 */
export function setDrawingPalette(p: DrawingPalette): void {
  palette = p;
}

/** 每类工具最后一次用的样式（只存设置条能改的那几项），键是工具种类 */
export type DrawingStyleMemory = Record<string, Partial<DrawingStyle>>;

/** 样式记忆里允许保存的字段（锁定、隐藏这类状态不沿用） */
const REMEMBERED_FIELDS = ['color', 'textColor', 'width', 'lineStyle', 'backgroundColor', 'transparency', 'fibTrendLine'] as const;

let styleMemory: DrawingStyleMemory = {};

/** 读入用户设置里的样式记忆（开页时调用一次）；只保留认识的字段，防止旧数据或坏数据混进来 */
export function setDrawingStyleMemory(m: unknown): void {
  styleMemory = {};
  if (!m || typeof m !== 'object') return;
  for (const [kind, st] of Object.entries(m as Record<string, unknown>)) {
    if (st && typeof st === 'object') styleMemory[kind] = pickRemembered(st as Partial<DrawingStyle>);
  }
}

/** 记住某类工具这次用的样式，返回新的整份记忆（交给外面存进用户设置） */
export function rememberDrawingStyle(kind: string, style: Partial<DrawingStyle>): DrawingStyleMemory {
  styleMemory = { ...styleMemory, [kind]: { ...styleMemory[kind], ...pickRemembered(style) } };
  return styleMemory;
}

function pickRemembered(st: Partial<DrawingStyle>): Partial<DrawingStyle> {
  const out: Record<string, unknown> = {};
  for (const f of REMEMBERED_FIELDS) if (st[f] !== undefined) out[f] = st[f];
  return out as Partial<DrawingStyle>;
}

/** 新画线的样式 = 我们的默认（随配色）+ 该类工具最后一次用的样式 */
export function newDrawingStyle(kind: string): DrawingStyle | undefined {
  const base = ourDefaultStyle(kind);
  const mem = styleMemory[kind];
  if (!mem) return base;
  return { ...(base ?? factoryStyleFor(kind as DrawingKind)), ...mem };
}

/** 在创建任何画线之前调用：覆盖 B 的出厂默认（斐波那契档位与填色、线和方框的颜色，再叠加样式记忆） */
function applyOurDrawingDefaults(): void {
  setDefaultStyleOverride(newDrawingStyle);
}

/** 我们的默认配置（不含样式记忆）：斐波那契档位与填色、线和方框的颜色随配色 */
function ourDefaultStyle(kind: string): DrawingStyle | undefined {
  if (kind === 'fib-retracement') {
    const factory = factoryStyleFor('fib-retracement');
    const levels = (factory.levels ?? []).map((lv) => ({ ...lv, visible: FIB_SHOWN.includes(lv.coeff) }));
    if (!levels.some((lv) => lv.coeff === 1.382)) {
      levels.push({ coeff: 1.382, color: '#2962ff', visible: true });
    }
    levels.sort((a, b) => a.coeff - b.coeff);
    return { ...factory, levels, transparency: palette?.fibFillTransparency ?? 92 };
  }
  if (!palette) return undefined;
  if (kind === 'horizontal-line' || kind === 'horizontal-ray' || kind === 'trend-line') {
    return { ...factoryStyleFor(kind), color: palette.drawingLine, textColor: palette.drawingLine };
  }
  if (kind === 'rectangle') {
    const factory = factoryStyleFor('rectangle');
    return {
      ...factory,
      color: palette.boxBorder,
      width: 1,
      backgroundColor: palette.boxFill,
      transparency: palette.boxFillTransparency,
    };
  }
  return undefined;
}

export function setupDrawingTools(
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  toolbar: HTMLElement,
  setHint: (text: string | null) => void,
  future: () => FutureAxis | null,
): DrawingManager {
  applyOurDrawingDefaults();
  // future：交易日历（跳过周末和休市），让右侧未来区的画线落在真实会出现的 K 线上（vendor 里补上的选项）
  const drawings = new DrawingManager(chart, series, { magnet: 'off', future });
  const buttons = new Map<DrawingKind | null, HTMLButtonElement>();

  const addButton = (key: DrawingKind | null, icon: string, title: string, onClick: () => void) => {
    const b = document.createElement('button');
    if (icon.startsWith('<svg')) b.innerHTML = icon;
    else b.textContent = icon;
    b.title = title;
    b.addEventListener('click', onClick);
    toolbar.append(b);
    buttons.set(key, b);
  };

  addButton(null, '↖', '选择（Esc）', () => drawings.setTool(null));
  for (const t of TOOLS) addButton(t.kind, t.icon, `${t.name}（${t.hotkey}）`, () => drawings.setTool(t.kind));
  toolbar.append(document.createElement('hr'));
  const hideBtn = document.createElement('button');
  hideBtn.textContent = '👁';
  hideBtn.title = '隐藏 / 显示全部画线';
  hideBtn.addEventListener('click', () => drawings.setDrawingsVisible(!drawings.drawingsVisible()));
  toolbar.append(hideBtn);
  const clearBtn = document.createElement('button');
  clearBtn.textContent = '🗑';
  clearBtn.title = '清除全部画线（不影响订单线，可 ⌘Z 撤销）';
  clearBtn.addEventListener('click', () => drawings.clear());
  toolbar.append(clearBtn);

  const refresh = () => {
    const active = drawings.tool();
    for (const [k, b] of buttons) b.classList.toggle('active', k === active);
    hideBtn.classList.toggle('active', !drawings.drawingsVisible());
    if (active) {
      const def = TOOLS.find((t) => t.kind === active);
      setHint(`正在画${def?.name ?? ''}：在图上点击放置，Shift 锁定 45° / 正方形，Esc 取消`);
    } else if (drawings.selection().length) {
      setHint('拖动端点或整体编辑，Ctrl+拖动复制，Del 删除，Esc 取消选中');
    } else {
      setHint(null);
    }
  };
  drawings.on('tool', refresh);
  drawings.on('selection', refresh);
  drawings.on('visibility', refresh);
  refresh();

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey) return;
    const t = TOOLS.find((x) => x.code === e.code && x.shift === e.shiftKey);
    if (!t) return;
    e.preventDefault();
    drawings.setTool(t.kind);
  });
  return drawings;
}

// ---------------- 撤销 / 重做（D64） ----------------

const MAX_UNDO_STEPS = 100;

/**
 * 画线的操作历史：每一份是「全部画线」的 JSON 快照。只管快照的进出，不碰图表，方便单独测试。
 * commit：一次操作完成后调用，和上一份不同才记；undo / redo 返回要恢复成的快照（没有可撤销的返回 null）。
 */
export class DrawingHistory {
  private current: string;
  private readonly undoStack: string[] = [];
  private redoStack: string[] = [];

  constructor(initial: string) {
    this.current = initial;
  }

  /** 记下一次操作后的状态；和上一份相同（例如只是选中）返回 false */
  commit(snapshot: string): boolean {
    if (snapshot === this.current) return false;
    this.undoStack.push(this.current);
    if (this.undoStack.length > MAX_UNDO_STEPS) this.undoStack.shift();
    this.redoStack = [];
    this.current = snapshot;
    return true;
  }

  undo(): string | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(this.current);
    this.current = prev;
    return prev;
  }

  redo(): string | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(this.current);
    this.current = next;
    return next;
  }

  get snapshot(): string {
    return this.current;
  }
}

/**
 * 把操作历史接到画线库上：画线有变化时，等这次操作结束（鼠标松开 / B 的 gestureEnd）再记快照并通知外面保存；
 * 监听 ⌘Z / ⌘⇧Z（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z）。返回拆除函数。
 * 调用前应先把保存过的画线导入完，导入那一下不算一次操作。
 */
export function attachDrawingHistory(drawings: DrawingManager, onCommitted: (json: string) => void): () => void {
  const history = new DrawingHistory(drawings.exportJSON());
  let pointerDown = false;
  let pending = false;
  let restoring = false;

  const commitNow = () => {
    if (!pending || pointerDown) return;
    pending = false;
    const json = drawings.exportJSON();
    if (history.commit(json)) onCommitted(json);
  };
  // 松手后 B 自己还要处理这次 pointerup（拖动的最后一下），所以晚一拍再记
  const commitSoon = () => window.setTimeout(commitNow, 0);

  const offChange = drawings.on('change', () => {
    if (restoring) return;
    pending = true;
    if (!pointerDown) commitSoon();
  });
  const offGesture = drawings.on('gestureEnd', () => {
    pending = true;
    pointerDown = false;
    commitSoon();
  });
  const onDown = () => {
    pointerDown = true;
  };
  const onUp = () => {
    pointerDown = false;
    if (pending) commitSoon();
  };

  const restore = (json: string | null) => {
    if (json === null) return;
    restoring = true;
    try {
      drawings.importJSON(json);
    } finally {
      restoring = false;
    }
    onCommitted(json);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const isZ = e.code === 'KeyZ';
    const isRedo = (isZ && e.shiftKey) || (e.code === 'KeyY' && e.ctrlKey && !e.metaKey);
    if (!isZ && !isRedo) return;
    e.preventDefault();
    if (pointerDown) return; // 正在拖：不撤销
    commitNow(); // 还没记下的改动先记，再撤销
    restore(isRedo ? history.redo() : history.undo());
  };

  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  window.addEventListener('keydown', onKey);
  return () => {
    offChange();
    offGesture();
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    window.removeEventListener('keydown', onKey);
  };
}
