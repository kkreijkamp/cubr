import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CsTimerFormatError,
  EVENT_IDS,
  IMPORT_FORMATS,
  parseLocalDateTime,
  parseTimeString,
  parseTimerFile,
  readDelimited,
  TimerFormatError,
  toCsTimerExport,
  type TimerImport,
} from '../src/index.js';
import { SqliteFormatError } from '../src/sqlite.js';
import { DCTIMER_SCHEMA, sqliteBytes } from './helpers/sqliteFile.js';

const iso = (ms: number) => new Date(ms).toISOString();
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => iso(new Date(y, mo - 1, d, h, mi, s).getTime());
const EPOCH = iso(0);
const NAME = 'café 三阶';
const utf8 = (s: string) => new TextEncoder().encode(s);

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, littleEndian); // the byte order mark
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), littleEndian);
  return out;
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected an error');
}

/** [name, event, [timeMs, penalty][]] per session */
const summary = (r: TimerImport) => r.sessions.map((s) => [s.name, s.event, s.solves.map((x) => [x.timeMs, x.penalty])]);

const quoteRow = (fields: string[]) => fields.map((f) => `"${f.replace(/"/g, '""')}"`).join(';');
const TWISTY_HEADER = 'Puzzle,Category,Time(millis),Date(millis),Scramble,Penalty,Comment';
const CUBIC_HEADER = '"Puzzle";"Category";"Time(millis)";"Date(millis)";"Scramble";"Penalty";"Comment"';
const MATEUS_HEADER = '"Category";"Time (MM:SS.SSS)";"Scrambler";"Date";"Penalty +2 (yes or no)";"DNF (yes or no)";"Section"';
const twisty = (...rows: string[][]) => [TWISTY_HEADER, ...rows.map(quoteRow)].join('\n');
const mateus = (...rows: string[][]) => [MATEUS_HEADER, ...rows.map(quoteRow)].join('\n');
const csTimer = (sessions: Record<string, unknown>, sessionData?: Record<string, unknown>) =>
  JSON.stringify({ ...sessions, ...(sessionData ? { properties: { sessionData: JSON.stringify(sessionData) } } : {}) });

// One 9.00 solve (scramble "R ...") in one session, per format; non-ASCII text so decoding matters.
const SAMPLES: [format: string, text: string][] = [
  ['cubr', JSON.stringify({ exportedAt: '2026-11-16T00:00:00.000Z', sessions: [{ name: NAME, event: '333', solves: [{ timeMs: 9000, penalty: 'OK', scramble: 'R', comment: NAME, createdAt: '2020-09-13T12:26:40.000Z' }] }] })],
  ['csTimer', csTimer({ session1: [[[0, 9000], 'R', NAME, 1600000000]] }, { 1: { name: NAME, opt: {} } })],
  ['csTimer (CSV)', `No.;Time;Comment;Scramble;Date;P.1\n1;9.00;${NAME};R;2020-09-13 12:26:40;9.00\n`],
  ['Twisty Timer', `${TWISTY_HEADER}\n${quoteRow(['333', NAME, '9000', '1600000000000', 'R', '0', NAME])}\n`],
  ['Cubic Timer', `${CUBIC_HEADER}\n${quoteRow(['333', NAME, '9000', '1600000000000', 'R', '0', NAME])}\n`],
  ['Block Keeper', JSON.stringify({ puzzles: [{ name: NAME, scrambler: '3x3x3', sessions: [{ name: 'S', records: [{ time: 9, result: 'OK', scramble: 'R', comment: NAME, date: 1600000000000 }] }] }] })],
  ['CubeDesk', JSON.stringify({ sessions: [{ id: 's1', name: NAME, order: 0 }], solves: [{ session_id: 's1', cube_type: '333', raw_time: 9, dnf: false, plus_two: false, scramble: 'R', notes: NAME, started_at: 1600000000000 }] })],
  ['DCTimer', `1\n9000\t0\t1\tR\t2020-09-13 12:26:40\t${NAME}\n`],
  ['mateus Cubetimer', `${MATEUS_HEADER}\n${quoteRow(['3x3x3', '00:09.000', `R ${NAME}`, '2020-09-13 12:26', 'no', 'no', '1'])}\n`],
  ['GAN CubeStation', JSON.stringify({ code: 200, data: { data: [{ startTime: 1600000000, duration: 9000, scramble: `R ${NAME}`, normalScore: 1, leagueId: 3 }] } })],
];

describe('format detection', () => {
  it.each(SAMPLES)('detects a %s file', (format, text) => {
    const r = parseTimerFile(text);
    expect(r.format).toBe(format);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].solves).toHaveLength(1);
    expect(r.sessions[0].solves[0]).toMatchObject({ timeMs: 9000, penalty: 'OK' });
    expect(r.sessions[0].solves[0].scramble.startsWith('R')).toBe(true);
    expect(r.skipped).toEqual({ multiBlind: 0, invalid: 0 });
  });

  it.each(SAMPLES)('reads a %s file the same as text, UTF-8 (with or without BOM), UTF-16 LE/BE and with CRLF lines', (_format, text) => {
    const expected = parseTimerFile(text);
    expect(JSON.stringify(expected)).toContain(JSON.stringify(NAME).slice(1, -1));
    for (const input of [utf8(text), new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(text)]), `﻿${text}`, utf16(text, true), utf16(text, false), text.replace(/\n/g, '\r\n'), `\n  ${text}`]) {
      expect(parseTimerFile(input)).toEqual(expected);
    }
  });

  it('names each detected format after one of the supported formats', () => {
    const formats = SAMPLES.map(([, text]) => parseTimerFile(text).format);
    formats.push(parseTimerFile(new Uint8Array(readFileSync(new URL('./fixtures/dctimer-backup.db', import.meta.url)))).format);
    for (const f of formats) expect(IMPORT_FORMATS.some((name) => f === name || f.startsWith(`${name} (`))).toBe(true);
    // and every supported format is detected by one of the samples
    for (const name of IMPORT_FORMATS) expect(formats.some((f) => f.startsWith(name))).toBe(true);
  });
});

