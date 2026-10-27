import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CsTimerFormatError, toCsTimerExport } from '../src/cstimer.js';
import { parseLocalDateTime, parseTimeString, parseTimerFile, readDelimited, TimerFormatError } from '../src/timerImport.js';

const iso = (ms: number) => new Date(ms).toISOString();
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => iso(new Date(y, mo - 1, d, h, mi, s).getTime());

describe('cubetype export', () => {
  const exported = {
    exportedAt: '2026-10-20T10:00:00.000Z',
    sessions: [
      {
        id: 'a', name: 'main', event: '333', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', solveCount: 2,
        solves: [
          { id: '1', sessionId: 'a', event: '333', timeMs: 9876, penalty: 'OK', scramble: "R U R'", comment: null, source: 'timer', createdAt: '2026-10-02T03:04:05.678Z' },
          { id: '2', sessionId: 'a', event: '333', timeMs: 12000, penalty: 'DNF', scramble: 'F2', comment: 'oops', source: 'timer', createdAt: '2026-10-03T00:00:00.000Z' },
        ],
      },
      { id: 'b', name: 'pyra', event: 'pyram', practice: true, createdAt: '', updatedAt: '', solveCount: 1, solves: [{ id: '3', timeMs: 3100, penalty: '+2', scramble: "U L' b", comment: '', createdAt: '2026-10-04T00:00:00.000Z' }] },
    ],
  };

  it('imports its own pretty-printed export (moving data between servers)', () => {
    const r = parseTimerFile(new TextEncoder().encode(JSON.stringify(exported, null, 2)));
    expect(r.format).toBe('cubetype');
    expect(r.sessions.map((s) => [s.name, s.event, s.solves.length])).toEqual([['main', '333', 2], ['pyra', 'pyram', 1]]);
    expect(r.sessions[0].solves[0]).toEqual({ timeMs: 9876, penalty: 'OK', scramble: "R U R'", comment: null, createdAt: '2026-10-02T03:04:05.678Z' });
    expect(r.sessions[0].solves[1]).toMatchObject({ penalty: 'DNF', comment: 'oops' });
    expect(r.sessions[1].solves[0].penalty).toBe('+2');
    // a practice session stays one
    expect(r.sessions.map((s) => s.practice ?? false)).toEqual([false, true]);
  });

  it('exports to a csTimer file that reads back the same', () => {
    const file = toCsTimerExport([...exported.sessions, { name: 'a <b> & "c"', event: '444bf', solves: [{ timeMs: 600000, penalty: 'OK', scramble: 'Rw', comment: null, createdAt: '2026-10-05T00:00:00Z' }] }] as never);
    expect(file.startsWith('{"session1"')).toBe(true); // csTimer's "import from other timers" requires this prefix
    const props = JSON.parse(file).properties;
    expect(props.sessionN).toBe(3);
    expect(JSON.parse(props.sessionData)['3']).toEqual({ name: 'a &lt;b&gt; &amp; &quot;c&quot;', opt: { scrType: '444bld' }, rank: 3 });
    const back = parseTimerFile(file);
    expect(back.format).toBe('csTimer');
    expect(back.sessions.map((s) => [s.name, s.event, s.solves.length])).toEqual([['main', '333', 2], ['pyra', 'pyram', 1], ['a <b> & "c"', '444bf', 1]]);
    // csTimer keeps whole seconds
    expect(back.sessions[0].solves[0]).toEqual({ timeMs: 9876, penalty: 'OK', scramble: "R U R'", comment: null, createdAt: '2026-10-02T03:04:06.000Z' });
    expect(back.sessions[0].solves[1].penalty).toBe('DNF');
    expect(back.sessions[1].solves[0].penalty).toBe('+2');
  });
});

