import { describe, expect, it } from 'vitest';
import { escapeHtml, finishImport, unescapeHtml, type RawSession, type RawSolve } from '../src/importCommon.js';

const EPOCH = new Date(0).toISOString();
const solve = (extra: Partial<RawSolve> = {}): RawSolve => ({ timeMs: 10_000, penalty: 'OK', scramble: 'R U', comment: null, at: 1_700_000_000_000, ...extra });
const session = (extra: Partial<RawSession> = {}): RawSession => ({ name: 'main', event: '333', sourceType: '333', solves: [solve()], ...extra });
const one = (s: Partial<RawSolve>) => finishImport([session({ solves: [solve(s)] })]);

describe('finishImport: times', () => {
  it.each([
    [1, 1],
    [86_400_000, 86_400_000],
    [12_345.5, 12_346], // rounded to whole ms
    [0.5, 1],
    [86_400_000.4, 86_400_000],
  ])('keeps %s ms as %s ms', (timeMs, kept) => {
    const r = one({ timeMs });
    expect(r.sessions[0].solves[0].timeMs).toBe(kept);
    expect(r.skipped.invalid).toBe(0);
  });

  it.each([0, 0.4, -1, 86_400_001, 86_400_000.5, NaN, Infinity, -Infinity])('drops %s ms as invalid (the server takes 1 ms to 24 h)', (timeMs) => {
    const r = finishImport([session({ solves: [solve({ timeMs }), solve({ timeMs: 5000 })] })]);
    expect(r.skipped).toEqual({ multiBlind: 0, invalid: 1 });
    expect(r.sessions[0].solves.map((s) => s.timeMs)).toEqual([5000]);
  });

  it('keeps the penalty as given, DNF included', () => {
    const r = finishImport([session({ solves: [solve({ penalty: 'DNF' }), solve({ penalty: '+2' }), solve({ penalty: 'OK' })] })]);
    expect(r.sessions[0].solves.map((s) => s.penalty)).toEqual(['DNF', '+2', 'OK']);
  });
});

describe('finishImport: text fields', () => {
  it('trims comments, turns blank ones into null and cuts them at 500 characters', () => {
    expect(one({ comment: '  nice one  ' }).sessions[0].solves[0].comment).toBe('nice one');
    expect(one({ comment: '   ' }).sessions[0].solves[0].comment).toBeNull();
    expect(one({ comment: undefined }).sessions[0].solves[0].comment).toBeNull();
    expect(one({ comment: 'c'.repeat(501) }).sessions[0].solves[0].comment).toBe('c'.repeat(500));
    expect(one({ comment: 42 }).sessions[0].solves[0].comment).toBe('42');
    expect(one({ comment: { evil: true } }).sessions[0].solves[0].comment).toBeNull();
  });

  it('keeps scrambles as written (no trimming) and cuts them at 2000 characters', () => {
    expect(one({ scramble: " R U R' " }).sessions[0].solves[0].scramble).toBe(" R U R' ");
    expect(one({ scramble: 'x'.repeat(2001) }).sessions[0].solves[0].scramble).toHaveLength(2000);
    expect(one({ scramble: null }).sessions[0].solves[0].scramble).toBe('');
    expect(one({ scramble: ['R'] }).sessions[0].solves[0].scramble).toBe('');
    expect(one({ scramble: 7 }).sessions[0].solves[0].scramble).toBe('7');
  });

  it('trims session names, cuts them at 40 characters and names a nameless one by its place in the file', () => {
    const r = finishImport([
      session({ name: '  padded  ' }),
      session({ name: 'n'.repeat(41) }),
      session({ name: '   ' }),
      session({ name: null }),
      session({ name: 12 }),
    ]);
    expect(r.sessions.map((s) => s.name)).toEqual(['padded', 'n'.repeat(40), 'import 3', 'import 4', '12']);
  });
});

