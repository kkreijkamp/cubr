import { describe, expect, it } from 'vitest';
import { DNF } from '../src/averages.js';
import { formatDuration, formatSolve, formatTime, parseTimeInput } from '../src/format.js';

describe('formatTime', () => {
  it.each([
    [0, 2, '0.00'],
    [5, 2, '0.00'],
    [10, 2, '0.01'],
    [9999, 2, '9.99'], // truncated, never rounded up to 10.00
    [9999, 3, '9.999'],
    [59_999, 2, '59.99'],
    [60_000, 2, '1:00.00'],
    [61_005, 2, '1:01.00'],
    [61_005, 3, '1:01.005'],
    [3_599_999, 2, '59:59.99'],
    [3_600_000, 2, '1:00:00.00'],
    [36_061_010, 3, '10:01:01.010'],
  ] as const)('%i ms at precision %i is %s', (ms, precision, text) => {
    expect(formatTime(ms, precision)).toBe(text);
  });

  it('shows DNF for Infinity and -1, and "-" for no value', () => {
    expect(formatTime(DNF, 3)).toBe('DNF');
    expect(formatTime(-1)).toBe('DNF');
    for (const v of [null, undefined, NaN]) expect(formatTime(v)).toBe('-');
  });
});

describe('formatSolve', () => {
  it('adds the 2 s of a +2 before truncating, and wraps the raw time of a DNF', () => {
    expect(formatSolve(12_345, '+2')).toBe('14.34+');
    expect(formatSolve(12_345, '+2', 3)).toBe('14.345+');
    expect(formatSolve(58_999, '+2')).toBe('1:00.99+');
    expect(formatSolve(12_345, 'DNF', 3)).toBe('DNF(12.345)');
    expect(formatSolve(12_345, 'OK')).toBe('12.34');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [59_999, '59s'],
    [60_000, '1m 0s'],
    [3_599_000, '59m 59s'],
    [3_600_000, '1h 0m'],
    [86_399_000, '23h 59m'],
    [86_400_000, '1d 0h'],
    [90_061_000, '1d 1h'],
    [400 * 86_400_000, '400d 0h'],
  ])('%i ms is %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('parseTimeInput', () => {
  it.each([
    ['12.34', 12_340],
    ['  12.34  ', 12_340],
    ['0.001', 1],
    ['12.345', 12_345],
    ['60.5', 60_500], // seconds above 59 are fine without minutes
    ['1:00', 60_000],
    ['1:02.34', 62_340],
    ['75:00', 4_500_000],
    ['1:02:03.4', 3_723_400],
    // csTimer-style digits: the last two are centiseconds
    ['5', 50],
    ['123', 1230],
    ['1234', 12_340],
    ['10234', 62_340],
    ['1000000', 3_600_000],
    ['1234567', 5_025_670],
    ['dnf', DNF],
    [' DNF ', DNF],
  ])('reads %j as %d ms', (input, ms) => {
    expect(parseTimeInput(input)).toBe(ms);
  });

  it.each(['', '   ', '0', '00', '0.000', 'abc', '-1', '1.2.3', '12,34', '12.3456', '1:60', '1:75.00', '1:60:00', '6000', '16000', '1:2:3:4', 'DNF(12.34)'])(
    'rejects %j',
    (input) => {
      expect(parseTimeInput(input)).toBeNull();
    },
  );
});
