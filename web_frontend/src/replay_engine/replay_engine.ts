// 回放引擎（规格书 5.4、5.5 节）：只管数据，不碰画面，便于单独测试「不偷看未来」。
//
// 概念：
//   · 回放时刻 replayMs：开盘早于它的 1m 都已「揭开」（不含它）。一根 1m 揭开后 replayMs = 它的开盘 + 1 分钟。
//   · 每个已用过的周期各有：已收盘 K 线 closed（来自服务器 + 回放中陆续收盘的）+ 正在形成的半根 partial（由已揭开的 1m 现场合成）。
//   · 未来 1m 放在缓冲区，只在「下一根」「下一分钟」或自动播放时逐根揭开；剩余不足约 30% 时在后台预取下一段。
//   · 浏览器只保留最近几天的 1m（至少覆盖当前日线这一根），更早的只保留各周期已收盘的 K 线。
//   · 已走根数：起点之后、收盘时刻（开盘 + 周期）不晚于 replayMs 的起始周期 K 线根数——与服务器的算法相同。
//   · onReveal：每揭开一根 1m 就按顺序通知一次（交易账户逐根 1m 判断成交和强平用，第 4 阶段）。

import {
  MINUTE_MS,
  TIMEFRAME_MS,
  bucketOpenMs,
  mergeIntoLast,
  nyWallMs,
  nyWallToUtc,
  type Bar,
  type Bar1m,
  type DayAnchor,
  type Timeframe,
  type WeekStart,
} from '../trading_rules/kline_synthesis';

export interface ReplayInit {
  startMs: number;
  replayMs: number;
  startTimeframe: Timeframe;
  dayAnchor: DayAnchor;
  /** 周线从星期几开始（品种档案 week_start，D74）；不填按周一 */
  weekStart?: WeekStart;
  /** 起始周期在起点之前已收盘的背景 K 线 */
  background: Bar[];
  /** 回放时刻之前、当前周线开盘以来的 1m（切到大周期时合成半根用；D74 起从周线开盘起，以前是日线开盘） */
  past1m: Bar1m[];
  /** 回放时刻之后的 1m（未来） */
  future1m: Bar1m[];
  futureReachedDataEnd: boolean;
  /** 服务器记录的、截至 replayMs 已走完的起始周期根数（断点续练时浏览器只有最近一天的 1m，靠它补上更早的部分） */
  barsPlayedAtInit: number;
  prefetchWhenRemainingRatio: number;
  keep1mDays: number;
}

/** 取数据的方法由外部提供（正式用后端接口，测试用假数据） */
export interface ReplayDataSource {
  /** 某周期在 endMs 之前已收盘的最后 count 根 */
  historyBars(timeframe: Timeframe, endMs: number, count: number): Promise<Bar[]>;
  /** 从 fromMs 起的下一段 1m */
  future1m(fromMs: number): Promise<{ bars: Bar1m[]; reachedDataEnd: boolean }>;
}

export type StepResult = 'ok' | 'waiting_for_data' | 'data_end';

interface TimeframeState {
  closed: Bar[];
  partial: Bar | null;
  /** closed 里最早一根之前是否还有更早的历史可以加载 */
  moreHistory: boolean;
}

const DAY_MS = TIMEFRAME_MS['1d'];

export class ReplayEngine {
  readonly startMs: number;
  readonly startTimeframe: Timeframe;
  readonly dayAnchor: DayAnchor;
  readonly weekStart: WeekStart;
  private replayMsValue: number;
  private revealed1m: Bar1m[];
  private future: Bar1m[];
  private futureChunkSize: number;
  private futureReachedEnd: boolean;
  private fetching: Promise<void> | null = null;
  private readonly frames = new Map<Timeframe, TimeframeState>();
  /** 起点之后出现过的起始周期 K 线开盘时刻（计算已走根数用） */
  private readonly startTfOpens: number[] = [];
  private readonly prefetchRatio: number;
  private readonly keep1mMs: number;
  private readonly barsPlayedBase: number;
  private readonly closedAtInit: number;
  /** 每揭开一根 1m 调用一次（按时间顺序；「下一根」一次可能揭开多根） */
  onReveal: ((b: Bar1m) => void) | null = null;

