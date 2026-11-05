// 画线未来区「往后第几根」对齐（D74）：用预取的后续 K 线开盘时刻当日历，走过周末、每日休市后点仍对准同一根 K 线。
import { describe, expect, it } from 'vitest';
import { futureAxisFromBars } from './practice_chart';

const H = 3600_000;
const M15 = 15 * 60_000;
// 黄金式的 15m：周五 20:00–21:00 UTC 有 4 根，然后周末休市，周日 22:00 起再开（时刻都是毫秒）
const FRI = Date.UTC(2026, 9, 23, 20, 0); // 2026-10-23 周五
const SUN = Date.UTC(2026, 9, 25, 22, 0); // 2026-10-25 周日
const bars = [0, 1, 2, 3].map((i) => FRI + i * M15).concat([0, 1, 2, 3, 4, 5].map((i) => SUN + i * M15));

/** 回放到第 shown 根（前 shown 根已显示，后面的是预取的后续行情）时的日历 */
const axisAt = (shown: number) => futureAxisFromBars(() => ({ opens: bars.slice(shown), tfMs: M15 }));
const sec = (ms: number) => ms / 1000;

describe('未来区按「往后第几根」对齐', () => {
  it('跨周末：往后第 3 根就是周日开盘后的第 1 根，不是按 15 分钟往后推出来的周六时刻', () => {
    const last = bars[1]; // 显示到周五 20:15
    const axis = axisAt(2);
    expect(axis.time(3, sec(last))).toBe(sec(SUN));
    expect(axis.slots(sec(SUN), sec(last))).toBe(3);
    expect(axis.slots(sec(SUN) - 1, sec(last))).toBe(2); // 周末空档里的时刻仍算在周五最后一根上
  });

  it('一根根往下走，点始终对准同一根 K 线（序号不变）', () => {
    const point = futureAxisFromBars(() => ({ opens: bars.slice(2), tfMs: M15 })).time(3, sec(bars[1]))!; // 画下去时：往后第 3 根
    for (let shown = 2; shown <= 5; shown++) {
      const lastIdx = shown - 1;
      const pos = point * 1000 > bars[lastIdx] ? lastIdx + axisAt(shown).slots(point, sec(bars[lastIdx])) : bars.indexOf(point * 1000);
      expect(pos).toBe(4); // bars[4] = 周日 22:00
    }
  });

  it('超出预取范围按周期长度往后估算，且来回换算一致', () => {
    const axis = axisAt(8); // 只剩 2 根预取
    const last = sec(bars[7]);
    expect(axis.time(2, last)).toBe(sec(bars[9]));
    expect(axis.time(5, last)).toBe(sec(bars[9]) + 3 * 900);
    for (let k = 1; k <= 8; k++) expect(axis.slots(axis.time(k, last)!, last)).toBe(k);
  });

  it('没有预取（数据到头）时从最后一根按周期往后推', () => {
    const axis = futureAxisFromBars(() => ({ opens: [], tfMs: H }));
    expect(axis.time(2, 1000)).toBe(1000 + 7200);
    expect(axis.slots(1000 + 7200, 1000)).toBe(2);
  });
});
