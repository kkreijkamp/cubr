import { describe, expect, it, vi } from 'vitest';
import { countAtMost, countBelow, createRankIndex, MAX_COUNTRY_LISTS } from '../src/rankIndex.js';

const sorted = Int32Array.from([500, 600, 600, 600, 700, 900]);

describe('counting in a sorted list', () => {
  it('finds how many are below, and at or below, a value', () => {
    expect([400, 500, 600, 650, 900, 1000].map((x) => countBelow(sorted, x))).toEqual([0, 0, 1, 4, 5, 6]);
    expect([400, 500, 600, 650, 900, 1000].map((x) => countAtMost(sorted, x))).toEqual([0, 1, 4, 4, 6, 6]);
    expect(countBelow(new Int32Array(0), 5)).toBe(0);
  });
});

describe('the rank index', () => {
  const loaders = () => ({
    sortedBests: vi.fn(async () => sorted),
    sortedCountryBests: vi.fn(async (_k: string, _e: string, country: string) => (country === 'Australia' ? Int32Array.from([600, 700]) : new Int32Array(0))),
  });

  it('counts as the SQL did, loading each list once per dataset version', async () => {
    const load = loaders();
    const ranks = createRankIndex(load);
    // a value of 600: 1 faster, 4 not slower, of 6
    const [a, b] = await Promise.all([ranks.world('v1', 'single', '333', 600, 600), ranks.world('v1', 'single', '333', 650, 650)]);
    expect(a).toEqual({ faster: 1, notSlower: 4, total: 6 });
    expect(b).toEqual({ faster: 4, notSlower: 4, total: 6 });
    expect(load.sortedBests).toHaveBeenCalledTimes(1); // the two shared one load
    expect(await ranks.country('v1', 'single', '333', 'Australia', 650, 650)).toEqual({ faster: 1, notSlower: 1, total: 2 });
    // a new import: loaded again
    await ranks.world('v2', 'single', '333', 600, 600);
    expect(load.sortedBests).toHaveBeenCalledTimes(2);
  });

  it('tries a failed load again, and keeps a bounded number of country lists', async () => {
    const load = loaders();
    load.sortedBests.mockRejectedValueOnce(new Error('database down'));
    const ranks = createRankIndex(load);
    await expect(ranks.world('v1', 'single', '333', 600, 600)).rejects.toThrow('database down');
    expect(await ranks.world('v1', 'single', '333', 600, 600)).toMatchObject({ faster: 1 });
    for (let i = 0; i <= MAX_COUNTRY_LISTS; i++) await ranks.country('v1', 'single', '333', `C${i}`, 600, 600);
    await ranks.country('v1', 'single', '333', 'C0', 600, 600); // the oldest was let go: loaded again
    expect(load.sortedCountryBests).toHaveBeenCalledTimes(MAX_COUNTRY_LISTS + 2);
  });
});
