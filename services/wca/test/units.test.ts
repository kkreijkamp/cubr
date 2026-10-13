import { describe, expect, it } from 'vitest';
import { apiToWca, rawThresholds, supportedEvent, unitOf, validateApiValue, wcaToApi, wcaToApiOrNull } from '../src/units.js';

describe('wcaToApi', () => {
  it('converts centiseconds to milliseconds for timed events', () => {
    expect(wcaToApi('333', 'single', 251)).toBe(2510);
    expect(wcaToApi('333', 'average', 351)).toBe(3510);
    expect(wcaToApi('777', 'average', 9593)).toBe(95930);
  });
  it('keeps 333fm singles in moves and divides averages by 100', () => {
    expect(unitOf('333fm')).toBe('moves');
    expect(wcaToApi('333fm', 'single', 16)).toBe(16);
    expect(wcaToApi('333fm', 'average', 1900)).toBe(19);
    expect(wcaToApi('333fm', 'average', 2467)).toBe(24.67);
    expect(wcaToApi('333fm', 'average', 2533)).toBe(25.33);
  });
  it('rounds fractional raw values (percentiles) to whole ms', () => {
    expect(wcaToApi('333', 'single', 1234.56)).toBe(12346);
  });
  it('passes null through', () => {
    expect(wcaToApiOrNull('333', 'single', null)).toBeNull();
    expect(wcaToApiOrNull('333', 'single', 1000)).toBe(10000);
  });
});

describe('apiToWca + rawThresholds', () => {
  it('maps ms to (possibly fractional) centiseconds', () => {
    expect(apiToWca('333', 'single', 12000)).toBe(1200);
    expect(apiToWca('333', 'single', 12345)).toBe(1234.5);
  });
  it('maps 333fm moves without floating-point noise', () => {
    expect(apiToWca('333fm', 'single', 22)).toBe(22);
    expect(apiToWca('333fm', 'average', 24.67)).toBe(2467);
    expect(apiToWca('333fm', 'average', 25.33)).toBe(2533);
  });
  it('round-trips API values', () => {
    for (const v of [1, 999, 12000, 12345, 86_400_000]) expect(wcaToApi('333', 'single', apiToWca('333', 'single', v))).toBe(v);
    for (const v of [16, 24.67, 33.33]) expect(wcaToApi('333fm', 'average', apiToWca('333fm', 'average', v))).toBe(v);
  });
  it('gives integer bounds for strict faster/slower comparisons', () => {
    // 12.000 s = 1200 cs: faster = best < 1200, slower = best > 1200, ties excluded from both
    expect(rawThresholds(1200)).toEqual({ fasterBelow: 1200, slowerAbove: 1200 });
    // 12.345 s = 1234.5 cs: 12.34 (1234) is faster, 12.35 (1235) is slower
    expect(rawThresholds(1234.5)).toEqual({ fasterBelow: 1235, slowerAbove: 1234 });
  });
});

describe('supported events', () => {
  it('serves cubetype events only (no 333mbf, no retired events)', () => {
    expect(supportedEvent('333')?.name).toBe('3x3x3 Cube');
    expect(supportedEvent('333mbf')).toBeUndefined();
    expect(supportedEvent('333ft')).toBeUndefined();
    expect(supportedEvent('magic')).toBeUndefined();
  });
});

describe('validateApiValue', () => {
  it('requires positive integer ms for timed events', () => {
    expect(validateApiValue('333', 12000)).toBeNull();
    expect(validateApiValue('333', 0)).toMatch(/positive/);
    expect(validateApiValue('333', -5)).toMatch(/positive/);
    expect(validateApiValue('333', 12.5)).toMatch(/integer/);
    expect(validateApiValue('333', 86_400_001)).toMatch(/at most/);
  });
  it('accepts fractional moves for 333fm up to 100', () => {
    expect(validateApiValue('333fm', 24.67)).toBeNull();
    expect(validateApiValue('333fm', 101)).toMatch(/100 moves/);
  });
});
