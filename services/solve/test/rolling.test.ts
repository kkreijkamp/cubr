import { describe, expect, it } from 'vitest';
import type { Penalty } from '@cubetype/cubestats';
import { effectiveOrNull, rollingFromSolves } from '../src/rolling.js';

const ok = (ms: number) => ({ timeMs: ms, penalty: 'OK' as Penalty });
const dnf = (ms = 10_000) => ({ timeMs: ms, penalty: 'DNF' as Penalty });
const plus2 = (ms: number) => ({ timeMs: ms, penalty: '+2' as Penalty });

describe('rollingFromSolves', () => {
  it('returns nulls with fewer than 5 solves', () => {
    expect(rollingFromSolves([])).toEqual({ ao5: null, ao12: null });
    expect(rollingFromSolves([ok(1), ok(2), ok(3), ok(4)].map((s) => ok(s.timeMs * 1000)))).toEqual({ ao5: null, ao12: null });
  });

  it('computes ao5 (drop best and worst) once 5 solves exist', () => {
    // 10, 11, 12, 13, 20 → mean(11, 12, 13) = 12
    const r = rollingFromSolves([ok(10_000), ok(11_000), ok(12_000), ok(13_000), ok(20_000)]);
    expect(r).toEqual({ ao5: 12_000, ao12: null });
  });

  it('applies +2 and treats one DNF as the trimmed worst', () => {
    // 10, 11+2=13, 12, DNF, 9 → drop 9 and DNF → mean(10, 13, 12) = 11667
    const r = rollingFromSolves([ok(10_000), plus2(11_000), ok(12_000), dnf(), ok(9_000)]);
    expect(r.ao5).toBe(11_667);
  });

  it('encodes a DNF average as -1', () => {
    expect(rollingFromSolves([ok(10_000), dnf(), ok(12_000), dnf(), ok(9_000)]).ao5).toBe(-1);
  });

  it('uses only the latest 5/12 solves for ao5/ao12', () => {
    const solves = [dnf(), dnf(), dnf(), ...Array.from({ length: 12 }, (_, i) => ok(10_000 + i * 100))];
    const r = rollingFromSolves(solves);
    // last 5 = 10700..11100 → mean(10800, 10900, 11000) = 10900
    expect(r.ao5).toBe(10_900);
    // last 12 = 10000..11100 → drop 10000 & 11100 → mean(10100..11000) = 10550
    expect(r.ao12).toBe(10_550);
  });
});

describe('effectiveOrNull', () => {
  it('adds +2 and maps DNF to null', () => {
    expect(effectiveOrNull(ok(5000))).toBe(5000);
    expect(effectiveOrNull(plus2(5000))).toBe(7000);
    expect(effectiveOrNull(dnf(5000))).toBeNull();
  });
});