  constructor(
    init: ReplayInit,
    private readonly source: ReplayDataSource,
  ) {
    this.startMs = init.startMs;
    this.startTimeframe = init.startTimeframe;
    this.dayAnchor = init.dayAnchor;
    this.weekStart = init.weekStart ?? 'monday';
    this.replayMsValue = init.replayMs;
    this.revealed1m = init.past1m.filter((b) => b.t < init.replayMs);
    this.future = init.future1m.filter((b) => b.t >= init.replayMs);
    this.futureChunkSize = Math.max(1, init.future1m.length);
    this.futureReachedEnd = init.futureReachedDataEnd;
    this.prefetchRatio = init.prefetchWhenRemainingRatio;
    this.keep1mMs = Math.max(1, init.keep1mDays) * DAY_MS;
    for (const b of this.revealed1m) this.noteStartTfOpen(b);
    this.barsPlayedBase = init.barsPlayedAtInit;
    this.closedAtInit = this.countClosedStartTfBars();
    // 起始周期：背景 K 线就是已收盘的历史；断点续练时把起点之后的部分由已揭开的 1m 补上
    this.frames.set(init.startTimeframe, this.buildFrame(init.startTimeframe, init.background));
  }

  get replayMs(): number {
    return this.replayMsValue;
  }

  /** 最后一根已揭开的 1m（没有则为 null） */
  last1m(): Bar1m | null {
    return this.revealed1m[this.revealed1m.length - 1] ?? null;
  }

  hasTimeframe(tf: Timeframe): boolean {
    return this.frames.has(tf);
  }

  /** 第一次用到某周期时调用：向数据源要截至当前这根之前的已收盘 K 线 */
  async loadTimeframe(tf: Timeframe, count: number): Promise<void> {
    if (this.frames.has(tf)) return;
    const end = this.currentBucketOpen(tf);
    const closed = await this.source.historyBars(tf, end, count);
    if (!this.frames.has(tf)) this.frames.set(tf, this.buildFrame(tf, closed));
  }

  /** 往左拖到头时加载更早的历史；返回新加载的根数 */
  async loadEarlier(tf: Timeframe, count: number): Promise<number> {
    const st = this.frames.get(tf);
    if (!st || !st.moreHistory || st.closed.length === 0) return 0;
    const earlier = await this.source.historyBars(tf, st.closed[0].t, count);
    const fresh = earlier.filter((b) => b.t < st.closed[0].t);
    st.closed = [...fresh, ...st.closed];
    if (fresh.length < count) st.moreHistory = false;
    return fresh.length;
  }

  /** 已预取、还没揭开的 1m 有几根（预取补上新的一段后会变，外面用来判断缓存是否过期） */
  futureCount(): number {
    return this.future.length;
  }

  /** 已预取、还没揭开的 1m 在某周期上会形成的 K 线开盘时刻（升序，只取开盘晚于 afterMs 的；D74 画线未来区对齐用） */
  futureBarOpens(tf: Timeframe, afterMs: number): number[] {
    const out: number[] = [];
    for (const b of this.future) {
      const t = bucketOpenMs(b.t, tf, this.dayAnchor, this.weekStart);
      if (t > afterMs && t !== out[out.length - 1]) out.push(t);
    }
    return out;
  }

  /** 某周期往左还有没有更早的历史可加载（没有 = 已到数据起点，D74 用来提示） */
  hasMoreHistory(tf: Timeframe): boolean {
    return this.frames.get(tf)?.moreHistory ?? true;
  }

  /** 某周期当前应显示的全部 K 线（已收盘 + 正在形成的半根） */
  bars(tf: Timeframe): Bar[] {
    const st = this.frames.get(tf);
    if (!st) return [];
    return st.partial ? [...st.closed, st.partial] : st.closed.slice();
  }

  /** 某周期已收盘的 K 线（不含正在形成的半根；算 ATR 用，规格书 6.7 节「只用已收盘的 K 线」） */
  closedBars(tf: Timeframe): Bar[] {
    return this.frames.get(tf)?.closed ?? [];
  }

  /** 某周期最后一根（推进后增量更新图表用） */
  lastBar(tf: Timeframe): Bar | null {
    const st = this.frames.get(tf);
    if (!st) return null;
    return st.partial ?? st.closed[st.closed.length - 1] ?? null;
  }

  /**
   * 已走完的起始周期 K 线根数（与服务器 bars_completed 同一算法）：
   * 服务器给的初始值 + 打开页面之后新收盘的根数。
   */
  barsPlayed(): number {
    return this.barsPlayedBase + this.countClosedStartTfBars() - this.closedAtInit;
  }