describe('csTimer', () => {
  it('reads sessions and properties stored as JSON strings, the old scr field, and orders by rank', () => {
    const file = JSON.stringify({
      session1: JSON.stringify([[[0, 5000], 'R', '', 1700000000]]),
      session2: [[[0, 7000], 'U', '', 1700000100]],
      session3: [[[0, 1800000], 'R U', '', 1700000200]],
      properties: JSON.stringify({
        sessionData: JSON.stringify({ '1': { name: 'second', scr: 'pyrso', rank: 2 }, '2': { name: 'first', opt: { scrType: 'skbso' }, rank: 1 }, '3': { name: 'mbld', opt: { scrType: 'r3ni' }, rank: 3 } }),
      }),
    });
    const r = parseTimerFile(file);
    expect(r.sessions.map((s) => [s.name, s.event])).toEqual([['first', 'skewb'], ['second', 'pyram']]);
    expect(r.skipped).toEqual({ multiBlind: 1, invalid: 0 });
  });

  it('reads the session CSV export: penalty from Time, raw time from the phase columns', () => {
    const csv = [
      'No.;Time;Comment;Scramble;Date;P.1',
      '1;12.34;;R U R\' U\';2015-03-01 10:20:30;12.34',
      '2;14.50+;"two; parts";F2;2015-03-02 11:00:00;12.50',
      '3;DNF(9.99);;"D2\nL2";2015-03-03 12:00:00;9.99',
      '4;1:02.345;;U;N/A;1:02.345',
    ].join('\r\n');
    const r = parseTimerFile(csv);
    expect(r.format).toBe('csTimer (CSV)');
    const s = r.sessions[0].solves;
    expect(s.map((x) => [x.timeMs, x.penalty])).toEqual([[12340, 'OK'], [12500, '+2'], [9990, 'DNF'], [62345, 'OK']]);
    expect(s[1].comment).toBe('two; parts');
    expect(s[2].scramble).toBe('D2\nL2');
    expect(s[0].createdAt).toBe(local(2015, 3, 1, 10, 20, 30));
    expect(s[3].createdAt).toBe(iso(0)); // csTimer writes N/A for a missing date
  });
});

