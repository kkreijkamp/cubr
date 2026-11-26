import { describe, expect, it } from 'vitest';
import { scrambleForScrType, CsTimerFormatError, eventForScrType, parseCsTimerExport } from '../src/cstimer.js';

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

describe("csTimer's practice and other-puzzle sessions", () => {
  const file = (scrType: string) =>
    JSON.stringify({
      session1: [[[0, 1840], "R2 U' R2 D B2 L2 U L2 D' B2 U2", '', 1763600000]],
      properties: { sessionData: JSON.stringify({ 1: { name: scrType, opt: { scrType }, rank: 1 } }) },
    });

  it('imports a PLL session as a 3x3 pll practice session, so its times never become 3x3 records', () => {
    const [s] = parseCsTimerExport(file('pll'));
    expect(s).toMatchObject({ event: '333', scramble: 'pll', practice: true, sourceType: 'pll' });
  });

  it('imports the other puzzles and relays as their own events, at their default', () => {
    expect(parseCsTimerExport(file('klmso'))[0]).toMatchObject({ event: 'klm' });
    expect(parseCsTimerExport(file('klmso'))[0].scramble).toBeUndefined();
    expect(parseCsTimerExport(file('r234w'))[0]).toMatchObject({ event: 'r234' });
    expect(parseCsTimerExport(file('ftoso'))[0]).toMatchObject({ event: 'fto' });
    expect(parseCsTimerExport(file('222eg1'))[0]).toMatchObject({ event: '222', scramble: '222eg1', practice: true });
  });

  it('maps scramble types cubr lists to their event and type', () => {
    expect(scrambleForScrType('pll')).toEqual({ event: '333', scramble: 'pll' });
    expect(scrambleForScrType('333')).toEqual({ event: '333' });
    expect(scrambleForScrType('444m')).toEqual({ event: '444', scramble: '444m' });
    expect(scrambleForScrType('sq1h')).toEqual({ event: 'sq1', scramble: 'sq1h' });
    expect(scrambleForScrType('mysteryType')).toEqual({ event: '333' });
  });
});