describe('finishImport: dates', () => {
  it('turns epoch milliseconds into ISO dates', () => {
    expect(one({ at: Date.UTC(2015, 2, 1, 10, 20, 30, 456) }).sessions[0].solves[0].createdAt).toBe('2015-03-01T10:20:30.456Z');
  });

  it.each([null, undefined, NaN, 0, -1000, Infinity])('uses the epoch for a missing or invalid date (%s)', (at) => {
    expect(one({ at }).sessions[0].solves[0].createdAt).toBe(EPOCH);
  });

  // after 9999 toISOString() gives "+010000-01-01T...", which the solve service's createdAt check
  // (zod datetime, services/solve/src/schemas.ts) would refuse, failing the whole import
  it('gives every solve a createdAt the solve service accepts (4-digit year), even for a date after 9999', () => {
    // e.g. a csTimer timestamp written in ms instead of s: 1.7e12 s -> 1.7e15 ms
    for (const at of [Date.UTC(10000, 0, 1), 1_700_000_000_000_000, 8.64e15 - 1]) {
      expect(one({ at }).sessions[0].solves[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('keeps the last representable 4-digit-year date', () => {
    expect(one({ at: Date.UTC(9999, 11, 31, 23, 59, 59) }).sessions[0].solves[0].createdAt).toBe('9999-12-31T23:59:59.000Z');
  });
});

describe('finishImport: sessions', () => {
  it('orders sessions by rank, keeps file order for equal ranks and puts unranked ones last', () => {
    const r = finishImport([
      session({ name: 'unranked a' }),
      session({ name: 'rank 2', rank: 2 }),
      session({ name: 'rank 1', rank: 1 }),
      session({ name: 'unranked b' }),
      session({ name: 'rank 1 too', rank: 1 }),
      session({ name: 'rank 0', rank: 0 }),
    ]);
    expect(r.sessions.map((s) => s.name)).toEqual(['rank 0', 'rank 1', 'rank 1 too', 'rank 2', 'unranked a', 'unranked b']);
  });

  it('leaves out multi-blind sessions (event null) and counts their attempts', () => {
    const r = finishImport([session({ name: 'mbld', event: null, solves: [solve(), solve(), solve({ timeMs: 0 })] }), session({ name: 'normal' })]);
    expect(r.sessions.map((s) => s.name)).toEqual(['normal']);
    expect(r.skipped).toEqual({ multiBlind: 3, invalid: 0 });
  });

  it('drops a session left with no usable solves, and returns nothing for no sessions', () => {
    const r = finishImport([session({ name: 'bad', solves: [solve({ timeMs: 0 })] }), session({ name: 'empty', solves: [] })]);
    expect(r).toEqual({ sessions: [], skipped: { multiBlind: 0, invalid: 1 } });
    expect(finishImport([])).toEqual({ sessions: [], skipped: { multiBlind: 0, invalid: 0 } });
  });

  it('falls back to 3x3 for an unknown event and keeps the source type', () => {
    const [s] = finishImport([session({ event: '333mbf', sourceType: 'r3' })]).sessions;
    expect(s).toMatchObject({ event: '333', sourceType: 'r3' });
  });

  it('marks a practice session only when practice is true', () => {
    const r = finishImport([session({ practice: true }), session({ practice: false }), session({})]);
    expect(r.sessions.map((s) => s.practice)).toEqual([true, undefined, undefined]);
    expect('practice' in r.sessions[1]).toBe(false);
  });

  it('returns exactly the fields the import endpoint takes', () => {
    const [s] = finishImport([session({ rank: 3, solves: [solve({ comment: 'hi' })] })]).sessions;
    expect(Object.keys(s).sort()).toEqual(['event', 'name', 'solves', 'sourceType']);
    expect(Object.keys(s.solves[0]).sort()).toEqual(['comment', 'createdAt', 'penalty', 'scramble', 'timeMs']);
  });
});

describe('HTML escaping (csTimer session names)', () => {
  it('escapes and unescapes the five special characters', () => {
    expect(escapeHtml(`a<b>&"c"'d'`)).toBe('a&lt;b&gt;&amp;&quot;c&quot;&#39;d&#39;');
    expect(unescapeHtml('a&lt;b&gt;&amp;&quot;c&quot;&#39;d&#39;')).toBe(`a<b>&"c"'d'`);
  });

  it('round-trips any text, including text that already looks escaped', () => {
    for (const s of ['plain', '&amp;', '&lt;script&gt;', 'Tom & Jerry <3', `"'&<>`, '&&;;##']) expect(unescapeHtml(escapeHtml(s))).toBe(s);
  });

  it('unescapes only once (&amp;lt; is the text &lt;)', () => {
    expect(unescapeHtml('&amp;lt;')).toBe('&lt;');
    expect(unescapeHtml('&amp;amp;')).toBe('&amp;');
  });
});
