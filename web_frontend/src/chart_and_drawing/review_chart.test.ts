// 静态 K 线图看连续亏损段（第 5b-2 阶段，D71）：地址解析、自动选周期。
import { describe, expect, it } from 'vitest';
import { parseReviewStreak, timeframeForSpan } from './review_chart';

const H = 3_600_000;

describe('连续亏损段的地址', () => {
  it('起止、持仓编号、第几笔都读出来', () => {
    expect(parseReviewStreak('1767383100000-1769632020000', '5,8,11,14', '2,3,4,5')).toEqual({
      from: 1767383100000, to: 1769632020000, pids: [5, 8, 11, 14], nos: [2, 3, 4, 5],
    });
  });
  it('普通的「移到某一时刻」地址不当成连亏段', () => {
    expect(parseReviewStreak('1767383100000', undefined, undefined)).toBeNull();
    expect(parseReviewStreak('1-2', undefined, undefined)).toBeNull();
    expect(parseReviewStreak(undefined, undefined, undefined)).toBeNull();
  });
});

describe('自动选周期：整段不超过约 200 根', () => {
  it('短的一段用起始周期', () => {
    expect(timeframeForSpan(0, 10 * H, '15m')).toBe('15m'); // 40 根
  });
  it('长的一段换大周期，不小于起始周期', () => {
    expect(timeframeForSpan(0, 3715 * H, '15m')).toBe('1d'); // 约 155 天：4h 要 929 根，日线 155 根
    expect(timeframeForSpan(0, 600 * H, '15m')).toBe('4h'); // 150 根
    expect(timeframeForSpan(0, 3 * H, '1h')).toBe('1h');
  });
  it('超过 200 根日线用周线（D74）；再长也只能用周线', () => {
    expect(timeframeForSpan(0, 400 * 24 * H, '1m')).toBe('1w');
    expect(timeframeForSpan(0, 5000 * 24 * H, '1m')).toBe('1w');
  });
});