describe('csTimer export (JSON)', () => {
  it('reads raw times (kept for a DNF), penalties, comments, scrambles and second timestamps', () => {
    const r = parseTimerFile(
      csTimer({
        session1: [
          [[0, 12345], "R U R' U'", '', 1760400000],
          [[2000, 11000], "F R U'", 'nice', 1760400100],
          [[-1, 15000], 'D2 L2', '', 1760400200],
          [[0, 61234, 30000], 'Rw U2', '2 phases', 1760400300, 'moves are ignored'],
          [[0, 9000], 'B', '', 0],
        ],
      }),
    );
    const s = r.sessions[0];
    expect(s.solves.map((x) => [x.timeMs, x.penalty])).toEqual([[12345, 'OK'], [11000, '+2'], [15000, 'DNF'], [61234, 'OK'], [9000, 'OK']]);
    expect(s.solves.map((x) => x.comment)).toEqual([null, 'nice', null, '2 phases', null]);
    expect(s.solves[1].scramble).toBe("F R U'");
    expect(s.solves[0].createdAt).toBe(iso(1760400000 * 1000));
    expect(s.solves[4].createdAt).toBe(EPOCH); // no timestamp
  });

  it.each([
    ['333', '333'], ['222so', '222'], ['444wca', '444'], ['555wca', '555'], ['666wca', '666'], ['777wca', '777'],
    ['333oh', '333oh'], ['333ni', '333bf'], ['333fm', '333fm'], ['444bld', '444bf'], ['555bld', '555bf'],
    ['clkwca', 'clock'], ['mgmp', 'minx'], ['pyrso', 'pyram'], ['skbso', 'skewb'], ['sqrs', 'sq1'],
    // csTimer's other scramble types, by prefix
    ['222o', '222'], ['444m', '444'], ['pyrm', 'pyram'], ['skbo', 'skewb'], ['sq1h', 'sq1'], ['clkwcab', 'clock'], ['mgmc', 'minx'], ['minx2g', 'minx'],
    // anything else is timed as 3x3
    ['pll', '333'], ['333ft', '333'],
  ])('scramble type %s is event %s (source type kept)', (scrType, event) => {
    const r = parseTimerFile(csTimer({ session1: [[[0, 5000], 'x', '', 1700000000]] }, { 1: { name: 'a', opt: { scrType } } }));
    expect(r.sessions[0]).toMatchObject({ event, sourceType: scrType });
  });

  it('treats an empty opt, or no session data at all, as 3x3 and names the session by its number', () => {
    const r = parseTimerFile(csTimer({ session1: [[[0, 5000], 'x', '', 1]], session2: [[[0, 6000], 'y', '', 1]] }, { 1: { name: '  ', opt: {} } }));
    expect(r.sessions.map((s) => [s.name, s.event, s.sourceType])).toEqual([['csTimer 1', '333', '333'], ['csTimer 2', '333', '333']]);
  });

  it('accepts sessionData as an object as well as a JSON string, and unescapes HTML in names', () => {
    const file = JSON.stringify({ session1: [[[0, 5000], 'x', '', 1]], properties: { sessionData: { 1: { name: 'Tom &amp; Jerry &lt;3', opt: { scrType: 'pyrso' } } } } });
    expect(parseTimerFile(file).sessions[0]).toMatchObject({ name: 'Tom & Jerry <3', event: 'pyram' });
  });

  it('orders sessions by rank, and by session number (not text order) where there is no rank', () => {
    const solves = [[[0, 5000], 'x', '', 1]];
    const file = JSON.stringify({ session10: solves, session9: solves, session2: solves, session1: solves, properties: { sessionData: JSON.stringify({ 2: { name: 'first', rank: 0 } }) } });
    expect(parseTimerFile(file).sessions.map((s) => s.name)).toEqual(['first', 'csTimer 1', 'csTimer 9', 'csTimer 10']);
  });

  it('skips malformed solves and sessions without failing the file', () => {
    const file = JSON.stringify({
      session1: ['junk', null, [1, 2], [[0, 7000], 'ok', '', 1700000000], [[0, 'abc'], 'nan', '', 1]],
      session2: [],
      session3: 'not json',
      session4: JSON.stringify([[[0, 8000], 'stored as a string', '', 1700000000]]),
      properties: 'not json either',
    });
    const r = parseTimerFile(file);
    expect(summary(r)).toEqual([['csTimer 1', '333', [[7000, 'OK']]], ['csTimer 4', '333', [[8000, 'OK']]]]);
    expect(r.skipped).toEqual({ multiBlind: 0, invalid: 1 });
  });

  it('leaves out a multi-blind session (r3ni) and imports the others', () => {
    const r = parseTimerFile(csTimer({ session1: [[[0, 5000], 'x', '', 1]], session2: [[[0, 1], 'mbld', '', 1], [[0, 2], 'mbld', '', 1]] }, { 2: { name: 'multi', opt: { scrType: 'r3ni' } } }));
    expect(r.sessions.map((s) => s.name)).toEqual(['csTimer 1']);
    expect(r.skipped).toEqual({ multiBlind: 2, invalid: 0 });
  });
});

