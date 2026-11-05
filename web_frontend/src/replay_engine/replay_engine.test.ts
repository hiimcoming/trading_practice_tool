// 回放引擎测试：截断不变性（规格书 5.4 节验收 1）——推进到任意时刻 T，引擎给出的每个周期的 K 线，
// 必须和「数据只到 T」时现场合成的结果完全一致（含正在形成的半根）；以及已走根数、预取、数据终点。
// 数据为固定种子生成的黄金式假行情（每日休市、周末休市、零散缺分钟），数据源是按后端同样规则写的假接口。
import { describe, expect, it } from 'vitest';
import { MINUTE_MS, TIMEFRAMES, TIMEFRAME_MS, bucketOpenMs, synthesize, type Bar, type Bar1m, type Timeframe } from '../trading_rules/kline_synthesis';
import { ReplayEngine, elapsedTradingDays, nextWeekendCloseMs, tradingDaysLabel, weekendCountdownLabel, type ReplayDataSource } from './replay_engine';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** 2026-06-01 起 30 天的黄金式 1m（夏令时：UTC 21:00–22:00 每日休市，周五 21:00 至周日 22:00 周末休市） */
function makeData(seed: number): Bar1m[] {
  const r = rng(seed);
  const out: Bar1m[] = [];
  let price = 4000;
  const start = Date.UTC(2026, 5, 1);
  for (let t = start; t < start + 30 * TIMEFRAME_MS['1d']; t += MINUTE_MS) {
    const d = new Date(t);
    const wd = d.getUTCDay();
    const h = d.getUTCHours();
    if (h === 21 || (wd === 5 && h >= 21) || wd === 6 || (wd === 0 && h < 22)) continue;
    if (r() < 0.02) continue;
    const o = price;
    price = Math.round((price + (r() - 0.5) * 2) * 1000) / 1000;
    out.push({ t, o, h: Math.max(o, price) + 0.2, l: Math.min(o, price) - 0.2, c: price });
  }
  return out;
}

function fakeSource(all: Bar1m[], chunk: number, calls: { future: number }): ReplayDataSource {
  return {
    async historyBars(tf, endMs, count) {
      const tfMs = TIMEFRAME_MS[tf];
      return synthesize(all.filter((b) => b.t < endMs), tf, 'utc_0').filter((b) => b.t + tfMs <= endMs).slice(-count);
    },
    async future1m(fromMs) {
      calls.future++;
      const rest = all.filter((b) => b.t >= fromMs);
      return { bars: rest.slice(0, chunk), reachedDataEnd: rest.length <= chunk };
    },
  };
}

async function makeEngine(all: Bar1m[], startMs: number, chunk = 3 * 1380, calls = { future: 0 }) {
  const src = fakeSource(all, chunk, calls);
  // 与服务器相同（D74）：引子 1m 从当前周线开盘起（周线、日线的半根都要用它合成）
  const leadFrom = Math.min(bucketOpenMs(startMs, '1d', 'utc_0'), bucketOpenMs(startMs, '1w', 'utc_0'));
  const engine = new ReplayEngine(
    {
      startMs,
      replayMs: startMs,
      startTimeframe: '15m',
      dayAnchor: 'utc_0',
      background: await src.historyBars('15m', leadFrom, 400),
      past1m: all.filter((b) => b.t >= leadFrom && b.t < startMs),
      future1m: all.filter((b) => b.t >= startMs).slice(0, chunk),
      futureReachedDataEnd: false,
      barsPlayedAtInit: 0,
      prefetchWhenRemainingRatio: 0.3,
      keep1mDays: 3,
    },
    src,
  );
  return { engine, src, calls };
}

/** 「数据只到 T」时某周期应有的 K 线（取与引擎相同的时间窗口） */
function truth(all: Bar1m[], tf: Timeframe, replayMs: number, fromT: number): Bar[] {
  return synthesize(all.filter((b) => b.t < replayMs), tf, 'utc_0').filter((b) => b.t >= fromT);
}

describe('截断不变性：任意时刻的 K 线与「数据只到此刻」完全一致', () => {
  it('随机推进、随机切周期，100 个检查点', async () => {
    const all = makeData(7);
    const startMs = Date.UTC(2026, 5, 9, 10, 15);
    const { engine } = await makeEngine(all, startMs);
    const r = rng(99);
    let checks = 0;
    let compared = 0;
    for (let step = 0; step < 3000 && checks < 100; step++) {
      const tf = TIMEFRAMES[Math.floor(r() * TIMEFRAMES.length)];
      if (!engine.hasTimeframe(tf)) await engine.loadTimeframe(tf, 300);
      const res = r() < 0.5 ? engine.step1m() : engine.stepBar(tf);
      if (res === 'waiting_for_data') await engine.waitForPrefetch();
      if (step % 30 === 0) {
        checks++;
        for (const t of TIMEFRAMES) {
          if (!engine.hasTimeframe(t)) continue;
          const got = engine.bars(t);
          const want = truth(all, t, engine.replayMs, got[0].t);
          expect(got).toEqual(want);
          expect(got[got.length - 1].t).toBeLessThan(engine.replayMs); // 没有任何一根开盘在回放时刻之后
          compared += got.length;
        }
      }
    }
    expect(checks).toBe(100);
    expect(compared).toBeGreaterThan(10_000);
  }, 30_000); // 100 个检查点要几秒，机器忙时会超过默认的 5 秒上限（2026-10-22 实测 5.8 秒），所以单独放宽；检查内容不变
});

