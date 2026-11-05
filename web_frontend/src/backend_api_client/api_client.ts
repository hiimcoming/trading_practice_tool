// 和后端通信的唯一出口（CLAUDE.md 架构铁律 1）：所有接口地址只写在这里，别处不写死地址。
// 后端出错时统一抛 ApiError，message 是后端给的中文原因，status 是 HTTP 状态码，extra 是附带信息（如 lease_lost）。
// K 线的紧凑格式：[开盘时刻(UTC 秒), 开, 高, 低, 收]，这里统一换成毫秒的对象。

import type { Bar, Bar1m, DayAnchor, Timeframe } from '../trading_rules/kline_synthesis';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive,
    });
  } catch {
    throw new ApiError('连不上后端（网络断了或后端没有运行）', 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const { message, ...extra } = detail as { message?: string };
      throw new ApiError(message ?? `请求失败（HTTP ${res.status}）`, res.status, extra);
    }
    const msg = typeof detail === 'string' ? detail : Array.isArray(detail) ? '输入格式不对' : `请求失败（HTTP ${res.status}）`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

const enc = encodeURIComponent;
type CompactBar = [number, number, number, number, number];

export function toBars1m(rows: CompactBar[]): Bar1m[] {
  return rows.map(([t, o, h, l, c]) => ({ t: t * 1000, o, h, l, c }));
}
export function toBars(rows: CompactBar[]): Bar[] {
  return rows.map(([t, o, h, l, c]) => ({ t: t * 1000, o, h, l, c, minuteCount: 0 }));
}

// ---------------- 类型 ----------------

/** 金额的货币写法（D72）：Exness 账户是美元，币安 U 本位账户是 USDT */
export type Currency = '$' | 'USDT';

export interface MarketSpec {
  display_name: string;
  platform: 'exness' | 'binance';
  tick_size: number;
  price_precision: number;
  day_anchor: DayAnchor;
  /** 下单数量的单位：Exness「手」，币安为币名（BTC、ETH） */
  qty_unit?: string;
  [key: string]: unknown;
}

export interface RecentUser {
  username: string;
  display_name: string;
  last_practice_at: string | null;
  completed_rounds: number;
  total_trades: number;
  winning_trades: number;
  win_rate: number | null;
  avg_round_return: number | null;
  median_round_return: number | null;
  profitable_round_ratio: number | null;
  avg_r: number | null;
  last10_returns: number[];
}

export interface SessionRow {
  id: string;
  symbol: string;
  start_timeframe: Timeframe;
  day_anchor: DayAnchor;
  background_bars: number;
  segment_start_ms: number;
  replay_ms: number;
  bars_played: number;
  timeframes_used: Timeframe[];
  status: 'active' | 'completed';
  end_reason: string | null;
  is_replay: number;
  pick_mode: string | null;
  state: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  /** 开局时的总资产（交易账户 + 资金账户）；第 4 阶段之前开的轮次为 null */
  initial_total_assets: number | null;
  /** 结束时的总资产 */
  final_total_assets?: number | null;
  /** 历史列表才有：交易笔数、单轮简报的状态（没有简报为 null） */
  trade_count?: number;
  report_status?: ReportState | null;
  /** 历史列表才有：该品种已完成的第几轮（与统计页、简报一致，D77）；进行中为 null */
  round_no?: number | null;
}

export type ReportState = 'none' | 'queued' | 'running' | 'done' | 'failed' | 'unavailable';

/** 单轮简报里的一笔交易（服务器复算的结果，规格书 7.1 节） */
export interface BriefTrade {
  no: number;
  position_id: number;
  direction: number;
  qty: number;
  source: string;
  open_ms: number;
  close_ms: number;
  entry_price: number;
  exit_price: number;
  initial_sl: number | null;
  sl_at_close: number | null;
  tp_at_close: number | null;
  close_reason: string;
  exits: number;
  pnl: number;
  cost: number;
  r: number | null;
  /** 决策用时（毫秒）；第 5b 之前的轮次没有记录 */
  decision_ms?: number | null;
}

/** 单轮简报（后端 practice_reports/performance_reports.py 生成） */
export interface RoundBrief {
  reveal: { symbol: string; start_timeframe: Timeframe; start_utc: string; end_utc: string; days: number; bars_played: number; end_reason: string; real_minutes: number | null };
  equity: { points: Array<[number, number, number]>; initial_total: number | null; final_total: number; max_drawdown: number; max_drawdown_pct: number };
  basics: {
    trades: number; wins: number; losses: number; net_pnl: number; spread_cost: number; slippage_cost: number; fees: number; cost_total: number;
    liquidations: number; transfers: Array<{ ms: number; direction: string; amount: number }>;
  };
  violations: Array<{ no: number; position_id: number; kind: string; ms: number; text: string }>;
  trades: BriefTrade[];
  check: { consistent: boolean; differences: string[] };
  /** 第 5b 阶段：该品种的第几轮（简报页在 5 的倍数轮提示去看统计） */
  round_no?: number | null;
}

/** 纪律审查表里的一行：笔数、占比、这一组的胜率和平均 R（第 5b 阶段） */
export interface ReviewRow {
  label: string;
  count: number;
  share: number | null;
  win_rate: number | null;
  avg_r: number | null;
  times?: number;
  median_minutes?: number | null;
  compare?: ReviewRow;
}

/** 一种犯错行为（D75 统计页第一层卡片）：犯了的那组 vs 对照组 */
export interface ReviewBehavior {
  key: string;
  label: string;
  bad: ReviewRow;
  good: ReviewRow;
  good_label: string;
  times?: number;
  note?: string;
  note_count?: number;
}

export type StatsRange = 'last5' | 'last10' | 'days30' | 'all' | 'custom';
/** 范围参数：custom 时带起止日期（YYYY-MM-DD，含首尾两天） */
export interface RangeChoice {
  range: StatsRange;
  start?: string;
  end?: string;
}
const rangeQuery = (c: RangeChoice) => `range=${c.range}${c.range === 'custom' ? `&start=${enc(c.start ?? '')}&end=${enc(c.end ?? '')}` : ''}`;

/** 统计与审查页（后端 website_server/review_statistics.py，D68） */
export interface StatisticsPage {
  symbol: string;
  rounds_total: number;
  range: StatsRange;
  range_label: string;
  /** 自定义日期范围的起止（YYYY-MM-DD，按用户的显示时区）；其他范围为 null（第 5b-2 阶段，D71） */
  range_start: string | null;
  range_end: string | null;
  range_rounds: number[];
  /** 标题用（D72）：所选范围是第几轮到第几轮、练习日期起止（用户时区）、跨了几天（首尾都算） */
  range_summary: { first_round: number; last_round: number; rounds: number; from_date: string | null; to_date: string | null; days: number | null } | null;
  /** 金额的货币写法：'$'（Exness）或 'USDT'（币安） */
  currency: Currency;
  progress: { rolling_trades: number; points: Array<{ round_no: number; session_id: string; sample_small: boolean; [k: string]: unknown }> };
  /** 每 5 轮一组的对比（D71）：全部轮次，不受范围影响 */
  group_size: number;
  groups: Array<{ first: number; last: number; round_nos: number[]; complete: boolean; trades: number; win_rate: number | null;
    payoff_ratio: number | null; profit_factor: number | null; disciplined_share: number | null; violations: number; net_pnl: number }>;
  stats: Record<string, unknown> & {
    periods: Array<{ round_no: number; start_utc: string; end_utc: string }>;
    cum_pnl: number[];
    round_marks: Array<{ index: number; round_no: number }>;
    worst_round_drawdown: { round_no: number; pct: number } | null;
    longest_win_streak: { count: number; amount: number };
    longest_loss_streak: { count: number; amount: number };
    /** D73（照 MT4）：金额最大的连赢 / 连亏段、平均每段几笔、绝对回撤 */
    max_win_streak_amount: { count: number; amount: number };
    max_loss_streak_amount: { count: number; amount: number };
  };
  review: {
    trades: number;
    overall_win_rate: number | null;
    sample_small: boolean;
    /** 少于这么多笔的组不下结论（灰色、不标红绿），与问题提示同一个阈值 */
    min_samples: number;
    behaviors: ReviewBehavior[];
    /** 市价 vs 挂单（限价 + 止损挂单合并） */
    entry_compare: ReviewRow[];
    stops: ReviewRow[];
    after_stop: { gaps: ReviewRow[]; quick_reentry: ReviewRow; size_up_after_loss: ReviewRow };
    loss_streaks: {
      count: number;
      longest: number;
      items: Array<{ round_no: number; session_id: string; count: number; nos: number[]; position_ids: number[]; start_ms: number; end_ms: number;
        span_bars: number; gaps_bars: number[];
        size_up: boolean; total_pnl: number; total_r: number | null; sessions: string[] }>;
    };
    entry_types: ReviewRow[];
    frequency: { trades_per_100_bars: number | null; busiest: ReviewRow | null; others: ReviewRow | null };
    plan: { with_plan: number; planned_r_avg: number | null; actual_r_avg: number | null; cut_winners: ReviewRow };
    holding: { win_bars: number | null; loss_bars: number | null };
    sessions: ReviewRow[];
    directions: ReviewRow[];
    risk: {
      leverage_buckets: ReviewRow[]; stop_risk_buckets: ReviewRow[]; heavy: ReviewRow; not_heavy: ReviewRow; passive: ReviewRow;
      stop_pct: { min: number; q1: number; median: number; q3: number; max: number; count: number } | null;
      stop_pct_by_round: Array<{ round_no: number; median: number | null }>;
      planned_vs_actual_stop: { count: number; planned_avg: number | null; actual_avg: number | null };
      max_leverage: { value: number; round_no: number; no: number; ms: number } | null;
      avg_leverage_holding: number | null; holding_time_share: number | null; min_liq_distance: number | null;
      max_stop_risk: number | null; stop_unlimited_trades: number;
    };
    decision: ReviewRow[];
  };
  hints: string[];
  violation_kinds: Record<string, string>;
}

/** 简报的进度和结果：step 1–3 = 进行到第几步，4 = 完成 */
export interface ReportStatus {
  status: ReportState;
  step?: number;
  steps?: string[];
  queue_ahead?: number;
  error?: string;
  report?: RoundBrief;
  /** 这一轮哪天练完的（YYYY-MM-DD，按用户的显示时区；D72 简报标题用） */
  practice_date?: string | null;
}

export interface SessionPayload {
  lease_token: string;
  session: SessionRow;
  market: MarketSpec;
  background_bars: CompactBar[];
  past_1m: CompactBar[];
  future_1m: CompactBar[];
  future_reached_data_end: boolean;
  completion_bars: number;
  /** 这一轮的画线（画线库 B 导出的 JSON 列表，第 4b 阶段）；没画过为空列表 */
  drawings: unknown[];
}

export interface FinishResult {
  result: 'completed' | 'discarded';
  bars_played: number;
  end_reason?: string;
  reveal?: { start_utc: string; end_utc: string };
  /** 完成的轮次：简报已排队（或不能生成的原因） */
  report?: ReportStatus;
}

export interface ReplayEvent {
  type: string;
  replay_ms: number;
  payload?: Record<string, unknown>;
}

// ---------------- 接口 ----------------

export const api = {
  markets: () => request<{ markets: Record<string, MarketSpec> }>('GET', '/api/markets'),
  dataStatus: () => request<{ symbols: Record<string, DataStatus> }>('GET', '/api/data/status'),
  practiceCapacity: (symbol: string, timeframe: Timeframe, backgroundBars: number) =>
    request<PracticeCapacity>(
      'GET',
      `/api/data/practice_capacity?symbol=${enc(symbol)}&timeframe=${enc(timeframe)}&background_bars=${backgroundBars}`,
    ),
  enterUser: (username: string) =>
    request<{ username: string; display_name: string; is_new: boolean }>('POST', '/api/users', { username }),
  recentUsers: (symbol: string) =>
    request<{ symbol: string; users: RecentUser[]; few_trades_threshold: number }>('GET', `/api/users?symbol=${enc(symbol)}`),
  user: (name: string) =>
    request<{ username: string; display_name: string; active_session: SessionRow | null; settings: Record<string, unknown> }>(
      'GET',
      `/api/users/${enc(name)}`,
    ),
  saveSettings: (name: string, values: Record<string, unknown>) =>
    request<{ settings: Record<string, unknown> }>('PUT', `/api/users/${enc(name)}/settings`, values),
  clearHistory: (name: string, confirmUsername: string) =>
    request<{ cleared: boolean }>('DELETE', `/api/users/${enc(name)}/history`, { confirm_username: confirmUsername }),
  sessions: (name: string) => request<{ sessions: SessionRow[] }>('GET', `/api/users/${enc(name)}/sessions`),
  newSession: (
    name: string,
    body: {
      symbol: string;
      start_timeframe: Timeframe;
      background_bars?: number;
      leverage?: number;
      trading_balance?: number;
      funding_balance?: number;
    },
  ) =>
    request<SessionPayload & { session_id: string }>('POST', `/api/users/${enc(name)}/sessions`, body),
  claimSession: (name: string, id: string) => request<SessionPayload>('POST', `/api/users/${enc(name)}/sessions/${enc(id)}/claim`),
  historyBars: async (name: string, id: string, timeframe: Timeframe, endMs: number, count: number) => {
    const r = await request<{ bars: CompactBar[] }>(
      'GET',
      `/api/users/${enc(name)}/sessions/${enc(id)}/history_bars?timeframe=${timeframe}&end_ms=${endMs}&count=${count}`,
    );
    return toBars(r.bars);
  },
  future1m: async (name: string, id: string, fromMs: number) => {
    const r = await request<{ future_1m: CompactBar[]; future_reached_data_end: boolean }>(
      'GET',
      `/api/users/${enc(name)}/sessions/${enc(id)}/future?from_ms=${fromMs}`,
    );
    return { bars: toBars1m(r.future_1m), reachedDataEnd: r.future_reached_data_end };
  },
  saveState: (
    name: string,
    id: string,
    body: {
      lease_token: string;
      replay_ms: number;
      timeframes_used: Timeframe[];
      state: Record<string, unknown>;
      events: ReplayEvent[];
      /** 画线有改动时才送（整份 JSON 列表的文字）；不送 = 画线没变 */
      drawings?: string;
    },
    keepalive = false,
  ) => request<{ bars_played: number }>('POST', `/api/users/${enc(name)}/sessions/${enc(id)}/state`, body, keepalive),
  report: (name: string, id: string) => request<ReportStatus>('GET', `/api/users/${enc(name)}/sessions/${enc(id)}/report`),
  statistics: (name: string, symbol: string, range: RangeChoice) =>
    request<StatisticsPage>('GET', `/api/users/${enc(name)}/statistics?symbol=${enc(symbol)}&${rangeQuery(range)}`),
  /** 「下载我的数据」的下载地址（第 5c 阶段，D70）：浏览器直接打开即保存为 .md 文件 */
  exportUrl: (name: string, symbol: string, range: RangeChoice) =>
    `/api/users/${enc(name)}/export?symbol=${enc(symbol)}&${rangeQuery(range)}`,
  requestReport: (name: string, id: string) => request<ReportStatus>('POST', `/api/users/${enc(name)}/sessions/${enc(id)}/report`),
  finish: (name: string, id: string, body: { lease_token: string; replay_ms: number; reason: 'normal' | 'latest_data' | 'liquidation' }) =>
    request<FinishResult>('POST', `/api/users/${enc(name)}/sessions/${enc(id)}/finish`, body),
};

/** 可抽数据的月数与约可练几轮不重复（D86：用户页开局前显示） */
export interface PracticeCapacity {
  symbol: string;
  timeframe: Timeframe;
  background_bars: number;
  months: number;
  first_month: string | null;
  last_month: string | null;
  /** 首尾月份之间缺的月份（下载失败或没有数据） */
  missing_months: string[];
  /** 按当前周期和背景根数，最多能放几个互不重叠的片段 */
  rounds: number;
}

export interface DataStatus {
  data_source: string;
  platform: string;
  first_bar_utc: string | null;
  last_bar_utc: string | null;
  months_ok: number;
  total_rows_1m: number;
  updated_at_utc: string | null;
  months: Record<string, { status: string; rows: number; warnings: string[] }>;
}