  private countClosedStartTfBars(): number {
    const tf = TIMEFRAME_MS[this.startTimeframe];
    let n = 0;
    for (const open of this.startTfOpens) if (open + tf <= this.replayMsValue) n++;
    return n;
  }

  futureRemaining(): number {
    return this.future.length;
  }

  isAtDataEnd(): boolean {
    return this.future.length === 0 && this.futureReachedEnd;
  }

  /** 揭开下一根 1m（「下一分钟」） */
  step1m(): StepResult {
    const next = this.future.shift();
    if (!next) {
      this.maybePrefetch();
      return this.futureReachedEnd ? 'data_end' : 'waiting_for_data';
    }
    this.reveal(next);
    this.maybePrefetch();
    return 'ok';
  }

  /**
   * 「下一根」：当前周期走完一根。最后一根还是半根 → 补完它；已经完整（下一根 1m 属于新的一根）→ 揭开新的一根并补完。
   * 是否「补完」要看下一根 1m 是否已属于新的一根，所以会看一眼缓冲区里的下一根 1m 的时刻（只看时刻、不显示）。
   */
  stepBar(tf: Timeframe): StepResult {
    const bucket = (b: Bar1m) => bucketOpenMs(b.t, tf, this.dayAnchor, this.weekStart);
    const last = this.last1m();
    if (this.future.length === 0) return this.step1m();
    if (!last || bucket(this.future[0]) !== bucket(last)) {
      const r = this.step1m();
      if (r !== 'ok') return r;
    }
    while (this.future.length > 0 && bucket(this.future[0]) === bucket(this.last1m()!)) {
      this.reveal(this.future.shift()!);
    }
    this.maybePrefetch();
    if (this.future.length === 0 && !this.futureReachedEnd) return 'waiting_for_data';
    return 'ok';
  }

  /** 等待正在进行的预取（「等待数据」时调用） */
  async waitForPrefetch(): Promise<void> {
    this.maybePrefetch();
    if (this.fetching) await this.fetching;
  }

  // ---------------- 内部 ----------------

  private reveal(b: Bar1m): void {
    this.revealed1m.push(b);
    this.replayMsValue = b.t + MINUTE_MS;
    this.noteStartTfOpen(b);
    this.onReveal?.(b);
    for (const [tf, st] of this.frames) {
      const merged = mergeIntoLast(st.partial, b, tf, this.dayAnchor, this.weekStart);
      if (st.partial && merged.t !== st.partial.t) st.closed.push(st.partial);
      st.partial = merged;
    }
    this.trim1m();
  }

  private noteStartTfOpen(b: Bar1m): void {
    if (b.t < this.startMs) return;
    const open = bucketOpenMs(b.t, this.startTimeframe, this.dayAnchor, this.weekStart);
    if (this.startTfOpens[this.startTfOpens.length - 1] !== open) this.startTfOpens.push(open);
  }

  /** 当前（最后一根已揭开 1m 所在的）某周期 K 线的开盘时刻；还没有 1m 时用回放时刻 */
  private currentBucketOpen(tf: Timeframe): number {
    const last = this.last1m();
    return bucketOpenMs(last ? last.t : this.replayMsValue, tf, this.dayAnchor, this.weekStart);
  }

  /** 由服务器给的已收盘 K 线 + 已揭开的 1m（当前这根及之后的部分）组成一个周期的状态 */
  private buildFrame(tf: Timeframe, serverClosed: Bar[]): TimeframeState {
    const lastServer = serverClosed[serverClosed.length - 1];
    const after = this.revealed1m.filter((b) => !lastServer || bucketOpenMs(b.t, tf, this.dayAnchor, this.weekStart) > lastServer.t);
    const st: TimeframeState = { closed: serverClosed.slice(), partial: null, moreHistory: serverClosed.length > 0 };
    for (const b of after) {
      const merged = mergeIntoLast(st.partial, b, tf, this.dayAnchor, this.weekStart);
      if (st.partial && merged.t !== st.partial.t) st.closed.push(st.partial);
      st.partial = merged;
    }
    return st;
  }

