import { describe, expect, it } from 'vitest';
import { fmtAvg, fmtSolveShort } from '../../components/timer/statsUtil';

describe('formatting', () => {
  it('rounds averages but truncates singles', () => {
    expect(fmtAvg(12345, 2)).toBe('12.35');
    expect(fmtAvg(12344, 2)).toBe('12.34');
    expect(fmtAvg(Infinity, 2)).toBe('DNF');
    expect(fmtAvg(null, 2)).toBe('-');
    expect(fmtSolveShort({ timeMs: 12349, penalty: 'OK' }, 2)).toBe('12.34');
    expect(fmtSolveShort({ timeMs: 12349, penalty: '+2' }, 2)).toBe('14.34+');
    expect(fmtSolveShort({ timeMs: 12349, penalty: 'DNF' }, 2)).toBe('DNF');
  });
});