describe('csTimer session CSV', () => {
  it('adds up the phase columns of a multi-phase solve for the raw time', () => {
    const r = parseTimerFile(
      [
        'No.;Time;Comment;Scramble;Date;P.1;P.2',
        '1;1:01.23;;R;2020-01-01 10:00:00;31.23;30.00',
        '2;1:03.23+;;U;2020-01-01 10:01:00;31.23;30.00',
        '3;DNF(58.00);;F;2020-01-01 10:02:00;28.00;30.00',
      ].join('\n'),
    );
    expect(summary(r)).toEqual([['csTimer CSV', '333', [[61230, 'OK'], [61230, '+2'], [58000, 'DNF']]]]);
    expect(r.sessions[0].sourceType).toBe('csTimer CSV');
  });

  it('without usable phase columns, takes the time shown less the 2 s of a +2', () => {
    const r = parseTimerFile(['No.;Time;Comment;Scramble;Date', '1;14.50+;;R;2020-01-01 10:00:00', '2;DNF(9.99);;U;2020-01-01 10:00:00', '3;12.00+;;F;2020-01-01 10:00:00;n/a'].join('\n'));
    expect(r.sessions[0].solves.map((x) => [x.timeMs, x.penalty])).toEqual([[12500, '+2'], [9990, 'DNF'], [10000, '+2']]);
  });

  it('takes a DNF time from the phases, skips a DNF with no time and a row it cannot read', () => {
    const r = parseTimerFile(
      ['No.;Time;Comment;Scramble;Date;P.1', '1;DNF;;R;2020-01-01 10:00:00;12.34', '2;DNF;;U;2020-01-01 10:00:00', '3;abc;;F;2020-01-01 10:00:00;9.00', '4;10.00;"a ""quoted""; comment";B;2020-01-01 10:00:00;10.00'].join('\n'),
    );
    expect(r.sessions[0].solves.map((x) => [x.timeMs, x.penalty, x.comment])).toEqual([[12340, 'DNF', null], [10000, 'OK', 'a "quoted"; comment']]);
    expect(r.skipped.invalid).toBe(1);
  });
});

describe('Twisty Timer and Cubic Timer backups', () => {
  it.each([
    ['222', '222'], ['333', '333'], ['444', '444'], ['555', '555'], ['666', '666'], ['777', '777'],
    ['pyra', 'pyram'], ['skewb', 'skewb'], ['mega', 'minx'], ['sq1', 'sq1'], ['clock', 'clock'],
    ['333oh', '333oh'], ['333bld', '333bf'], ['444bld', '444bf'], ['555bld', '555bf'], ['333fmc', '333fm'],
    ['kilominx', '333'], ['toString', '333'], ['__proto__', '333'],
  ])('puzzle %s is event %s', (puzzle, event) => {
    const r = parseTimerFile(twisty([puzzle, 'Normal', '5000', '1600000000000', 'x', '0', '']));
    expect(r.sessions[0]).toMatchObject({ name: `${puzzle}-Normal`, event, sourceType: puzzle });
  });

  it('makes one session per puzzle and category, in the order first seen', () => {
    const r = parseTimerFile(
      twisty(
        ['333', 'OH', '21000', '1546301000000', 'U', '2', ''],
        ['333', 'Normal', '10500', '1546300800000', "R U R'", '0', 'say "hi"; ok'],
        ['333', 'OH', '22000', '1546301100000', 'F', '1', ''],
        ['pyra', 'Normal', '3000', '', 'L', '0', ''],
      ),
    );
    expect(summary(r)).toEqual([
      ['333-OH', '333', [[21000, 'DNF'], [20000, '+2']]],
      ['333-Normal', '333', [[10500, 'OK']]],
      ['pyra-Normal', 'pyram', [[3000, 'OK']]],
    ]);
    expect(r.sessions[1].solves[0]).toMatchObject({ scramble: "R U R'", comment: 'say "hi"; ok', createdAt: iso(1546300800000) });
    expect(r.sessions[2].solves[0].createdAt).toBe(EPOCH); // empty date
  });

  it("takes the +2 out of a +2 solve's time (Twisty Timer stores it in), and skips one stored under 2 s", () => {
    // PuzzleUtils.applyPenalty adds 2000 ms to the stored time; the backup writes that time as is
    const r = parseTimerFile(twisty(['333', 'Normal', '12345', '1600000000000', 'R', '1', ''], ['333', 'Normal', '12345', '1600000000000', 'R', '0', ''], ['333', 'Normal', '1500', '1600000000000', 'R', '1', '']));
    expect(r.sessions[0].solves.map((x) => [x.timeMs, x.penalty])).toEqual([[10_345, '+2'], [12_345, 'OK']]);
    expect(r.skipped.invalid).toBe(1);
  });

  it('skips rows without exactly seven fields and counts unreadable times as invalid', () => {
    const file = [TWISTY_HEADER, '333;Normal;5000;1;x;0', '333;Normal;5000;1;x;0;;extra', '333;Normal;abc;1;x;0;', '333;Normal;0;1;x;0;', '333;Normal;6000;1;x;0;'].join('\n');
    const r = parseTimerFile(file);
    expect(r.sessions[0].solves.map((x) => x.timeMs)).toEqual([6000]);
    expect(r.skipped).toEqual({ multiBlind: 0, invalid: 2 });
  });

  it('Cubic Timer: reads the same rows under its quoted ;-separated header', () => {
    const file = [CUBIC_HEADER, quoteRow(['skewb', 'Normal', '4321', '1600000000000', 'R L', '1', 'c']), quoteRow(['333mbld', 'Normal', '9', '1600000000000', 'x', '0', ''])].join('\r\n');
    const r = parseTimerFile(file);
    expect(r.format).toBe('Cubic Timer');
    expect(summary(r)).toEqual([['skewb-Normal', 'skewb', [[4321, '+2']]]]);
    expect(r.sessions[0].solves[0]).toMatchObject({ comment: 'c', createdAt: iso(1600000000000) });
    expect(r.skipped.multiBlind).toBe(1);
  });
});