describe('已走根数与服务器算法一致', () => {
  it('按收盘计、只计存在的 K 线', async () => {
    const all = makeData(3);
    const startMs = Date.UTC(2026, 5, 9, 10, 15);
    const { engine } = await makeEngine(all, startMs);
    for (let i = 0; i < 2500; i++) {
      if (engine.step1m() === 'waiting_for_data') await engine.waitForPrefetch();
    }
    const opens = new Set(all.filter((b) => b.t >= startMs && b.t < engine.replayMs).map((b) => bucketOpenMs(b.t, '15m', 'utc_0')));
    const expected = [...opens].filter((o) => o + TIMEFRAME_MS['15m'] <= engine.replayMs).length;
    expect(engine.barsPlayed()).toBe(expected);
    expect(expected).toBeGreaterThan(100);
  });
});

describe('断点续练后已走根数接得上', () => {
  it('只带最近一天的 1m 重新打开，继续推进，根数与一直没关页面的一样', async () => {
    const all = makeData(11);
    const startMs = Date.UTC(2026, 5, 9, 10, 15);
    const { engine: a } = await makeEngine(all, startMs);
    for (let i = 0; i < 3000; i++) if (a.step1m() === 'waiting_for_data') await a.waitForPrefetch();
    // 模拟关页面后重新打开：服务器给的是当时的已走根数，1m 只给当前日线开盘以来的
    const now = a.replayMs;
    const leadFrom = bucketOpenMs(now - MINUTE_MS, '1d', 'utc_0');
    const src = fakeSource(all, 3 * 1380, { future: 0 });
    const b = new ReplayEngine(
      {
        startMs,
        replayMs: now,
        startTimeframe: '15m',
        dayAnchor: 'utc_0',
        background: await src.historyBars('15m', leadFrom, 400),
        past1m: all.filter((x) => x.t >= leadFrom && x.t < now),
        future1m: all.filter((x) => x.t >= now).slice(0, 3 * 1380),
        futureReachedDataEnd: false,
        barsPlayedAtInit: a.barsPlayed(),
        prefetchWhenRemainingRatio: 0.3,
        keep1mDays: 3,
      },
      src,
    );
    expect(b.barsPlayed()).toBe(a.barsPlayed());
    for (let i = 0; i < 1000; i++) {
      if (a.step1m() === 'waiting_for_data') await a.waitForPrefetch();
      if (b.step1m() === 'waiting_for_data') await b.waitForPrefetch();
    }
    expect(b.replayMs).toBe(a.replayMs);
    expect(b.barsPlayed()).toBe(a.barsPlayed());
    expect(b.bars('15m').slice(-100)).toEqual(a.bars('15m').slice(-100));
  });
});

describe('预取与数据终点', () => {
  it('剩余不足 30% 时自动预取，播到最后报告 data_end', async () => {
    const all = makeData(5);
    const startMs = Date.UTC(2026, 5, 22, 0, 0);
    const calls = { future: 0 };
    const { engine } = await makeEngine(all, startMs, 2000, calls);
    let last: string = '';
    for (let i = 0; i < 20000; i++) {
      last = engine.step1m();
      if (last === 'waiting_for_data') await engine.waitForPrefetch();
      if (last === 'data_end') break;
    }
    expect(last).toBe('data_end');
    expect(calls.future).toBeGreaterThan(1);
    expect(engine.last1m()!.t).toBe(all[all.length - 1].t); // 一根不漏地播到了最后
  });

  it('往左加载更早的历史', async () => {
    const all = makeData(5);
    const { engine } = await makeEngine(all, Date.UTC(2026, 5, 22, 0, 0));
    await engine.loadTimeframe('1h', 50);
    const before = engine.bars('1h').length;
    const added = await engine.loadEarlier('1h', 100);
    expect(added).toBe(100);
    const bars = engine.bars('1h');
    expect(bars.length).toBe(before + 100);
    for (let i = 1; i < bars.length; i++) expect(bars[i].t).toBeGreaterThan(bars[i - 1].t);
  });
});

describe('预取的后续 K 线开盘时刻（D74 画线未来区用）', () => {
  it('与用后续 1m 合成的 K 线开盘一致，且不含当前这根和之前的', async () => {
    const all = makeData(5);
    const startMs = Date.UTC(2026, 5, 9, 10, 15);
    const { engine } = await makeEngine(all, startMs);
    for (let i = 0; i < 7; i++) engine.step1m();
    for (const tf of ['15m', '1h', '4h'] as Timeframe[]) {
      await engine.loadTimeframe(tf, 50);
      const last = engine.bars(tf).at(-1)!.t;
      const want = synthesize(all.filter((b) => b.t >= engine.replayMs).slice(0, engine.futureCount()), tf, 'utc_0')
        .map((b) => b.t).filter((t) => t > last);
      expect(engine.futureBarOpens(tf, last)).toEqual(want);
      expect(want.length).toBeGreaterThan(0);
    }
  });
});

