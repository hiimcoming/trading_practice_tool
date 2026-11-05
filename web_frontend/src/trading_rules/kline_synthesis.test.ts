// 前后端 K 线合成对账（CLAUDE.md 架构铁律 3）：读 Python 生成的用例，用 TypeScript 逐根重算并比对。
// 用例文件：tests/cross_check_cases/kline_synthesis_cases.json（由 generate_kline_synthesis_cases.py 生成）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeIntoLast, synthesize, type Bar, type Bar1m, type DayAnchor, type Timeframe, type WeekStart } from './kline_synthesis';

interface CaseFile {
  cases: Array<{ name: string; window: string; timeframe?: Timeframe; day_anchor?: DayAnchor; week_start?: WeekStart; expected?: number[][]; input_1m?: number[][] }>;
}

const file = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../tests/cross_check_cases/kline_synthesis_cases.json'), 'utf-8'),
) as CaseFile;
const inputs = new Map<string, Bar1m[]>();
for (const c of file.cases) {
  if (c.input_1m) inputs.set(c.window, c.input_1m.map(([t, o, h, l, cl]) => ({ t, o, h, l, c: cl })));
}
const expectedCases = file.cases.filter((c) => c.expected);

const toRows = (bars: Bar[]) => bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.minuteCount]);

describe('前后端 K 线合成逐根一致', () => {
  it('用例数量正确', () => expect(expectedCases.length).toBe(48));
  for (const c of expectedCases) {
    it(c.name, () => {
      const got = synthesize(inputs.get(c.window)!, c.timeframe!, c.day_anchor!, c.week_start);
      expect(toRows(got)).toEqual(c.expected);
    });
  }
});

describe('增量合成与一次性合成结果相同', () => {
  for (const c of expectedCases.filter((x) => x.timeframe === '4h' || x.timeframe === '15m' || x.timeframe === '1w')) {
    it(c.name, () => {
      const out: Bar[] = [];
      for (const b of inputs.get(c.window)!) {
        const next = mergeIntoLast(out[out.length - 1] ?? null, b, c.timeframe!, c.day_anchor!, c.week_start);
        if (out.length && out[out.length - 1].t === next.t) out[out.length - 1] = next;
        else out.push(next);
      }
      expect(toRows(out)).toEqual(c.expected);
    });
  }
});
