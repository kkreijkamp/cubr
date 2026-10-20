import { describe, expect, it } from 'vitest';
import { computeStandings } from '../src/standings.js';
import type { Results } from '../src/types.js';

const players = [
  { id: 'a', name: 'Alice' },
  { id: 'b', name: 'Bob' },
  { id: 'c', name: 'Cara' },
];

describe('computeStandings', () => {
  it('returns zeroed standings when there are no results', () => {
    const s = computeStandings(players, {});
    expect(s).toHaveLength(3);
    for (const row of s) expect(row).toMatchObject({ wins: 0, solves: 0, meanMs: null, ao5: null });
    expect(s.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Cara']); // tie-break by name
  });

  it('awards wins to the best effective time, counting +2 penalties', () => {
    const results: Results = {
      '1': { a: { timeMs: 10_000, penalty: 'OK' }, b: { timeMs: 9_000, penalty: '+2' } }, // b = 11 000
      '2': { a: { timeMs: 12_000, penalty: 'OK' }, b: { timeMs: 11_000, penalty: 'OK' } },
    };
    const s = computeStandings(players, results);
    const byId = Object.fromEntries(s.map((r) => [r.playerId, r]));
    expect(byId.a.wins).toBe(1);
    expect(byId.b.wins).toBe(1);
    expect(byId.c).toMatchObject({ wins: 0, solves: 0, meanMs: null });
    expect(byId.a.meanMs).toBe(11_000);
    expect(byId.b.meanMs).toBe(11_000);
  });

  it('gives every tied player a win', () => {
    const s = computeStandings(players, {
      '1': { a: { timeMs: 9_000, penalty: 'OK' }, b: { timeMs: 7_000, penalty: '+2' }, c: { timeMs: 9_500, penalty: 'OK' } },
    });
    const byId = Object.fromEntries(s.map((r) => [r.playerId, r]));
    expect(byId.a.wins).toBe(1);
    expect(byId.b.wins).toBe(1);
    expect(byId.c.wins).toBe(0);
  });

  it('never gives a DNF a win, even when everyone DNFs', () => {
    const s = computeStandings(players, {
      '1': { a: { timeMs: 5_000, penalty: 'DNF' }, b: { timeMs: 20_000, penalty: 'OK' } },
      '2': { a: { timeMs: 5_000, penalty: 'DNF' }, b: { timeMs: 6_000, penalty: 'DNF' } },
    });
    const byId = Object.fromEntries(s.map((r) => [r.playerId, r]));
    expect(byId.a.wins).toBe(0);
    expect(byId.b.wins).toBe(1);
    expect(byId.a.solves).toBe(2);
    expect(byId.a.meanMs).toBeNull(); // only DNFs -> no mean
    expect(byId.b.meanMs).toBe(20_000); // DNFs excluded from the mean
  });

  it('computes ao5 over the last 5 results (WCA trimming, -1 for DNF average)', () => {
    const results: Results = {};
    const times = [20_000, 10_000, 11_000, 12_000, 13_000, 14_000]; // last 5: 10..14 s
    times.forEach((t, i) => (results[String(i + 1)] = { a: { timeMs: t, penalty: 'OK' } }));
    let s = computeStandings([players[0]], results);
    expect(s[0].ao5).toBe(12_000); // (11+12+13)/3
    expect(s[0].solves).toBe(6);

    results['7'] = { a: { timeMs: 1, penalty: 'DNF' } };
    results['8'] = { a: { timeMs: 1, penalty: 'DNF' } };
    s = computeStandings([players[0]], results);
    expect(s[0].ao5).toBe(-1); // two DNFs in the last five
  });

  it('ao5 is null with fewer than 5 results and orders rounds numerically', () => {
    const results: Results = {
      '10': { a: { timeMs: 5_000, penalty: 'OK' } },
      '2': { a: { timeMs: 50_000, penalty: 'OK' } },
      '3': { a: { timeMs: 6_000, penalty: 'OK' } },
      '4': { a: { timeMs: 7_000, penalty: 'OK' } },
    };
    expect(computeStandings([players[0]], results)[0].ao5).toBeNull();
    results['5'] = { a: { timeMs: 8_000, penalty: 'OK' } };
    // chronological order 2,3,4,5,10 -> 50, 6, 7, 8, 5 -> drop 5 and 50 -> (6+7+8)/3
    expect(computeStandings([players[0]], results)[0].ao5).toBe(7_000);
  });

  it('sorts by wins, then mean', () => {
    const s = computeStandings(players, {
      '1': { a: { timeMs: 9_000, penalty: 'OK' }, b: { timeMs: 8_000, penalty: 'OK' }, c: { timeMs: 30_000, penalty: 'OK' } },
      '2': { a: { timeMs: 9_000, penalty: 'OK' }, b: { timeMs: 8_000, penalty: 'OK' }, c: { timeMs: 10_000, penalty: 'OK' } },
      '3': { a: { timeMs: 7_000, penalty: 'OK' }, b: { timeMs: 9_000, penalty: 'OK' }, c: { timeMs: 10_000, penalty: 'OK' } },
    });
    expect(s.map((r) => r.playerId)).toEqual(['b', 'a', 'c']);
  });

  it('ignores results of players that are not listed', () => {
    const s = computeStandings([players[0]], { '1': { a: { timeMs: 9_000, penalty: 'OK' }, x: { timeMs: 1_000, penalty: 'OK' } } });
    expect(s).toHaveLength(1);
    expect(s[0].wins).toBe(0); // x was faster
  });
});
