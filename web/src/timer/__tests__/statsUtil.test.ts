import { describe, expect, it } from 'vitest';
import { parseTimeInput } from '@cubetype/cubestats';
import { fmtAvg, fmtSolveLong, fmtSolveShort, parseAvgKey, parseManualEntry, statNs } from '../../components/timer/statsUtil';

describe('stat keys', () => {
  it('parses mo3/aoN', () => {
    expect(parseAvgKey('mo3')).toBe(3);
    expect(parseAvgKey('ao12')).toBe(12);
    expect(parseAvgKey('ao3')).toBeNull();
    expect(parseAvgKey('mo5')).toBeNull();
    expect(parseAvgKey('x')).toBeNull();
    expect(statNs(['ao100', 'mo3', 'ao5', 'ao5', 'bogus'])).toEqual([3, 5, 100]);
  });
});

describe('formatting', () => {
  it('rounds averages but truncates singles', () => {
    expect(fmtAvg(12345, 2)).toBe('12.35');
    expect(fmtAvg(12344, 2)).toBe('12.34');
    expect(fmtAvg(Infinity, 2)).toBe('DNF');
    expect(fmtAvg(null, 2)).toBe('-');
    expect(fmtSolveShort({ timeMs: 12349, penalty: 'OK' }, 2)).toBe('12.34');
    expect(fmtSolveShort({ timeMs: 12349, penalty: '+2' }, 2)).toBe('14.34+');
    expect(fmtSolveShort({ timeMs: 12349, penalty: 'DNF' }, 2)).toBe('DNF');
    expect(fmtSolveLong({ timeMs: 12349, penalty: 'DNF' }, 2)).toBe('DNF(12.34)');
    expect(fmtSolveLong({ timeMs: 1, penalty: 'DNF' }, 2)).toBe('DNF');
  });
});

describe('manual entry', () => {
  const p = (s: string) => parseManualEntry(s, parseTimeInput);
  it('understands csTimer typing formats', () => {
    expect(p('12.34')).toEqual({ timeMs: 12340, penalty: 'OK' });
    expect(p('1234')).toEqual({ timeMs: 12340, penalty: 'OK' });
    expect(p('1:02.5')).toEqual({ timeMs: 62500, penalty: 'OK' });
    expect(p('14.34+')).toEqual({ timeMs: 12340, penalty: '+2' });
    expect(p('DNF(12.34)')).toEqual({ timeMs: 12340, penalty: 'DNF' });
    expect(p('dnf')).toEqual({ timeMs: 1, penalty: 'DNF' });
    expect(p('')).toBeNull();
    expect(p('abc')).toBeNull();
    expect(p('1.5+')).toBeNull();
  });
});
