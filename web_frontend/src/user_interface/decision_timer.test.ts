// 决策用时（D68）：只计页面在前台、两次操作间隔不超过 5 分钟的时段；切到后台的时段不计；新 K 线出现重新计时。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionTimer } from './decision_timer';

const handlers: Record<string, Array<() => void>> = {};
const doc = {
  visibilityState: 'visible',
  addEventListener: (t: string, f: () => void) => (handlers[t] ??= []).push(f),
  removeEventListener: () => undefined,
};
const fire = (t: string) => (handlers[t] ?? []).forEach((f) => f());

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.stubGlobal('window', { addEventListener: (t: string, f: () => void) => (handlers[t] ??= []).push(f), removeEventListener: () => undefined });
  vi.stubGlobal('document', doc);
  doc.visibilityState = 'visible';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('决策用时', () => {
  it('一直有操作：按真实时间累计', () => {
    const t = new DecisionTimer(5);
    vi.setSystemTime(20_000);
    fire('pointermove');
    vi.setSystemTime(45_000);
    expect(t.read()).toBe(45_000);
  });

  it('离开超过 5 分钟的那段不计（例：看 30 秒 → 离开 10 分钟 → 回来再想 15 秒 = 45 秒）', () => {
    const t = new DecisionTimer(5);
    vi.setSystemTime(30_000);
    fire('pointermove');
    vi.setSystemTime(30_000 + 600_000); // 10 分钟没碰电脑
    fire('pointermove');
    vi.setSystemTime(30_000 + 600_000 + 15_000);
    expect(t.read()).toBe(45_000);
  });

  it('切到别的标签页的时段不计；新 K 线出现重新计时', () => {
    const t = new DecisionTimer(5);
    vi.setSystemTime(10_000);
    doc.visibilityState = 'hidden';
    fire('visibilitychange');
    vi.setSystemTime(70_000); // 在后台 1 分钟
    doc.visibilityState = 'visible';
    fire('visibilitychange');
    vi.setSystemTime(75_000);
    expect(t.read()).toBe(15_000);
    t.reset();
    vi.setSystemTime(78_000);
    expect(t.read()).toBe(3_000);
  });
});
