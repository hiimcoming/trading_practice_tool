// K 线切分与合成（与后端 python_backend/trading_rules/kline_data.py 的 bucket_open_ms / synthesize 同一规则，
// 用 tests/cross_check_cases/kline_synthesis_cases.json 逐根对账）。
// 规则（规格书 3.4 节）：
//   · 1m、5m、15m、30m、1h：按 UTC 整点向下取整；
//   · 4h、1d 受「日线起点」影响：utc_0 = UTC 0 点起；ny_17 = 纽约 17:00 起（用浏览器自带的时区库处理夏令时），
//     4h 为纽约时间 17/21/1/5/9/13 点；秋季回拨那天凌晨 1 点出现两次，分桶起点取第一次（与 Python 一致）。
//   · 1w（D74）：从品种档案 week_start 那天的 UTC 0 点开始（monday = 周一，sunday = 周日），不受日线起点影响；
//   · 每根：开 = 第一根 1m 的开，高 = 最高，低 = 最低，收 = 最后一根 1m 的收，量 = 合计，minuteCount = 1m 根数。
// 时间单位：全部是 UTC 毫秒。

export const MINUTE_MS = 60_000;
export const TIMEFRAME_MS = {
  '1m': MINUTE_MS,
  '5m': 5 * MINUTE_MS,
  '15m': 15 * MINUTE_MS,
  '30m': 30 * MINUTE_MS,
  '1h': 60 * MINUTE_MS,
  '4h': 240 * MINUTE_MS,
  '1d': 1440 * MINUTE_MS,
  '1w': 7 * 1440 * MINUTE_MS,
} as const;
export type Timeframe = keyof typeof TIMEFRAME_MS;
export const TIMEFRAMES = Object.keys(TIMEFRAME_MS) as Timeframe[];
export type DayAnchor = 'utc_0' | 'ny_17';
/** 周线从星期几 UTC 0 点开始（品种档案 week_start，D74） */
export type WeekStart = 'monday' | 'sunday';
const DAY_MS = 1440 * MINUTE_MS;
/** 1970-01-01 是周四：到周一隔 3 天、到周日隔 4 天（与 Python 的 WEEK_STARTS 相同） */
const WEEK_SHIFT: Record<WeekStart, number> = { monday: 3, sunday: 4 };

/** 一根 1m：开盘时刻（UTC 毫秒）与开高低收 */
export interface Bar1m {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}
/** 合成后的 K 线 */
export interface Bar extends Bar1m {
  minuteCount: number;
}

const HOUR_MS = 60 * MINUTE_MS;
const NY_OFFSETS_MS = [-4 * HOUR_MS, -5 * HOUR_MS]; // 纽约夏令时 UTC−4、冬令时 UTC−5

const nyFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
});

/** UTC 时刻 → 纽约当地「钟表时间」（把钟表上的年月日时分当成 UTC 来存，便于做整日、整 4 小时的取整）。
 *  导出给回放引擎算周五收盘倒计时用（D85，只导出，规则不变） */
export function nyWallMs(utcMs: number): number {
  const p: Record<string, number> = {};
  for (const part of nyFormatter.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/** 纽约钟表时间 → UTC 时刻；同一钟表时间对应两个 UTC 时刻（秋季回拨）时取较早的那个 */
export function nyWallToUtc(wallMs: number): number {
  const candidates = NY_OFFSETS_MS.map((off) => wallMs - off).filter((utc) => nyWallMs(utc) === wallMs);
  if (candidates.length === 0) {
    throw new Error(`纽约时间 ${new Date(wallMs).toISOString()} 不存在（夏令时跳过的时段），不应作为分桶起点`);
  }
  return Math.min(...candidates);
}

// 同一小时内的 1m 一定落在同一根 4h / 日线里（分桶边界都是整点），按小时缓存，避免逐分钟调用时区库
const nyBucketCache = new Map<string, number>();

function ny17Bucket(utcMs: number, periodMs: number): number {
  const hourStart = utcMs - (utcMs % HOUR_MS);
  const key = `${periodMs}:${hourStart}`;
  const hit = nyBucketCache.get(key);
  if (hit !== undefined) return hit;
  const shifted = nyWallMs(hourStart) - 17 * HOUR_MS;
  const floored = shifted - (((shifted % periodMs) + periodMs) % periodMs);
  const start = nyWallToUtc(floored + 17 * HOUR_MS);
  if (nyBucketCache.size > 50_000) nyBucketCache.clear();
  nyBucketCache.set(key, start);
  return start;
}

/** 某根 1m 属于哪根大周期 K 线：返回那根的开盘时刻（UTC 毫秒） */
export function bucketOpenMs(tMs: number, timeframe: Timeframe, dayAnchor: DayAnchor, weekStart: WeekStart = 'monday'): number {
  const tf = TIMEFRAME_MS[timeframe];
  if (timeframe === '1w') {
    const days = Math.floor(tMs / DAY_MS);
    return (days - ((((days + WEEK_SHIFT[weekStart]) % 7) + 7) % 7)) * DAY_MS;
  }
  if (dayAnchor === 'utc_0' || (timeframe !== '4h' && timeframe !== '1d')) {
    return tMs - (((tMs % tf) + tf) % tf);
  }
  return ny17Bucket(tMs, tf);
}

/** 用 1m（按时间递增）合成指定周期；最后一根可能是正在形成的半根 */
export function synthesize(bars1m: readonly Bar1m[], timeframe: Timeframe, dayAnchor: DayAnchor, weekStart: WeekStart = 'monday'): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of bars1m) {
    const t = bucketOpenMs(b.t, timeframe, dayAnchor, weekStart);
    if (cur && cur.t === t) {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
      cur.minuteCount++;
    } else {
      cur = { t, o: b.o, h: b.h, l: b.l, c: b.c, minuteCount: 1 };
      out.push(cur);
    }
  }
  return out;
}

/** 增量合成：把一根新的 1m 并入「最后一根」，返回更新后或新开的那根（不改动传入的对象） */
export function mergeIntoLast(last: Bar | null, b: Bar1m, timeframe: Timeframe, dayAnchor: DayAnchor, weekStart: WeekStart = 'monday'): Bar {
  const t = bucketOpenMs(b.t, timeframe, dayAnchor, weekStart);
  if (last && last.t === t) {
    return { t, o: last.o, h: Math.max(last.h, b.h), l: Math.min(last.l, b.l), c: b.c, minuteCount: last.minuteCount + 1 };
  }
  return { t, o: b.o, h: b.h, l: b.l, c: b.c, minuteCount: 1 };
}
