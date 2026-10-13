import { describe, expect, it } from 'vitest';
import { CsTimerFormatError, eventForScrType, parseCsTimerExport } from '../src/cstimer.js';

const sample = JSON.stringify({
  session1: [
    [[0, 12345], "R U R' U'", '', 1760400000],
    [[2000, 11000], "F R U'", 'nice', 1760400100],
    [[-1, 15000], 'D2 L2', '', 1760400200],
  ],
  session2: [[[0, 61234, 30000], 'Rw U2 ...', '', 1760500000]],
  session3: [],
  properties: {
    sessionData: JSON.stringify({
      '1': { name: 'main &amp; stuff', opt: {}, rank: 1 },
      '2': { name: 4, opt: { scrType: '444wca' }, rank: 2 },
      '3': { name: 3, opt: {} },
    }),
  },
});

describe('csTimer import', () => {
  it('parses sessions, penalties, events and names', () => {
    const sessions = parseCsTimerExport(sample);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].name).toBe('main & stuff');
    expect(sessions[0].event).toBe('333');
    expect(sessions[0].solves.map((s) => s.penalty)).toEqual(['OK', '+2', 'DNF']);
    expect(sessions[0].solves[0].timeMs).toBe(12345);
    expect(sessions[0].solves[1].comment).toBe('nice');
    expect(sessions[0].solves[0].createdAt).toBe(new Date(1760400000 * 1000).toISOString());
    expect(sessions[1].event).toBe('444');
    expect(sessions[1].name).toBe('4');
  });
  it('maps scramble types', () => {
    expect(eventForScrType('333ni')).toBe('333bf');
    expect(eventForScrType('pyrso')).toBe('pyram');
    expect(eventForScrType('222o')).toBe('222');
    expect(eventForScrType(undefined)).toBe('333');
  });
  it('rejects junk', () => {
    expect(() => parseCsTimerExport('hello')).toThrow(CsTimerFormatError);
    expect(() => parseCsTimerExport('{"a":1}')).toThrow(CsTimerFormatError);
  });
});