describe('other timers (csTimer "import from other timers" formats)', () => {
  it('Twisty Timer: comma header, ;-separated rows, penalty codes, multi-blind left out', () => {
    const file = [
      'Puzzle,Category,Time(millis),Date(millis),Scramble,Penalty,Comment',
      '"333";"Normal";"10500";"1546300800000";"R U R\'";"0";""',
      '333;Normal;11000;1546300900000;F;1;nice',
      '"333";"OH";"21000";"1546301000000";"U";"2";""',
      '"333mbld";"Normal";"995003600000";"1546301100000";"x";"0";""',
    ].join('\n');
    const r = parseTimerFile(file);
    expect(r.format).toBe('Twisty Timer');
    expect(r.sessions.map((s) => [s.name, s.event, s.solves.length])).toEqual([['333-Normal', '333', 2], ['333-OH', '333', 1]]);
    expect(r.sessions[0].solves.map((x) => x.penalty)).toEqual(['OK', '+2']);
    expect(r.sessions[1].solves[0].penalty).toBe('DNF');
    expect(r.sessions[0].solves[0].createdAt).toBe(iso(1546300800000));
    expect(r.sessions[0].solves[1].comment).toBe('nice');
    expect(r.skipped.multiBlind).toBe(1);
  });

  it('Cubic Timer: the quoted ;-separated variant', () => {
    const file = '"Puzzle";"Category";"Time(millis)";"Date(millis)";"Scramble";"Penalty";"Comment"\n"pyra";"Normal";"3456";"1600000000000";"U L";"0";""';
    const r = parseTimerFile(file);
    expect(r.format).toBe('Cubic Timer');
    expect(r.sessions[0]).toMatchObject({ name: 'pyra-Normal', event: 'pyram' });
  });

  it('Block Keeper', () => {
    const file = JSON.stringify({
      puzzles: [
        { name: '3x3', scrambler: '3x3x3', splits: 1, sessions: [{ name: 'S1', records: [{ time: 9.876, result: 'OK', split: [], scramble: 'R', comment: 'a', date: 1600000000000 }, { time: 11, result: 'DNF', split: [], scramble: 'U', date: 1600000001000 }] }] },
        { name: 'Sq', scrambler: 'Square-1', splits: 1, sessions: [{ name: 'empty', records: [] }, { name: 'S', records: [{ time: 15.5, result: '+2', split: [], scramble: '(1,0)/', date: 1600000002000 }] }] },
      ],
    });
    const r = parseTimerFile(file);
    expect(r.format).toBe('Block Keeper');
    expect(r.sessions.map((s) => [s.name, s.event, s.solves.map((x) => [x.timeMs, x.penalty])])).toEqual([
      ['3x3-S1', '333', [[9876, 'OK'], [11000, 'DNF']]],
      ['Sq-S', 'sq1', [[15500, '+2']]],
    ]);
  });

  it('DCTimer text export', () => {
    const file = ['1', '12345\t0\t1\tR U\t2014-01-02 03:04:05\t\tx\tx\tx\tx\tx\tx', '13000\t1\t1\tF\t2014-01-02 03:05:00\tgood\tx\tx\tx\tx\tx\tx', '2', '9000\t0\t0\tU\t2014-01-03 00:00:00\t\tx\tx\tx\tx\tx\tx'].join('\n');
    const r = parseTimerFile(file);
    expect(r.format).toBe('DCTimer');
    expect(r.sessions.map((s) => [s.name, s.solves.map((x) => [x.timeMs, x.penalty])])).toEqual([
      ['1', [[12345, 'OK'], [13000, '+2']]],
      ['2', [[9000, 'DNF']]],
    ]);
    expect(r.sessions[0].solves[0].createdAt).toBe(local(2014, 1, 2, 3, 4, 5));
  });

  it('DCTimer SQLite backup (multi-page b-tree, overflow pages, both result layouts)', () => {
    const r = parseTimerFile(new Uint8Array(readFileSync(new URL('./fixtures/dctimer-backup.db', import.meta.url))));
    expect(r.format).toBe('DCTimer (SQLite backup)');
    expect(r.sessions.map((s) => [s.name, s.solves.length])).toEqual([['main', 45], ['caf\u00e9 \u4e09\u9636', 17]]);
    const all = r.sessions.flatMap((s) => s.solves);
    expect(all.filter((x) => x.penalty === 'DNF')).toHaveLength(6);
    expect(all.filter((x) => x.penalty === '+2')).toHaveLength(6);
    expect(all.find((x) => x.timeMs === 4000000)?.scramble).toHaveLength(959);
    expect(all.find((x) => x.comment === 'old layout')).toMatchObject({ timeMs: 65432, createdAt: local(2014, 12, 31, 23, 59, 59) });
    expect(all.find((x) => x.comment === 'pb!')?.timeMs).toBe(9000 + 5 * 37);
  });

  it("mateus' Cubetimer", () => {
    const file = [
      '"Category";"Time (MM:SS.SSS)";"Scrambler";"Date";"Penalty +2 (yes or no)";"DNF (yes or no)";"Section"',
      '"3x3x3 One-Handed";"00:20.250";"R U";"2019-05-06 07:08";"no";"no";"1"',
      '"3x3x3 One-Handed";"00:22.000";"F";"2019-05-06 07:09";"yes";"no";"1"',
      '"Megaminx";"01:05.500";"R++";"2019-05-06 07:10";"no";"yes";"2"',
    ].join('\n');
    const r = parseTimerFile(file);
    expect(r.format).toBe('mateus Cubetimer');
    expect(r.sessions.map((s) => [s.name, s.event, s.solves.map((x) => [x.timeMs, x.penalty])])).toEqual([
      ['3x3x3 One-Handed-1', '333oh', [[20250, 'OK'], [22000, '+2']]],
      ['Megaminx-2', 'minx', [[65500, 'DNF']]],
    ]);
    expect(r.sessions[0].solves[0].createdAt).toBe(local(2019, 5, 6, 7, 8, 0));
  });

  it('CubeDesk: sessions by order, cube types mapped, raw_time in seconds', () => {
    const file = JSON.stringify({
      sessions: [{ id: 's2', name: 'B', order: 1 }, { id: 's1', name: 'A', order: 0 }],
      solves: [
        { session_id: 's2', cube_type: '333bl', raw_time: 45.25, dnf: false, plus_two: true, scramble: 'R', notes: 'bld', started_at: 1650000000000 },
        { session_id: 's1', cube_type: '222', raw_time: 3.1, dnf: true, plus_two: false, scramble: 'U', started_at: 1650000001000 },
      ],
    });
    const r = parseTimerFile(file);
    expect(r.format).toBe('CubeDesk');
    expect(r.sessions.map((s) => [s.name, s.event, s.solves.map((x) => [x.timeMs, x.penalty])])).toEqual([
      ['A-222', '222', [[3100, 'DNF']]],
      ['B-333bl', '333bf', [[45250, '+2']]],
    ]);
  });

  it('GAN CubeStation: seconds timestamps, sessions per league or month', () => {
    const file = JSON.stringify({
      code: 200,
      data: { data: [{ startTime: 1700000000, duration: 8765, scramble: 'R', normalScore: 1, leagueId: 7, reduction: '' }, { startTime: 1700000100, duration: 9000, scramble: 'U', normalScore: 0, reduction: '' }] },
    });
    const r = parseTimerFile(file);
    expect(r.format).toBe('GAN CubeStation');
    const d = new Date(1700000100 * 1000);
    expect(r.sessions.map((s) => [s.name, s.solves.map((x) => [x.timeMs, x.penalty, x.createdAt])])).toEqual([
      ['League7', [[8765, 'OK', iso(1700000000000)]]],
      [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, [[9000, 'DNF', iso(1700000100000)]]],
    ]);
  });
});

