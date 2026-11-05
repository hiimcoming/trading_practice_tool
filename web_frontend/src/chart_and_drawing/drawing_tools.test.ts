// 第 4b 阶段画线（D64）的测试：撤销 / 重做历史、样式记忆、设置工具条的样式换算、保存的画线能原样读回。
import { describe, expect, it } from 'vitest';
import { parseDrawings, type Drawing } from 'lightweight-charts-drawing';
import { DrawingHistory, newDrawingStyle, rememberDrawingStyle, setDrawingPalette, setDrawingStyleMemory } from './drawing_toolbar';
import { applyStyleChange, joinColor, splitColor, styleViewOf } from './drawing_settings_bar';

const PALETTE = { drawingLine: '#3A6DF0', boxBorder: '#6B7FB3', boxFill: '#6B7FB3', boxFillTransparency: 85, fibFillTransparency: 90 };
const T = 1_700_000_000; // 某个 UTC 秒

const hline = (style: Partial<Drawing['style']> = {}, extra: Partial<Drawing> = {}): Drawing =>
  ({ id: 'dw_h', kind: 'horizontal-line', points: [{ time: T, price: 3350.25 }], style: { color: '#3A6DF0', width: 1, lineStyle: 'solid', ...style }, ...extra }) as Drawing;

describe('撤销 / 重做历史', () => {
  it('撤销、重做按步回退和前进；新操作清空重做', () => {
    const h = new DrawingHistory('[]');
    expect(h.commit('[1]')).toBe(true);
    expect(h.commit('[1,2]')).toBe(true);
    expect(h.undo()).toBe('[1]');
    expect(h.undo()).toBe('[]');
    expect(h.undo()).toBeNull(); // 没有更早的了
    expect(h.redo()).toBe('[1]');
    expect(h.commit('[9]')).toBe(true); // 撤销后做了新操作
    expect(h.redo()).toBeNull();
    expect(h.undo()).toBe('[1]');
  });

  it('和上一份相同的快照不算一步（只是选中、没改东西）', () => {
    const h = new DrawingHistory('[1]');
    expect(h.commit('[1]')).toBe(false);
    expect(h.undo()).toBeNull();
  });

  it('清除全部能撤销回来', () => {
    const lines = JSON.stringify([hline()]);
    const h = new DrawingHistory('[]');
    h.commit(lines);
    h.commit('[]'); // 清除全部
    expect(h.undo()).toBe(lines);
  });

  it('最多记 100 步', () => {
    const h = new DrawingHistory('0');
    for (let i = 1; i <= 150; i++) h.commit(String(i));
    let n = 0;
    while (h.undo() !== null) n++;
    expect(n).toBe(100);
    expect(h.snapshot).toBe('50');
  });
});

describe('样式记忆：新画的线沿用该类工具最后一次的样式', () => {
  it('没改过时用配色默认；改过后沿用，且只影响同一类工具；锁定不沿用', () => {
    setDrawingPalette(PALETTE);
    setDrawingStyleMemory({});
    expect(newDrawingStyle('trend-line')?.color).toBe('#3A6DF0');
    const m = rememberDrawingStyle('trend-line', { color: 'rgba(242, 54, 69, 0.50)', width: 3, lineStyle: 'dotted', locked: true } as never);
    expect(m['trend-line']).toEqual({ color: 'rgba(242, 54, 69, 0.50)', width: 3, lineStyle: 'dotted' });
    const st = newDrawingStyle('trend-line')!;
    expect([st.color, st.width, st.lineStyle]).toEqual(['rgba(242, 54, 69, 0.50)', 3, 'dotted']);
    expect(newDrawingStyle('horizontal-line')?.color).toBe('#3A6DF0');
  });

  it('从用户设置读回时丢掉不认识的字段', () => {
    setDrawingStyleMemory({ rectangle: { color: '#F23645', hacker: 1 }, bad: 5 });
    expect(newDrawingStyle('rectangle')?.color).toBe('#F23645');
    expect((newDrawingStyle('rectangle') as Record<string, unknown>).hacker).toBeUndefined();
    setDrawingStyleMemory({});
  });

  it('斐波那契沿用斜线颜色时仍保留默认档位（含 1.382）', () => {
    setDrawingStyleMemory({ 'fib-retracement': { fibTrendLine: { visible: true, color: '#F23645', width: 2, style: 'dashed' } } });
    const st = newDrawingStyle('fib-retracement')!;
    expect(st.fibTrendLine?.color).toBe('#F23645');
    expect(st.levels?.filter((l) => l.visible).map((l) => l.coeff)).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.382]);
    setDrawingStyleMemory({});
  });
});