describe('Block Keeper', () => {
  it.each([
    ['3x3x3', '333'], ['2x2x2', '222'], ['4x4x4', '444'], ['5x5x5', '555'], ['6x6x6', '666'], ['7x7x7', '777'],
    ['Pyraminx', 'pyram'], ['Skewb', 'skewb'], ['Megaminx', 'minx'], ['Square-1', 'sq1'], ['Clock', 'clock'],
    ['3x3x3 BLD', '333bf'], ['4x4x4 BLD', '444bf'], ['5x5x5 BLD', '555bf'], ['Kilominx', '333'],
  ])('scrambler %s is event %s', (scrambler, event) => {
    const r = parseTimerFile(JSON.stringify({ puzzles: [{ name: 'P', scrambler, sessions: [{ name: 'S', records: [{ time: 5, result: 'OK', scramble: 'x', date: 1 }] }] }] }));
    expect(r.sessions[0]).toMatchObject({ name: 'P-S', event, sourceType: scrambler });
  });

  it('reads seconds as rounded ms, results, comments and dates; skips puzzles and sessions without records', () => {
    const r = parseTimerFile(
      JSON.stringify({
        puzzles: [
          null,
          { name: 'no sessions', scrambler: '3x3x3' },
          {
            name: '3x3',
            scrambler: '3x3x3',
            sessions: [
              null,
              { name: 'no records' },
              {
                name: 'S1',
                records: [
                  { time: 1.005, result: 'OK', scramble: 'R', comment: ' c ', date: 1600000000000 },
                  { time: 9.876, result: '+2', scramble: 'U', date: 1600000001000 },
                  { time: 11, result: 'DNF', scramble: 'F', date: 1600000002000 },
                  { time: 12, result: 'something else', scramble: 'B' },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(summary(r)).toEqual([['3x3-S1', '333', [[1005, 'OK'], [9876, '+2'], [11000, 'DNF'], [12000, 'OK']]]]);
    expect(r.sessions[0].solves.map((x) => [x.comment, x.createdAt])).toEqual([
      ['c', iso(1600000000000)],
      [null, iso(1600000001000)],
      [null, iso(1600000002000)],
      [null, EPOCH],
    ]);
  });
});

describe('CubeDesk', () => {
  it.each([
    ['222', '222'], ['333', '333'], ['444', '444'], ['555', '555'], ['666', '666'], ['777', '777'],
    ['pyram', 'pyram'], ['skewb', 'skewb'], ['minx', 'minx'], ['sq1', 'sq1'], ['clock', 'clock'],
    ['333mirror', '333'], ['222oh', '222'], ['333oh', '333oh'], ['333bl', '333bf'], ['other', '333'],
  ])('cube type %s is event %s', (cube, event) => {
    const r = parseTimerFile(JSON.stringify({ sessions: [{ id: 'a', name: 'A', order: 0 }], solves: [{ session_id: 'a', cube_type: cube, raw_time: 5, scramble: 'x', started_at: 1 }] }));
    expect(r.sessions[0]).toMatchObject({ name: `A-${cube}`, event, sourceType: cube });
  });

  it('splits a session per cube type, orders by the session order and puts solves of unknown sessions last', () => {
    const r = parseTimerFile(
      JSON.stringify({
        sessions: [{ id: 'late', name: 'Late', order: 5 }, { id: 'early', name: 'Early', order: 1 }, null],
        solves: [
          { session_id: 'ghost', cube_type: '333', raw_time: 1, started_at: 1 },
          { session_id: 'late', cube_type: '333', raw_time: 2, started_at: 2 },
          { session_id: 'early', cube_type: '333', raw_time: 3, started_at: 3 },
          null,
          { session_id: 'early', cube_type: '222', raw_time: 4, started_at: 4 },
          { session_id: 'early', cube_type: '333', raw_time: 5, started_at: 5 },
        ],
      }),
    );
    expect(summary(r)).toEqual([
      ['Early-333', '333', [[3000, 'OK'], [5000, 'OK']]],
      ['Early-222', '222', [[4000, 'OK']]],
      ['Late-333', '333', [[2000, 'OK']]],
      ['ghost-333', '333', [[1000, 'OK']]],
    ]);
  });

  it('reads raw_time in seconds, DNF over +2, notes and started_at', () => {
    const r = parseTimerFile(
      JSON.stringify({
        sessions: [{ id: 'a', name: 'A', order: 0 }],
        solves: [
          { session_id: 'a', cube_type: '333', raw_time: 1.005, dnf: false, plus_two: true, scramble: 'R', notes: 'close', started_at: 1650000000000 },
          { session_id: 'a', cube_type: '333', raw_time: 7.5, dnf: true, plus_two: true, scramble: 'U', notes: '', started_at: 1650000001000 },
        ],
      }),
    );
    expect(r.sessions[0].solves).toEqual([
      { timeMs: 1005, penalty: '+2', scramble: 'R', comment: 'close', createdAt: iso(1650000000000) },
      { timeMs: 7500, penalty: 'DNF', scramble: 'U', comment: null, createdAt: iso(1650000001000) },
    ]);
  });
});

describe('DCTimer text export', () => {
  it('reads numbered sessions, +2 and DNF flags, comments and local dates', () => {
    const file = [
      '1',
      '12345\t0\t1\tR U\t2014-01-02 03:04:05\t',
      '13000\t1\t1\tF\t2014-01-02 03:05:00\tgood',
      '',
      '9000\t1\t0\tU\t2014-01-03 00:00:00\t',
      'not\ta\tsolve',
      '2',
      '8000.9\t0\t1\tD\t2014-01-04 00:00:00\t\textra\tfields',
      '0\t0\t1\tB\t2014-01-04 00:00:00\t',
    ].join('\r\n');
    const r = parseTimerFile(file);
    expect(r.format).toBe('DCTimer');
    expect(summary(r)).toEqual([
      ['1', '333', [[12345, 'OK'], [13000, '+2'], [9000, 'DNF']]],
      ['2', '333', [[8000, 'OK']]],
    ]);
    expect(r.sessions[0].solves.map((x) => x.comment)).toEqual([null, 'good', null]);
    expect(r.sessions[0].solves[0]).toMatchObject({ scramble: 'R U', createdAt: local(2014, 1, 2, 3, 4, 5) });
    expect(r.skipped).toEqual({ multiBlind: 0, invalid: 1 });
  });

  it('is only recognised with a session number on the first line', () => {
    expect(() => parseTimerFile('12345\t0\t1\tR U\t2014-01-02 03:04:05\t\n')).toThrow(TimerFormatError);
  });
});

describe('DCTimer SQLite backup', () => {
  it('reads sessiontb names and resultstb rows by 0-based session id, with flags, comments and local dates', () => {
    const bytes = sqliteBytes((db) => {
      db.exec(DCTIMER_SCHEMA.sessiontb);
      db.exec(DCTIMER_SCHEMA.resultstb);
      db.exec("INSERT INTO sessiontb VALUES (0, 'main'), (1, 'OH')");
      const ins = db.prepare('INSERT INTO resultstb (sid, rtime, p1, p2, scr, time, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
      ins.run(1, 20000, 0, 0, 'U', '2015-03-03 08:00:00', 'dnf');
      ins.run(0, 12345, 0, 1, "R U R'", '2015-03-02 12:01:07', '');
      ins.run(0, 13000, 1, 1, 'F2', '2015-03-02 12:02:00', 'plus two');
      ins.run(1, 21000, 1, 0, 'D', '2015-03-03 08:01:00', null); // DNF wins over +2
    });
    const r = parseTimerFile(bytes);
    expect(r.format).toBe('DCTimer (SQLite backup)');
    expect(summary(r)).toEqual([
      ['main', '333', [[12345, 'OK'], [13000, '+2']]],
      ['OH', '333', [[20000, 'DNF'], [21000, 'DNF']]],
    ]);
    expect(r.sessions[0].solves[0]).toEqual({ timeMs: 12345, penalty: 'OK', scramble: "R U R'", comment: null, createdAt: local(2015, 3, 2, 12, 1, 7) });
    expect(r.sessions[0].solves[1].comment).toBe('plus two');
    expect(r.sessions[1].sourceType).toBe('DCTimer');
  });

  it('reads the old layout: resulttb is session 1 and result<N> session N, named by number without sessiontb', () => {
    const bytes = sqliteBytes((db) => {
      db.exec(DCTIMER_SCHEMA.oldResults('resulttb'));
      db.exec(DCTIMER_SCHEMA.oldResults('result3'));
      db.exec("INSERT INTO resulttb (rtime, p1, p2, scr, time, note) VALUES (9000, 0, 1, 'R', '2014-12-31 23:59:59', 'old layout')");
      db.exec("INSERT INTO result3 (rtime, p1, p2, scr, time, note) VALUES (15000, 1, 1, 'U', '2015-01-01 00:00:00', NULL)");
    });
    const r = parseTimerFile(bytes);
    expect(summary(r)).toEqual([
      ['1', '333', [[9000, 'OK']]],
      ['3', '333', [[15000, '+2']]],
    ]);
    expect(r.sessions[0].solves[0]).toMatchObject({ comment: 'old layout', createdAt: local(2014, 12, 31, 23, 59, 59) });
  });

  it('names a session by its number when sessiontb has no name for it', () => {
    const bytes = sqliteBytes((db) => {
      db.exec(DCTIMER_SCHEMA.sessiontb);
      db.exec(DCTIMER_SCHEMA.resultstb);
      db.exec("INSERT INTO sessiontb VALUES (0, ''), (1, NULL), (2, 'named')");
      for (const sid of [0, 1, 2, 4]) db.exec(`INSERT INTO resultstb (sid, rtime, p1, p2, scr, time, note) VALUES (${sid}, 5000, 0, 1, 'x', '2015-01-01 00:00:00', '')`);
    });
    expect(parseTimerFile(bytes).sessions.map((s) => s.name)).toEqual(['1', '2', 'named', '5']);
  });

  it('truncates a fractional time to whole ms and skips unusable ones', () => {
    const bytes = sqliteBytes((db) => {
      db.exec('CREATE TABLE resultstb (id INTEGER PRIMARY KEY, sid INTEGER, rtime REAL, p1 INTEGER, p2 INTEGER, scr TEXT, time TEXT, note TEXT)');
      db.exec("INSERT INTO resultstb (sid, rtime, p1, p2, scr, time, note) VALUES (0, 12345.9, 0, 1, 'x', 'N/A', ''), (0, 0, 0, 1, 'y', '', ''), (0, -5, 0, 1, 'z', '', '')");
    });
    const r = parseTimerFile(bytes);
    expect(summary(r)).toEqual([['1', '333', [[12345, 'OK']]]]);
    expect(r.sessions[0].solves[0].createdAt).toBe(EPOCH);
    expect(r.skipped.invalid).toBe(2);
  });

  it('says there is nothing to import in an SQLite file without DCTimer tables', () => {
    const bytes = sqliteBytes((db) => db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES ('hi')"));
    const err = thrown(() => parseTimerFile(bytes));
    expect(err).toBeInstanceOf(TimerFormatError);
    expect(err.message).toBe('This DCTimer (SQLite backup) file has no solves cubr can import.');
  });

  it('reports a damaged backup instead of importing part of it', () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/dctimer-backup.db', import.meta.url)));
    expect(() => parseTimerFile(bytes.subarray(0, 512))).toThrow(SqliteFormatError);
    expect(() => parseTimerFile(bytes.subarray(0, bytes.length - 1024))).toThrow(SqliteFormatError);
  });

  it('needs the bytes: the same backup passed as text is not a supported export', () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/dctimer-backup.db', import.meta.url)));
    expect(() => parseTimerFile(new TextDecoder('latin1').decode(bytes))).toThrow(/isn't an export cubr can read/);
  });
});

describe("mateus' Cubetimer", () => {
  it.each([
    ['3x3x3', '333'], ['2x2x2', '222'], ['4x4x4', '444'], ['5x5x5', '555'], ['6x6x6', '666'], ['7x7x7', '777'],
    ['Pyraminx', 'pyram'], ['Skewb', 'skewb'], ['Megaminx', 'minx'], ['Square-1', 'sq1'], ["Rubik's Clock", 'clock'],
    ['3x3x3 Blindfolded', '333bf'], ['4x4x4 Blindfolded', '444bf'], ['5x5x5 Blindfolded', '555bf'],
    ['3x3x3 One-Handed', '333oh'], ['3x3x3 With Feet', '333'], ['3x3x3 Fewest Moves', '333fm'], ['Kilominx', '333'],
  ])('category %s is event %s', (category, event) => {
    const r = parseTimerFile(mateus([category, '00:05.000', 'x', '2019-05-06 07:08', 'no', 'no', '1']));
    expect(r.sessions[0]).toMatchObject({ name: `${category}-1`, event, sourceType: category });
  });

  it('reads MM:SS.SSS and H:MM:SS.SSS times, DNF over +2, local dates; no comments', () => {
    const r = parseTimerFile(
      mateus(
        ['5x5x5', '01:30.125', 'Rw', '2019-05-06 07:08', 'no', 'no', 'A'],
        ['5x5x5', '1:00:00.000', 'Uw', '2019-05-06 08:09', 'yes', 'no', 'A'],
        ['5x5x5', '02:00.000', 'Fw', '2019-05-06 09:10', 'yes', 'yes', 'A'],
        ['5x5x5', 'abc', 'Bw', '2019-05-06 09:11', 'no', 'no', 'A'],
        ['5x5x5', '02:00.000', 'too few fields'],
      ),
    );
    expect(summary(r)).toEqual([['5x5x5-A', '555', [[90125, 'OK'], [3600000, '+2'], [120000, 'DNF']]]]);
    expect(r.sessions[0].solves[0]).toEqual({ timeMs: 90125, penalty: 'OK', scramble: 'Rw', comment: null, createdAt: local(2019, 5, 6, 7, 8) });
    expect(r.skipped.invalid).toBe(1);
  });

  it('makes a session per category and section and leaves out multi-blind', () => {
    const r = parseTimerFile(
      mateus(
        ['3x3x3', '00:10.000', 'a', '2019-05-06 07:08', 'no', 'no', '1'],
        ['3x3x3 Multi-Blindfolded', '30:00.000', 'b', '2019-05-06 07:08', 'no', 'no', '1'],
        ['3x3x3', '00:11.000', 'c', '2019-05-06 07:09', 'no', 'no', '2'],
        ['3x3x3', '00:12.000', 'd', '2019-05-06 07:10', 'no', 'no', '1'],
      ),
    );
    expect(summary(r)).toEqual([
      ['3x3x3-1', '333', [[10000, 'OK'], [12000, 'OK']]],
      ['3x3x3-2', '333', [[11000, 'OK']]],
    ]);
    expect(r.skipped.multiBlind).toBe(1);
  });
});

describe('GAN CubeStation', () => {
  it('makes a session per league, and per local month for solves outside a league', () => {
    const jan = new Date(2024, 0, 15, 12).getTime();
    const feb = new Date(2024, 1, 20, 12).getTime();
    const r = parseTimerFile(
      JSON.stringify({
        code: 200,
        data: {
          data: [
            { startTime: jan / 1000, duration: 8000, scramble: 'R', normalScore: 1 },
            { startTime: feb, duration: 9000, scramble: 'U', normalScore: 1 }, // ms timestamps are tolerated
            { startTime: feb / 1000, duration: 7000, scramble: 'F', normalScore: 1, leagueId: 42 },
            null,
            { startTime: jan / 1000 + 60, duration: 6000, scramble: 'B', normalScore: 0 },
          ],
        },
      }),
    );
    expect(summary(r)).toEqual([
      ['2024-01', '333', [[8000, 'OK'], [6000, 'DNF']]],
      ['2024-02', '333', [[9000, 'OK']]],
      ['League42', '333', [[7000, 'OK']]],
    ]);
    expect(r.sessions[1].solves[0].createdAt).toBe(iso(feb));
    expect(r.sessions.every((s) => s.sourceType === 'GAN')).toBe(true);
  });

  it('keeps a DNF attempt without a duration and skips a solve with no duration at all', () => {
    const r = parseTimerFile(JSON.stringify({ code: 200, data: { data: [{ startTime: 1700000000, duration: 0, normalScore: 0 }, { startTime: 1700000000, normalScore: 1 }, { startTime: 1700000000, duration: 5000, normalScore: 1 }] } }));
    expect(r.sessions[0].solves.map((x) => x.penalty)).toEqual(['DNF', 'OK']);
    expect(r.skipped.invalid).toBe(1);
  });

  it('skips a finished solve of 0 ms instead of importing a 0.001 s single', () => {
    const r = parseTimerFile(JSON.stringify({ code: 200, data: { data: [{ startTime: 1700000000, duration: 0, normalScore: 1 }, { startTime: 1700000060, duration: 8000, normalScore: 1 }] } }));
    expect(r.sessions[0].solves.map((x) => x.timeMs)).toEqual([8000]);
    expect(r.skipped.invalid).toBe(1);
  });

  it('is only recognised with code 200', () => {
    expect(() => parseTimerFile(JSON.stringify({ code: 500, data: { data: [{ startTime: 1, duration: 5000, normalScore: 1 }] } }))).toThrow(/isn't an export/);
  });
});

describe('cubr export', () => {
  const file = (sessions: unknown[]) => JSON.stringify({ exportedAt: '2026-11-16T00:00:00.000Z', sessions });

  it('falls back to 3x3 for an unknown event, OK for an unknown penalty and the epoch for a bad date', () => {
    const r = parseTimerFile(file([{ name: 'odd', event: '333mbf', solves: [{ timeMs: '9000', penalty: 'X', scramble: 'R', comment: '  hi ', createdAt: 'garbage' }] }]));
    expect(r.sessions[0]).toEqual({ name: 'odd', event: '333', sourceType: '333', solves: [{ timeMs: 9000, penalty: 'OK', scramble: 'R', comment: 'hi', createdAt: EPOCH }] });
  });

  it('keeps a practice session only when practice is exactly true, and names a nameless session by its place', () => {
    const solves = [{ timeMs: 5000, penalty: 'OK', scramble: '', comment: null, createdAt: '2026-01-01T00:00:00Z' }];
    const r = parseTimerFile(file([{ name: 'a', event: '333', practice: 'true', solves }, { event: '222', practice: true, solves }]));
    expect(r.sessions.map((s) => [s.name, s.event, s.practice ?? false])).toEqual([['a', '333', false], ['import 2', '222', true]]);
  });

  it('is not mistaken for a list of sessions without solves, and an empty export has nothing to import', () => {
    expect(() => parseTimerFile(JSON.stringify({ sessions: [{ name: 'x' }] }))).toThrow(/isn't an export cubr can read/);
    expect(thrown(() => parseTimerFile(file([]))).message).toBe('This cubr file has no solves cubr can import.');
  });
});

describe('csTimer export of cubr sessions', () => {
  it.each(EVENT_IDS)('a %s session keeps its event through a csTimer file', (event) => {
    const r = parseTimerFile(toCsTimerExport([{ name: `s ${event}`, event, solves: [{ timeMs: 1234, penalty: 'OK', scramble: 'x', comment: null, createdAt: '2026-01-01T00:00:00.000Z' }] }]));
    expect(r.sessions[0]).toMatchObject({ name: `s ${event}`, event });
  });

  it('writes solves oldest first and keeps penalties, raw times, comments and whole-second dates', () => {
    const file = toCsTimerExport([
      {
        name: 'main',
        event: '333',
        solves: [
          { timeMs: 3000, penalty: 'DNF', scramble: 'c', comment: 'multi\nline; "quoted"', createdAt: '2026-01-03T00:00:00.000Z' },
          { timeMs: 1000, penalty: 'OK', scramble: 'a', comment: null, createdAt: '2026-01-01T00:00:00.400Z' },
          { timeMs: 2000, penalty: '+2', scramble: 'b', comment: '', createdAt: '2026-01-02T00:00:00.600Z' },
        ],
      },
    ]);
    const r = parseTimerFile(file);
    expect(r.sessions[0].solves).toEqual([
      { timeMs: 1000, penalty: 'OK', scramble: 'a', comment: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { timeMs: 2000, penalty: '+2', scramble: 'b', comment: null, createdAt: '2026-01-02T00:00:01.000Z' },
      { timeMs: 3000, penalty: 'DNF', scramble: 'c', comment: 'multi\nline; "quoted"', createdAt: '2026-01-03T00:00:00.000Z' },
    ]);
  });

  it('writes a solve without a valid date as time 0, which reads back as the epoch', () => {
    const file = toCsTimerExport([{ name: 'm', event: '333', solves: [{ timeMs: 2000, penalty: 'OK', scramble: 'b', comment: null, createdAt: 'not a date' }] }]);
    expect(JSON.parse(file).session1[0][3]).toBe(0);
    expect(parseTimerFile(file).sessions[0].solves[0].createdAt).toBe(EPOCH);
  });

  it('writes one empty "cubr" session when there is nothing to export (csTimer needs session1)', () => {
    const file = toCsTimerExport([]);
    expect(file.startsWith('{"session1":[]')).toBe(true);
    expect(JSON.parse(JSON.parse(file).properties.sessionData)).toEqual({ 1: { name: 'cubr', opt: {}, rank: 1 } });
    expect(thrown(() => parseTimerFile(file)).message).toBe('This csTimer file has no solves cubr can import.');
  });
});

describe('unsupported, empty and multi-blind-only files', () => {
  const unsupportedMessage = `This file isn't an export cubr can read. Supported: ${IMPORT_FORMATS.join(', ')}.`;

  it.each([
    ['an empty file', ''],
    ['whitespace', '  \n\t '],
    ['plain text', 'hello world'],
    ['invalid JSON', '{"session1": [}'],
    ['a JSON array', '[{"session1": []}]'],
    ['JSON null', 'null'],
    ['JSON of no known shape', '{"puzzles": "nope", "code": 500, "data": {}}'],
    ['a CSV with another header', 'Date,Time\n2020-01-01,9.00'],
    ['a ZYXTimer-like file', 'Session: 1\n9.00'],
  ])('names the supported formats for %s', (_label, text) => {
    const err = thrown(() => parseTimerFile(text));
    expect(err).toBeInstanceOf(TimerFormatError);
    expect(err).toBeInstanceOf(CsTimerFormatError);
    expect(err.message).toBe(unsupportedMessage);
  });

  it('names the supported formats for empty or binary bytes', () => {
    expect(thrown(() => parseTimerFile(new Uint8Array(0))).message).toBe(unsupportedMessage);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(0)]);
    expect(thrown(() => parseTimerFile(png)).message).toBe(unsupportedMessage);
  });

  it.each([
    ['cubr', '{"sessions": []}'],
    ['csTimer', '{"session1": [], "session2": [[[0, 0], "x", "", 1]]}'],
    ['csTimer (CSV)', 'No.;Time;Comment;Scramble;Date;P.1\n'],
    ['Twisty Timer', `${TWISTY_HEADER}\n`],
    ['Cubic Timer', CUBIC_HEADER],
    ['Block Keeper', '{"puzzles": []}'],
    ['CubeDesk', '{"sessions": [], "solves": []}'],
    ['DCTimer', '1\n0\t0\t1\tR\t2014-01-01 00:00:00\t'],
    ['mateus Cubetimer', MATEUS_HEADER],
    ['GAN CubeStation', '{"code": 200, "data": {"data": []}}'],
  ])('a %s file with no usable solves says so', (format, text) => {
    const err = thrown(() => parseTimerFile(text));
    expect(err).toBeInstanceOf(TimerFormatError);
    expect(err.message).toBe(`This ${format} file has no solves cubr can import.`);
  });

  it.each([
    ['Twisty Timer', twisty(['333mbld', 'Normal', '995003600000', '1546301100000', 'x', '0', ''])],
    ['csTimer', csTimer({ session1: [[[0, 1], 'x', '', 1]] }, { 1: { opt: { scrType: 'r3ni' } } })],
    ['mateus Cubetimer', mateus(['3x3x3 Multi-Blindfolded', '30:00.000', 'x', '2019-05-06 07:08', 'no', 'no', '1'])],
  ])('a %s file with only multi-blind attempts says they are not supported', (format, text) => {
    expect(thrown(() => parseTimerFile(text)).message).toBe(`This ${format} file has no solves cubr can import (multi-blind attempts are not supported).`);
  });
});

describe('parsing helpers', () => {
  it.each([
    ['DNF (12.34)', 12_340, 'DNF'],
    ['dnf(1:02.34)', 62_340, 'DNF'],
    ['12.34 +2', 12_340, '+2'],
    ['1:00:00', 3_600_000, 'OK'],
    [' 9.5 ', 9500, 'OK'],
    [':12.34', 12_340, 'OK'],
  ] as const)('parseTimeString reads %j as %i ms %s', (text, ms, penalty) => {
    expect(parseTimeString(text)).toEqual({ ms, penalty });
  });

  it.each(['+', '12.', '.5', '-5', '12,34', '1:2:3:4', 'DNF(abc)', 'N/A'])('parseTimeString cannot read %j', (text) => {
    expect(parseTimeString(text)).toBeNull();
  });

  it('readDelimited handles CR-only line endings, empty fields, quotes inside a field and an unclosed quote', () => {
    expect(readDelimited('a;b\rc;d\r', ';')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(readDelimited(';;\n', ';')).toEqual([['', '', '']]);
    expect(readDelimited('say "hi";x', ';')).toEqual([['say "hi"', 'x']]);
    expect(readDelimited('"open;still\nopen', ';')).toEqual([['open;still\nopen']]);
    expect(readDelimited('', ';')).toEqual([]);
  });

  it('parseLocalDateTime reads only "YYYY-MM-DD hh:mm[:ss]" text', () => {
    expect(parseLocalDateTime('  2015-03-01   10:20  ')).toBe(new Date(2015, 2, 1, 10, 20).getTime());
    for (const v of ['2015-03-01T10:20:30', '2015-03-01', '', 1425205230, null, undefined, new Uint8Array(3)]) expect(parseLocalDateTime(v)).toBeNull();
  });
});
