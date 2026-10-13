import { describe, expect, it } from 'vitest';
import { percentBeaten, rankFromCounts } from '../src/stats.js';

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