describe('已练交易日（D84）', () => {
  const H = 3600_000;
  const MON = Date.UTC(2026, 5, 1); // 2026-06-01 星期一
  const FRI = Date.UTC(2026, 5, 5);
  it('不跨周末：24 小时 = 1.0 天，黄金和币安一样', () => {
    expect(elapsedTradingDays(MON + 10 * H, MON + 34 * H, true)).toBeCloseTo(1, 9);
    expect(elapsedTradingDays(MON + 10 * H, MON + 34 * H, false)).toBeCloseTo(1, 9);
  });
  it('跨周末：黄金跳过周六周日，币安照算', () => {
    const nextMonNoon = FRI + 3 * 24 * H + 12 * H;
    expect(elapsedTradingDays(FRI + 12 * H, nextMonNoon, true)).toBeCloseTo(1, 9); // 周五半天 + 周一半天
    expect(elapsedTradingDays(FRI + 12 * H, nextMonNoon, false)).toBeCloseTo(3, 9);
    expect(elapsedTradingDays(FRI + 30 * H, FRI + 60 * H, true)).toBe(0); // 整段都在周末
  });
  it('只看起点和回放时刻：同一时刻算多少次都一样', () => {
    const a = elapsedTradingDays(MON, MON + 200 * H, true);
    expect(elapsedTradingDays(MON, MON + 200 * H, true)).toBe(a);
    expect(a).toBeCloseTo(200 / 24 - 2, 9); // 200 小时里含一个完整周末（周六、周日共 2 天）
  });
  it('文字：满一周才加周数，一周 = 黄金 5 天、币安 7 天', () => {
    expect(tradingDaysLabel(2.44, true)).toBe('已过 2.4 个交易日');
    expect(tradingDaysLabel(4.9, true)).toBe('已过 4.9 个交易日');
    expect(tradingDaysLabel(7.5, true)).toBe('已过 7.5 个交易日（约 1.5 周）');
    expect(tradingDaysLabel(6.5, false)).toBe('已过 6.5 个交易日');
    expect(tradingDaysLabel(7.5, false)).toBe('已过 7.5 个交易日（约 1.1 周）');
  });
});

describe('周五收盘倒计时（D85）', () => {
  const at = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
  it('夏令时周五 UTC 21:00 收盘、冬令时 22:00（与 2015 年以来数据的最后一根 20:59 / 21:59 一致）', () => {
    expect(nextWeekendCloseMs(at(2026, 6, 1, 3))).toBe(at(2026, 6, 5, 21)); // 周一 → 当周五
    expect(nextWeekendCloseMs(at(2026, 1, 6, 3))).toBe(at(2026, 1, 9, 22));
  });
  it('夏令时切换的那几周：3 月 8 日（周日）开始、11 月 1 日（周日）结束', () => {
    expect(nextWeekendCloseMs(at(2026, 3, 6, 12))).toBe(at(2026, 3, 6, 22)); // 切换前的周五仍是冬令时
    expect(nextWeekendCloseMs(at(2026, 3, 9, 12))).toBe(at(2026, 3, 13, 21));
    expect(nextWeekendCloseMs(at(2026, 10, 30, 12))).toBe(at(2026, 10, 30, 21));
    expect(nextWeekendCloseMs(at(2026, 11, 2, 12))).toBe(at(2026, 11, 6, 22));
  });
  it('收盘之后到下周：周六、周日开盘后都指向下一个周五', () => {
    expect(nextWeekendCloseMs(at(2026, 6, 6, 12))).toBe(at(2026, 6, 12, 21));
    expect(nextWeekendCloseMs(at(2026, 6, 7, 22))).toBe(at(2026, 6, 12, 21));
  });
  it('只在收盘前 4 小时内显示，按分钟递减，到点显示已收盘', () => {
    expect(weekendCountdownLabel(at(2026, 6, 5, 16, 59))).toBeNull();
    expect(weekendCountdownLabel(at(2026, 6, 5, 17))).toBe('距周末收盘 4:00');
    expect(weekendCountdownLabel(at(2026, 6, 5, 17, 15))).toBe('距周末收盘 3:45');
    expect(weekendCountdownLabel(at(2026, 6, 5, 20, 59))).toBe('距周末收盘 0:01');
    expect(weekendCountdownLabel(at(2026, 6, 5, 21))).toBe('已到周末收盘');
    expect(weekendCountdownLabel(at(2026, 1, 9, 17, 59))).toBeNull(); // 冬令时 18:00 才开始
    expect(weekendCountdownLabel(at(2026, 1, 9, 18))).toBe('距周末收盘 4:00');
    expect(weekendCountdownLabel(at(2026, 6, 4, 20))).toBeNull(); // 周四同一时刻不显示
  });
});
