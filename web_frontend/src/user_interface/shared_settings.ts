// 前后端共用的默认设置（唯一真本：common_settings/default_settings.json，CLAUDE.md 架构铁律 2），以及用户设置的读取。
import defaults from '../../../common_settings/default_settings.json';
import type { Timeframe } from '../trading_rules/kline_synthesis';

export const DEFAULTS = defaults;

/** 用户设置（存在服务器上，按用户；规格书 5.1 节）。缺的项用默认值补上 */
export interface UserSettings {
  last_symbol: string;
  last_start_timeframe: Timeframe;
  /** 每个起始周期上次用的背景根数（D86：按周期分别记住；没记过的用 default_settings.json 里该周期的默认值） */
  background_bars_by_timeframe: Partial<Record<Timeframe, number>>;
  theme: string;
  utc_offset_hours: 0 | 8;
  blind_mode: boolean;
  autoplay_seconds: number;
  /** 每个品种上次用的杠杆（规格书 5.1 节：默认用上次的选择） */
  leverage_by_symbol: Record<string, number>;
  trading_balance: number;
  funding_balance: number;
  /** 图上显示开仓、平仓箭头和连线（D57） */
  show_trade_markers: boolean;
  /** Exness 品种图上显示买价线（规格书 5.8 节） */
  show_ask_line: boolean;
  /** 每类画线工具最后一次用的样式（D64：新画的线沿用）；格式由 drawing_toolbar.ts 解释 */
  drawing_styles: Record<string, unknown>;
  /** 下单后自动走一根（D76：顶栏勾选，默认不勾 = 市价单排队，按「下一根」才成交） */
  auto_step_after_market: boolean;
}

export function withDefaults(raw: Record<string, unknown>): UserSettings {
  const d = DEFAULTS;
  return {
    last_symbol: (raw.last_symbol as string) ?? d.practice_start.default_symbol,
    last_start_timeframe: ((raw.last_start_timeframe as string) ?? d.practice_start.default_start_timeframe) as Timeframe,
    // 旧版只存一个 background_bars（各周期共用）：D86 起不再沿用，免得大周期也一直是 400 根
    background_bars_by_timeframe: (raw.background_bars_by_timeframe as Partial<Record<Timeframe, number>>) ?? {},
    theme: (raw.theme as string) ?? d.display.default_theme,
    utc_offset_hours: raw.utc_offset_hours === 8 ? 8 : 0,
    blind_mode: (raw.blind_mode as boolean) ?? d.display.blind_mode_default,
    autoplay_seconds: (raw.autoplay_seconds as number) ?? d.replay.autoplay_seconds_default,
    leverage_by_symbol: (raw.leverage_by_symbol as Record<string, number>) ?? {},
    trading_balance: (raw.trading_balance as number) ?? d.practice_start.account.trading_balance,
    funding_balance: (raw.funding_balance as number) ?? d.practice_start.account.funding_balance,
    show_trade_markers: (raw.show_trade_markers as boolean) ?? d.display.show_trade_markers,
    show_ask_line: (raw.show_ask_line as boolean) ?? d.display.show_ask_line,
    drawing_styles: (raw.drawing_styles as Record<string, unknown>) ?? {},
    auto_step_after_market: (raw.auto_step_after_market as boolean) ?? d.replay.auto_step_after_market_default,
  };
}

/** 某起始周期的背景根数：用户记过的优先，否则用该周期的默认值（D86：4h、1d 默认 50 根，其余 400 根） */
export function backgroundBarsFor(settings: UserSettings, tf: Timeframe): number {
  const cfg = DEFAULTS.practice_start.background_bars;
  const byTf = cfg.by_timeframe as Partial<Record<Timeframe, number>>;
  return settings.background_bars_by_timeframe[tf] ?? byTf[tf] ?? cfg.default;
}

/** 只存在当前浏览器里的小东西（面板展开状态和尺寸、上次的用户名）；读写失败不影响使用 */
export const local = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`tpt.${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`tpt.${key}`, JSON.stringify(value));
    } catch {
      // 浏览器禁止本地存储时只是记不住，不影响使用
    }
  },
};