describe('limits and errors', () => {
  it('drops solves the server would reject and trims long text', () => {
    const file = JSON.stringify({
      session1: [
        [[0, 0], 'zero', '', 1],
        [[0, 86_400_001], 'over a day', '', 1],
        [[0, 5000], 'x'.repeat(2500), 'c'.repeat(600), 1700000000],
      ],
      properties: { sessionData: JSON.stringify({ '1': { name: 'n'.repeat(60) } }) },
    });
    const r = parseTimerFile(file);
    expect(r.skipped).toEqual({ multiBlind: 0, invalid: 2 });
    const [s] = r.sessions;
    expect(s.name).toHaveLength(40);
    expect(s.solves[0].scramble).toHaveLength(2000);
    expect(s.solves[0].comment).toHaveLength(500);
  });

  it('names the supported formats for an unknown file, and for formats csTimer only recognises', () => {
    for (const junk of ['hello', '{"a":1}', 'Session: 1\nfoo', '[1,2]']) {
      expect(() => parseTimerFile(junk)).toThrow(TimerFormatError);
      expect(() => parseTimerFile(junk)).toThrow(/Supported: cubetype, csTimer, Twisty Timer/);
    }
    expect(new TimerFormatError('x')).toBeInstanceOf(CsTimerFormatError);
  });

  it('reports a file whose only solves are multi-blind', () => {
    const file = 'Puzzle,Category,Time(millis),Date(millis),Scramble,Penalty,Comment\n333mbld;Normal;995003600000;1546301100000;x;0;';
    expect(() => parseTimerFile(file)).toThrow(/no solves cubetype can import \(multi-blind/);
  });

  it('decodes UTF-8 with a BOM and UTF-16 text', () => {
    const csv = 'Puzzle,Category,Time(millis),Date(millis),Scramble,Penalty,Comment\n333;Caf\u00e9;1000;1;R;0;';
    expect(parseTimerFile(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(csv)])).sessions[0].name).toBe('333-Caf\u00e9');
    const utf16 = new Uint8Array(2 + csv.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let i = 0; i < csv.length; i++) utf16[2 + i * 2] = csv.charCodeAt(i) & 0xff, (utf16[3 + i * 2] = csv.charCodeAt(i) >> 8);
    expect(parseTimerFile(utf16).sessions[0].name).toBe('333-Caf\u00e9');
  });
});

describe('helpers', () => {
  it('readDelimited handles quotes, escaped quotes, delimiters and newlines inside quotes', () => {
    expect(readDelimited('a;"b;c";"say ""hi""";"x\ny"\r\n1;2;3;4\n\n', ';')).toEqual([
      ['a', 'b;c', 'say "hi"', 'x\ny'],
      ['1', '2', '3', '4'],
    ]);
  });

  it('parseTimeString', () => {
    expect(parseTimeString('12.34')).toEqual({ ms: 12340, penalty: 'OK' });
    expect(parseTimeString('1:02.5')).toEqual({ ms: 62500, penalty: 'OK' });
    expect(parseTimeString('1:00:00.25')).toEqual({ ms: 3600250, penalty: 'OK' });
    expect(parseTimeString('14.34+')).toEqual({ ms: 14340, penalty: '+2' });
    expect(parseTimeString('DNF(9.99)')).toEqual({ ms: 9990, penalty: 'DNF' });
    expect(parseTimeString('DNF')?.penalty).toBe('DNF');
    expect(parseTimeString('abc')).toBeNull();
    expect(parseTimeString('')).toBeNull();
  });

  it('parseLocalDateTime', () => {
    expect(parseLocalDateTime('2015-03-01 10:20:30')).toBe(new Date(2015, 2, 1, 10, 20, 30).getTime());
    expect(parseLocalDateTime('2019-05-06 07:08')).toBe(new Date(2019, 4, 6, 7, 8).getTime());
    expect(parseLocalDateTime('N/A')).toBeNull();
  });
});