  /** 只保留最近几天的 1m，且至少覆盖当前日线和当前周线这一根（切到大周期时要用它合成半根；周线 D74，最多约 1 万根） */
  private trim1m(): void {
    const last = this.last1m();
    if (!last || this.revealed1m.length < 4000) return;
    const keepFrom = Math.min(last.t - this.keep1mMs, bucketOpenMs(last.t, '1d', this.dayAnchor),
      bucketOpenMs(last.t, '1w', this.dayAnchor, this.weekStart));
    let cut = 0;
    while (cut < this.revealed1m.length && this.revealed1m[cut].t < keepFrom) cut++;
    if (cut > 0) this.revealed1m = this.revealed1m.slice(cut);
  }

  private maybePrefetch(): void {
    if (this.fetching || this.futureReachedEnd) return;
    if (this.future.length > this.futureChunkSize * this.prefetchRatio) return;
    const tail = this.future[this.future.length - 1] ?? this.last1m();
    const from = tail ? tail.t + MINUTE_MS : this.replayMsValue;
    this.fetching = this.source
      .future1m(from)
      .then(({ bars, reachedDataEnd }) => {
        const lastKnown = this.future[this.future.length - 1]?.t ?? this.last1m()?.t ?? -Infinity;
        this.future.push(...bars.filter((b) => b.t > lastKnown));
        this.futureReachedEnd = reachedDataEnd;
        if (bars.length > 0) this.futureChunkSize = Math.max(this.futureChunkSize, bars.length);
      })
      .finally(() => {
        this.fetching = null;
      });
  }
}

// ---------------- 已练交易日（D84） ----------------
// 按行情时间估算：从本轮起点到回放时刻，逐个 UTC 日累加重叠的时长（一天 = 1）。周末休市的品种（黄金，skip_saturday）
// 跳过整个周六、周日；节假日停盘不扣除，所以是估算。只用起点和回放时刻两个数，断点续练、切周期、盲练下都不变。

/** 已过的交易日数（可带小数）；weekendClosed = 周末休市（黄金） */
export function elapsedTradingDays(startMs: number, endMs: number, weekendClosed: boolean): number {
  let total = 0;
  for (let day = Math.floor(startMs / DAY_MS); day * DAY_MS < endMs; day++) {
    const weekday = (day + 4) % 7; // 1970-01-01 是星期四；0 = 周日，6 = 周六
    if (weekendClosed && (weekday === 0 || weekday === 6)) continue;
    total += Math.max(0, Math.min(endMs, (day + 1) * DAY_MS) - Math.max(startMs, day * DAY_MS));
  }
  return total / DAY_MS;
}

/** 顶栏文字：「已过 2.4 个交易日」，满一周加「（约 1.5 周）」；一周 = 黄金 5 个交易日、币安 7 天 */
export function tradingDaysLabel(days: number, weekendClosed: boolean): string {
  const perWeek = weekendClosed ? 5 : 7;
  const text = `已过 ${days.toFixed(1)} 个交易日`;
  return days >= perWeek ? `${text}（约 ${(days / perWeek).toFixed(1)} 周）` : text;
}

// ---------------- 周五收盘倒计时（D85） ----------------
// 黄金每周五纽约时间 17:00 收盘（夏令时 UTC 21:00、冬令时 UTC 22:00；2015 年以来数据核对过）。按固定时间表算，
// 不读后面的数据，不算偷看未来；节假日提前收盘（复活节、圣诞等，约 5% 的周）算不准，已知局限。

/** 收盘前多久开始显示倒计时 */
export const WEEKEND_COUNTDOWN_MS = 4 * 3600_000;

/** 回放时刻之后（含此刻）最近的一次周五纽约 17:00 收盘（UTC 毫秒） */
export function nextWeekendCloseMs(replayMs: number): number {
  const wall = nyWallMs(replayMs);
  const day = Math.floor(wall / DAY_MS);
  const weekday = (day + 4) % 7; // 1970-01-01 是星期四；5 = 周五
  let closeWall = (day + ((5 - weekday + 7) % 7)) * DAY_MS + 17 * 3600_000;
  if (closeWall < wall) closeWall += 7 * DAY_MS;
  return nyWallToUtc(closeWall);
}

/** 左上角的倒计时文字；不在收盘前 4 小时内返回 null。replayMs = 已揭开的最后一根 1m 收盘时刻 */
export function weekendCountdownLabel(replayMs: number): string | null {
  const left = nextWeekendCloseMs(replayMs) - replayMs;
  if (left > WEEKEND_COUNTDOWN_MS) return null;
  if (left <= 0) return '已到周末收盘';
  const minutes = Math.ceil(left / 60_000);
  return `距周末收盘 ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}
