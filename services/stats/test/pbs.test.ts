import { describe, expect, it } from 'vitest';
import {
  computePbs, isImprovement, replayHistory, rollingFromPayload, tailAverages, type ListSolve,
} from '../src/domain/pbs.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-10-01T00:00:00Z');

let counter = 0;
function solve(sessionId: string, minute: number, timeMs: number, penalty: ListSolve['penalty'] = 'OK'): ListSolve {
  counter++;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    sessionId,
    timeMs,
    penalty,
    createdAt: new Date(T0 + minute * 60_000).toISOString(),
  };
}

describe('computePbs', () => {
  it('returns nothing for no solves', () => {
    expect(computePbs([])).toEqual({});
  });

  it('single = best effective time; +2 counts, DNF never does', () => {
    const list = [solve(S1, 0, 9000, 'DNF'), solve(S1, 1, 9500, '+2'), solve(S1, 2, 11000)];
    const pbs = computePbs(list);
    expect(pbs.single).toEqual({ valueMs: 11000, solveId: list[2].id, achievedAt: list[2].createdAt });
    expect(pbs.mo3).toBeUndefined(); // the only mo3 contains a DNF -> DNF -> not a PB
    expect(pbs.ao5).toBeUndefined();
  });

  it('mo3 / ao5 come from the best window within one session; achievedAt = window end', () => {
    const list = [10000, 12000, 8000, 9000, 10000, 15000].map((t, i) => solve(S1, i, t));
    const pbs = computePbs(list);
    // mo3 windows: 10000,9667,9000,9667,11667 -> 9000 ending at index 4
    expect(pbs.mo3).toEqual({ valueMs: 9000, solveId: list[4].id, achievedAt: list[4].createdAt });
    // ao5 windows: [10,12,8,9,10] -> mean(9,10,10)=9667 ; [12,8,9,10,15] -> mean(9,10,12)=10333
    expect(pbs.ao5?.valueMs).toBe(9667);
    expect(pbs.ao5?.solveId).toBe(list[4].id);
    expect(pbs.ao12).toBeUndefined();
  });

  it('never builds an average across two sessions', () => {
    const a = [10000, 10000, 10000].map((t, i) => solve(S1, i, t));
    const b = [5000, 5000].map((t, i) => solve(S2, 10 + i, t));
    const pbs = computePbs([...a, ...b]);
    expect(pbs.mo3?.valueMs).toBe(10000); // 5000,5000 alone is not a mo3
    expect(pbs.single?.valueMs).toBe(5000);
  });

  it('takes the minimum across sessions and sorts each session chronologically', () => {
    // session 2 delivered out of order: chronological order is 7000, 7000, 7300
    const a = [9000, 9000, 9000].map((t, i) => solve(S1, i, t));
    const b = [solve(S2, 22, 7300), solve(S2, 20, 7000), solve(S2, 21, 7000)];
    const pbs = computePbs([...a, ...b]);
    expect(pbs.mo3).toEqual({ valueMs: 7100, solveId: b[0].id, achievedAt: b[0].createdAt });
  });

  it('ao5 tolerates one DNF, ao12 one DNF, and computes ao50/ao100 trimming', () => {
    const times = Array.from({ length: 100 }, (_, i) => 10000 + (i % 10) * 100);
    const list = times.map((t, i) => solve(S1, i, t, i === 3 ? 'DNF' : 'OK'));
    const pbs = computePbs(list);
    expect(pbs.ao5).toBeDefined();
    expect(pbs.ao12).toBeDefined();
    expect(pbs.ao50).toBeDefined();
    expect(pbs.ao100).toBeDefined();
    // ao100 trims 5 best + 5 worst (the DNF is one of the worst)
    expect(pbs.ao100!.valueMs).toBeGreaterThan(10000);
    expect(pbs.ao100!.achievedAt).toBe(list[99].createdAt);
  });

  it('keeps the earliest of equal results', () => {
    const list = [solve(S1, 0, 8000), solve(S1, 1, 8000)];
    expect(computePbs(list).single?.solveId).toBe(list[0].id);
  });
});

describe('replayHistory', () => {
  it('records each improvement chronologically across sessions', () => {
    const list = [
      solve(S1, 0, 12000), solve(S1, 1, 11000), solve(S1, 2, 13000), // mo3 12000 at minute 2
      solve(S2, 5, 10500), solve(S2, 6, 10000), solve(S2, 7, 9500), // mo3 10000 at minute 7
    ];
    const h = replayHistory(list);
    expect(h.filter((e) => e.kind === 'single').map((e) => e.valueMs)).toEqual([12000, 11000, 10500, 10000, 9500]);
    expect(h.filter((e) => e.kind === 'mo3')).toEqual([
      { kind: 'mo3', valueMs: 12000, achievedAt: list[2].createdAt },
      { kind: 'mo3', valueMs: 10000, achievedAt: list[5].createdAt },
    ]);
    // ascending by time
    const times = h.map((e) => Date.parse(e.achievedAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('final history value per kind equals computePbs', () => {
    const list = Array.from({ length: 300 }, (_, i) =>
      solve(i < 150 ? S1 : S2, i, 8000 + ((i * 7919) % 5000), i % 37 === 0 ? 'DNF' : i % 23 === 0 ? '+2' : 'OK'),
    );
    const pbs = computePbs(list);
    const h = replayHistory(list);
    for (const kind of ['single', 'mo3', 'ao5', 'ao12', 'ao50', 'ao100'] as const) {
      const last = h.filter((e) => e.kind === kind).at(-1);
      expect(last?.valueMs).toBe(pbs[kind]?.valueMs);
    }
  });
});

describe('incremental helpers', () => {
  it('isImprovement', () => {
    expect(isImprovement(9000, null)).toBe(true);
    expect(isImprovement(9000, 9500)).toBe(true);
    expect(isImprovement(9500, 9500)).toBe(false);
    expect(isImprovement(Number.POSITIVE_INFINITY, null)).toBe(false);
    expect(isImprovement(null, null)).toBe(false);
    expect(isImprovement(-1, null)).toBe(false);
  });

  it('rollingFromPayload maps -1 / null to "no candidate"', () => {
    expect(rollingFromPayload(10234)).toBe(10234);
    expect(rollingFromPayload(-1)).toBeNull();
    expect(rollingFromPayload(null)).toBeNull();
    expect(rollingFromPayload(undefined)).toBeNull();
  });

  it('tailAverages matches computePbs on the latest window', () => {
    const tail = [10000, 11000, 9000, 12000, 10000];
    expect(tailAverages(tail)).toEqual({ mo3: Math.round((9000 + 12000 + 10000) / 3), ao5: 10333 });
    expect(tailAverages([1, 2])).toEqual({});
  });
});
