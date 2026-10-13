import { describe, expect, it } from 'vitest';
import { mergeBuckets, percentBeaten, rankFromCounts } from '../src/stats.js';

describe('rank and percentile math', () => {
  it('rank = 1 + number of people strictly faster', () => {
    expect(rankFromCounts(0)).toBe(1);
    expect(rankFromCounts(41)).toBe(42);
  });
  it('percentile = % of competitors strictly slower, 2 decimals', () => {
    expect(percentBeaten(75, 100)).toBe(75);
    expect(percentBeaten(2, 3)).toBe(66.67);
    expect(percentBeaten(0, 10)).toBe(0);
    expect(percentBeaten(10, 10)).toBe(100);
    expect(percentBeaten(287_000, 287_633)).toBe(99.78);
  });
  it('is null without data and clamps out-of-range counts', () => {
    expect(percentBeaten(0, 0)).toBeNull();
    expect(percentBeaten(-1, 10)).toBe(0);
    expect(percentBeaten(11, 10)).toBe(100);
  });
});

describe('mergeBuckets', () => {
  const fine = Array.from({ length: 600 }, (_, i) => i % 3); // sum = 600

  it('merges 600 fine buckets exactly into a divisor of 600', () => {
    const b = mergeBuckets(fine, 700, 9, 50);
    expect(b).toHaveLength(50);
    expect(b[0]).toEqual({ from: 700, to: 700 + 12 * 9, count: 12 });
    expect(b[49].to).toBe(700 + 600 * 9);
    expect(b.reduce((s, x) => s + x.count, 0)).toBe(600);
  });
  it('never returns more buckets than requested and keeps equal widths', () => {
    const b = mergeBuckets(fine, 0, 1, 64); // k = 10 -> 60 buckets
    expect(b).toHaveLength(60);
    expect(new Set(b.map((x) => x.to - x.from))).toEqual(new Set([10]));
  });
  it('lets only the last bucket be narrower when not divisible', () => {
    const b = mergeBuckets(fine, 0, 1, 70); // k = 9 -> 67 buckets, last has 6
    expect(b).toHaveLength(67);
    expect(b[66]).toMatchObject({ from: 594, to: 600 });
    expect(b.reduce((s, x) => s + x.count, 0)).toBe(600);
  });
  it('returns the fine buckets unchanged when fewer than requested (333fm: 1 move each)', () => {
    const b = mergeBuckets([1, 5, 9], 20, 1, 50);
    expect(b).toEqual([
      { from: 20, to: 21, count: 1 },
      { from: 21, to: 22, count: 5 },
      { from: 22, to: 23, count: 9 },
    ]);
  });
  it('handles empty input', () => {
    expect(mergeBuckets([], 0, 1, 50)).toEqual([]);
  });
});
