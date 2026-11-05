// 三套配色（规格书 5.8、15.11 节，D45）：默认「柔和浅灰」，另两套在设置页可选。来源：第 1 阶段手感原型（用户实测过）。
// 每套配色包含：图表背景/文字/网格/坐标轴边框、K 线涨跌色、页面外框的颜色，以及「新画线」的默认颜色和填充透明度。
// 透明度用 TradingView 的 0–100 口径：数字越大越透明。

export interface ThemePalette {
  id: 'dark' | 'tv_white' | 'soft_gray';
  name: string;
  chartBackground: string;
  chartText: string;
  grid: string;
  axisBorder: string;
  crosshair: string;
  up: string;
  down: string;
  /** 页面外框（顶栏、工具栏、状态栏、菜单）的 CSS 变量 */
  css: Record<string, string>;
  /** 新画线的默认颜色：水平线、线段 */
  drawingLine: string;
  /** 新方框的边框颜色、填充颜色、填充透明度 */
  boxBorder: string;
  boxFill: string;
  boxFillTransparency: number;
  /** 斐波那契分档填色的透明度 */
  fibFillTransparency: number;
}

export const THEMES: ThemePalette[] = [
  {
    id: 'dark',
    name: '深色',
    chartBackground: '#131722',
    chartText: '#d1d4dc',
    grid: '#1e222d',
    axisBorder: '#2a2e39',
    crosshair: '#758696',
    up: '#089981',
    down: '#f23645',
    css: { '--bg': '#131722', '--panel': '#1e222d', '--hover': '#2a2e39', '--border': '#2a2e39', '--text': '#d1d4dc', '--muted': '#787b86' },
    drawingLine: '#5b8cff',
    boxBorder: '#8e7cc3',
    boxFill: '#8e7cc3',
    boxFillTransparency: 85,
    fibFillTransparency: 92,
  },
  {
    id: 'tv_white',
    name: 'TradingView 白色',
    chartBackground: '#ffffff',
    chartText: '#131722',
    grid: '#f0f3fa',
    axisBorder: '#e0e3eb',
    crosshair: '#9598a1',
    up: '#089981',
    down: '#f23645',
    css: { '--bg': '#ffffff', '--panel': '#f8f9fd', '--hover': '#eef1f8', '--border': '#e0e3eb', '--text': '#131722', '--muted': '#787b86' },
    drawingLine: '#2962ff',
    boxBorder: '#5c6bc0',
    boxFill: '#5c6bc0',
    boxFillTransparency: 88,
    fibFillTransparency: 92,
  },
  {
    id: 'soft_gray',
    name: '柔和浅灰',
    chartBackground: '#eef0f3',
    chartText: '#2b2f36',
    grid: '#e1e4e9',
    axisBorder: '#d3d7de',
    crosshair: '#8a8f99',
    up: '#0b9c7c',
    down: '#e0464b',
    css: { '--bg': '#e7eaee', '--panel': '#f4f5f7', '--hover': '#dde1e7', '--border': '#d3d7de', '--text': '#2b2f36', '--muted': '#6b7280' },
    drawingLine: '#3a6df0',
    boxBorder: '#6b7fb3',
    boxFill: '#6b7fb3',
    boxFillTransparency: 85,
    fibFillTransparency: 90,
  },
];

const STORAGE_KEY = 'trading_practice_tool.theme';

export const DEFAULT_THEME_ID: ThemePalette['id'] = 'soft_gray';

export function themeById(id: unknown): ThemePalette {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
}

/** 读当前浏览器上次用的配色（用户设置还没读到时先用它，避免闪一下；读不到就用默认的柔和浅灰） */
export function loadSavedTheme(): ThemePalette {
  try {
    return themeById(localStorage.getItem(STORAGE_KEY));
  } catch {
    return themeById(DEFAULT_THEME_ID);
  }
}

/** 套用页面外框的颜色（CSS 变量） */
export function applyPageTheme(theme: ThemePalette): void {
  for (const [k, v] of Object.entries(theme.css)) document.documentElement.style.setProperty(k, v);
  document.documentElement.dataset.theme = theme.id;
}

export function saveTheme(theme: ThemePalette): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {
    // 浏览器禁止本地存储时只是记不住选择，不影响使用
  }
}

export function nextTheme(current: ThemePalette): ThemePalette {
  return THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
}