describe('设置工具条的颜色和不透明度', () => {
  it('颜色文字互相换算', () => {
    expect(splitColor('#3a6df0')).toEqual({ hex: '#3A6DF0', opacity: 100 });
    expect(splitColor('rgba(242, 54, 69, 0.35)')).toEqual({ hex: '#F23645', opacity: 35 });
    expect(joinColor('#F23645', 35)).toBe('rgba(242, 54, 69, 0.35)');
    expect(joinColor('#F23645', 100)).toBe('#F23645');
  });

  it('线：颜色和不透明度作用在线本身，价格标签文字保持不透明', () => {
    const s1 = applyStyleChange(hline(), { color: '#F23645' });
    expect([s1.color, s1.textColor]).toEqual(['#F23645', '#F23645']);
    const s2 = applyStyleChange(hline(s1), { opacity: 40 });
    expect(s2.color).toBe('rgba(242, 54, 69, 0.40)');
    expect(styleViewOf(hline(s2))).toEqual({ color: '#F23645', opacity: 40, width: 1, lineStyle: 'solid' });
  });

  it('方框：边框和填充同色，不透明度只调填充', () => {
    const box = { id: 'b', kind: 'rectangle', points: [], style: { color: '#6B7FB3', width: 1, lineStyle: 'solid', backgroundColor: '#6B7FB3', transparency: 85 } } as unknown as Drawing;
    expect(styleViewOf(box).opacity).toBe(15);
    const s = applyStyleChange(box, { color: '#089981' });
    expect([s.color, s.backgroundColor, s.transparency]).toEqual(['#089981', '#089981', 85]);
    expect(applyStyleChange(box, { opacity: 40 }).transparency).toBe(60);
  });

  it('斐波那契：颜色只改斜线、档位颜色不变；不透明度调分档填色', () => {
    const fib = { id: 'f', kind: 'fib-retracement', points: [], style: newDrawingStyle('fib-retracement') } as unknown as Drawing;
    const before = fib.style.levels!.map((l) => l.color);
    const s = applyStyleChange(fib, { color: '#E91E63' });
    expect(s.fibTrendLine?.color).toBe('#E91E63');
    expect(s.levels!.map((l) => l.color)).toEqual(before);
    expect(applyStyleChange(fib, { opacity: 30 }).transparency).toBe(70);
  });

  it('线宽、线型', () => {
    const s = applyStyleChange(hline(), { width: 4 });
    expect(s.width).toBe(4);
    expect(applyStyleChange(hline(s), { lineStyle: 'dashed' }).lineStyle).toBe('dashed');
  });
});

describe('保存的画线能原样读回（断点续练）', () => {
  it('导出的 JSON 经画线库的导入检查后，时间、价格、样式、锁定都不变', () => {
    setDrawingPalette(PALETTE);
    const list = [
      hline({ color: 'rgba(242, 54, 69, 0.40)', width: 3, lineStyle: 'dashed' }, { locked: true }),
      { id: 'dw_t', kind: 'trend-line', points: [{ time: T, price: 3301.5 }, { time: T + 4 * 3600, price: 3388.12 }], style: newDrawingStyle('trend-line') },
      { id: 'dw_f', kind: 'fib-retracement', points: [{ time: T, price: 3300 }, { time: T + 3600, price: 3400 }], style: applyStyleChange({ id: 'x', kind: 'fib-retracement', points: [], style: newDrawingStyle('fib-retracement') } as unknown as Drawing, { color: '#E91E63' }) },
    ] as Drawing[];
    const saved = JSON.parse(JSON.stringify(list)); // 模拟存到服务器再取回
    const back = parseDrawings(saved);
    expect(back).toHaveLength(3);
    expect(back[0].locked).toBe(true);
    expect(back[0].style.color).toBe('rgba(242, 54, 69, 0.40)');
    expect(back[1].points).toEqual([{ time: T, price: 3301.5 }, { time: T + 4 * 3600, price: 3388.12 }]);
    expect(back[2].style.fibTrendLine?.color).toBe('#E91E63');
  });
});
