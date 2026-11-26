import type { Penalty } from './averages.js';
import { CsTimerFormatError, csTimerSessions, eventForScrType } from './cstimer.js';
import { isEventId } from './events.js';
import { finishImport, type ImportedSession, type ImportSkipped, type RawSession, type RawSolve } from './importCommon.js';
import { isSqliteFile, readSqliteTables, type SqlValue } from './sqlite.js';

/**
 * Reads a solve export from cubr itself or from any timer whose files csTimer's
 * "Import session(s) from other timers" understands (csTimer src/js/lib/tdconverter.js):
 * csTimer (JSON and session CSV), Twisty Timer, Cubic Timer, Block Keeper, DCTimer (text export
 * and SQLite backup), mateus' Cubetimer, CubeDesk and GAN CubeStation. The field layouts follow
 * csTimer's converter; the code is cubr's own. csTimer also recognises ZYXTimer and
 * PrismaTimer files but imports nothing from them, so neither is supported here.
 */

export class TimerFormatError extends CsTimerFormatError {}

export interface TimerImport {
  /** The detected format, e.g. "Twisty Timer". */
  format: string;
  sessions: ImportedSession[];
  skipped: ImportSkipped;
}

export const IMPORT_FORMATS = [
  'cubr',
  'csTimer',
  'Twisty Timer',
  'Cubic Timer',
  'Block Keeper',
  'CubeDesk',
  'DCTimer',
  'mateus Cubetimer',
  'GAN CubeStation',
] as const;

/** Detects the format of an export file and reads its sessions. Bytes are needed for DCTimer's SQLite backup. */
export function parseTimerFile(input: Uint8Array | string): TimerImport {
  let format: string;
  let raw: RawSession[];
  if (typeof input !== 'string' && isSqliteFile(input)) {
    format = 'DCTimer (SQLite backup)';
    raw = dcTimerSqlite(input);
  } else {
    const text = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : decodeText(input);
    [format, raw] = detect(text);
  }
  const { sessions, skipped } = finishImport(raw);
  if (!sessions.length) {
    const why = skipped.multiBlind ? ' (multi-blind attempts are not supported)' : '';
    throw new TimerFormatError(`This ${format} file has no solves cubr can import${why}.`);
  }
  return { format, sessions, skipped };
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

const unsupported = (): never => {
  throw new TimerFormatError(`This file isn't an export cubr can read. Supported: ${IMPORT_FORMATS.join(', ')}.`);
};

function detect(text: string): [string, RawSession[]] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    let root: unknown;
    try {
      root = JSON.parse(trimmed);
    } catch {
      return unsupported();
    }
    if (!root || typeof root !== 'object' || Array.isArray(root)) return unsupported();
    const obj = root as Record<string, unknown>;
    const data = obj.data as Record<string, unknown> | undefined;
    if (Array.isArray(obj.sessions) && !Array.isArray(obj.solves) && obj.sessions.every((s) => s && Array.isArray((s as { solves?: unknown }).solves))) {
      return ['cubr', cubr(obj.sessions)];
    }
    if (Array.isArray(obj.sessions) && Array.isArray(obj.solves)) return ['CubeDesk', cubeDesk(obj)];
    if (Object.keys(obj).some((k) => /^session\d+$/.test(k))) return ['csTimer', csTimerSessions(obj)];
    if (Array.isArray(obj.puzzles)) return ['Block Keeper', blockKeeper(obj.puzzles)];
    if (obj.code === 200 && data && Array.isArray(data.data)) return ['GAN CubeStation', ganCubeStation(data.data)];
    return unsupported();
  }
  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  if (/^No\.;Time;Comment;Scramble;Date/i.test(firstLine)) return ['csTimer (CSV)', csTimerCsv(trimmed)];
  if (/^Puzzle,Category,Time\(millis\),Date\(millis\),Scramble,Penalty,Comment/i.test(firstLine)) return ['Twisty Timer', twistyTimer(trimmed, true)];
  if (/^"Puzzle";"Category";"Time\(millis\)";"Date\(millis\)";"Scramble";"Penalty";"Comment"/i.test(firstLine))
    return ['Cubic Timer', twistyTimer(trimmed, false)];
  if (/^"Category";"Time \(MM:SS\.SSS\)";"Scrambler";"Date";"Penalty \+2 \(yes or no\)";"DNF \(yes or no\)";"Section"/i.test(firstLine)) {
    return ['mateus Cubetimer', mateus(trimmed)];
  }
  if (/^\d+\r?\n[^\n]*(\t[^\t\n]*){5}/.test(trimmed)) return ['DCTimer', dcTimerText(trimmed)];
  return unsupported();
}

// ---------------------------------------------------------------- shared parsing helpers

/** Delimiter-separated values with "quoted" fields ("" = a quote; delimiters and newlines allowed inside quotes). */
export function readDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

/** "12.34", "1:23.45", "1:02:03.4", "DNF", "DNF(12.34)", "14.34+" -> ms and penalty (null if unreadable). */
export function parseTimeString(s: string): { ms: number; penalty: Penalty } | null {
  let t = s.trim();
  let penalty: Penalty = 'OK';
  const dnf = /^DNF\s*(?:\((.*)\))?$/i.exec(t);
  if (dnf) {
    penalty = 'DNF';
    t = (dnf[1] ?? '').trim();
    if (!t) return { ms: NaN, penalty };
  } else if (/\+2?$/.test(t)) {
    penalty = '+2';
    t = t.replace(/\+2?$/, '').trimEnd(); // not /\s*\+2?$/, whose time grows with the square of a run of spaces
  }
  const parts = t.split(':');
  if (parts.length > 3 || !parts.every((p) => /^\d+(\.\d+)?$/.test(p) || (p === '' && parts.length > 1))) return null;
  const nums = parts.map((p) => Number(p || 0));
  const [h, m, sec] = [0, 0, 0, ...nums].slice(-3);
  return { ms: Math.round(((h * 60 + m) * 60 + sec) * 1000), penalty };
}

/** "YYYY-MM-DD hh:mm[:ss]" in local time -> epoch ms (null if unreadable), like csTimer. */
export function parseLocalDateTime(s: string | SqlValue | undefined): number | null {
  if (typeof s !== 'string') return null;
  const m = /^\s*(\d+)-(\d+)-(\d+)\s+(\d+):(\d+)(?::(\d+))?\s*$/.exec(s);
  if (!m) return null;
  const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime();
  return Number.isFinite(at) ? at : null;
}

/** Groups solves into sessions by key, keeping first-seen order. */
class Grouper {
  private byKey = new Map<string, RawSession>();
  session(key: string, init: () => Omit<RawSession, 'solves'>): RawSession {
    let s = this.byKey.get(key);
    if (!s) {
      s = { ...init(), solves: [] };
      this.byKey.set(key, s);
    }
    return s;
  }
  get sessions(): RawSession[] {
    return [...this.byKey.values()];
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

// ---------------------------------------------------------------- cubr

function cubr(sessions: unknown[]): RawSession[] {
  return sessions.map((raw) => {
    const s = raw as { name?: unknown; event?: unknown; practice?: unknown; solves: Record<string, unknown>[] };
    const event = typeof s.event === 'string' && isEventId(s.event) ? s.event : '333';
    return {
      name: s.name,
      event,
      sourceType: event,
      practice: s.practice === true,
      solves: s.solves.map((x) => ({
        timeMs: Number(x.timeMs),
        penalty: x.penalty === '+2' || x.penalty === 'DNF' ? x.penalty : 'OK',
        scramble: x.scramble,
        comment: x.comment,
        at: Date.parse(str(x.createdAt)),
      })),
    };
  });
}

// ---------------------------------------------------------------- csTimer session CSV ("export to CSV" in a session's stats)

// No.;Time;Comment;Scramble;Date;P.1[;P.2...] - Time is shown with the penalty ("14.34+", "DNF(12.34)"),
// the P.n phase columns hold the raw time (P.1 = the only phase, or the last one of a multi-phase solve).
function csTimerCsv(text: string): RawSession[] {
  const solves: RawSolve[] = [];
  for (const row of readDelimited(text, ';').slice(1)) {
    const shown = parseTimeString(row[1] ?? '');
    if (!shown) continue;
    const phases = row
      .slice(5)
      .filter((p) => p.trim() !== '')
      .map((p) => parseTimeString(p));
    const raw =
      phases.length && phases.every((p) => p !== null && Number.isFinite(p.ms))
        ? phases.reduce((a, p) => a + (p as { ms: number }).ms, 0)
        : shown.ms - (shown.penalty === '+2' ? 2000 : 0);
    solves.push({ timeMs: raw, penalty: shown.penalty, scramble: row[3], comment: row[2], at: parseLocalDateTime(row[4]) });
  }
  return [{ name: 'csTimer CSV', event: '333', sourceType: 'csTimer CSV', solves }];
}

// ---------------------------------------------------------------- Twisty Timer / Cubic Timer backup

// Header "Puzzle,Category,Time(millis),Date(millis),Scramble,Penalty,Comment" (Cubic Timer: quoted and
// ;-separated); rows are ;-separated: puzzle;category;timeMs;dateMs;scramble;penalty(0/1=+2/2=DNF);comment.
const TWISTY_EVENTS: Record<string, string | null> = {
  '333': '333',
  '222': '222',
  '444': '444',
  '555': '555',
  '666': '666',
  '777': '777',
  pyra: 'pyram',
  skewb: 'skewb',
  mega: 'minx',
  sq1: 'sq1',
  clock: 'clock',
  '333oh': '333oh',
  '333bld': '333bf',
  '444bld': '444bf',
  '555bld': '555bf',
  '333mbld': null,
  '333fmc': '333fm',
};

/**
 * `plusTwoIncluded`: Twisty Timer adds the 2 s of a +2 to the solve's stored time
 * (PuzzleUtils.applyPenalty) and its backup writes that time as is, so it comes off here: cubr
 * keeps the time without the penalty. (Cubic Timer: no such evidence, read as is.)
 */
function twistyTimer(text: string, plusTwoIncluded: boolean): RawSession[] {
  const groups = new Grouper();
  for (const row of readDelimited(text, ';').slice(1)) {
    if (row.length !== 7) continue;
    const [puzzle, category, time, date, scramble, penalty, comment] = row;
    const session = groups.session(`${puzzle}-${category}`, () => ({
      name: `${puzzle}-${category}`,
      event: puzzle in TWISTY_EVENTS ? TWISTY_EVENTS[puzzle] : '333',
      sourceType: puzzle,
    }));
    const plusTwo = penalty === '1';
    session.solves.push({
      // a +2 stored at under 2 s is broken: it comes out below 1 ms and is skipped as invalid
      timeMs: parseInt(time, 10) - (plusTwo && plusTwoIncluded ? 2000 : 0),
      penalty: plusTwo ? '+2' : penalty === '2' ? 'DNF' : 'OK',
      scramble,
      comment,
      at: Number(date),
    });
  }
  return groups.sessions;
}

// ---------------------------------------------------------------- Block Keeper

const BLOCK_KEEPER_EVENTS: Record<string, string> = {
  '3x3x3': '333',
  '2x2x2': '222',
  '4x4x4': '444',
  '5x5x5': '555',
  '6x6x6': '666',
  '7x7x7': '777',
  Pyraminx: 'pyram',
  Skewb: 'skewb',
  Megaminx: 'minx',
  'Square-1': 'sq1',
  Clock: 'clock',
  '3x3x3 BLD': '333bf',
  '4x4x4 BLD': '444bf',
  '5x5x5 BLD': '555bf',
};

// { puzzles: [{ name, scrambler, sessions: [{ name, records: [{ time (s), result: OK|+2|DNF, scramble, comment, date (ms) }] }] }] }
function blockKeeper(puzzles: unknown[]): RawSession[] {
  const out: RawSession[] = [];
  for (const p of puzzles as { name?: unknown; scrambler?: unknown; sessions?: unknown }[]) {
    if (!p || !Array.isArray(p.sessions)) continue;
    for (const s of p.sessions as { name?: unknown; records?: unknown }[]) {
      if (!s || !Array.isArray(s.records)) continue;
      out.push({
        name: `${str(p.name)}-${str(s.name)}`,
        event: BLOCK_KEEPER_EVENTS[str(p.scrambler)] ?? '333',
        sourceType: str(p.scrambler),
        solves: (s.records as Record<string, unknown>[]).map((r) => ({
          timeMs: Number(r.time) * 1000,
          penalty: r.result === '+2' ? '+2' : r.result === 'DNF' ? 'DNF' : 'OK',
          scramble: r.scramble,
          comment: r.comment,
          at: Number(r.date),
        })),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- DCTimer

// Text export: a line with just a session number starts a session; each solve line is
// tab-separated: timeMs, +2 flag, valid flag (0 = DNF), scramble, "YYYY-MM-DD hh:mm:ss", comment, ...
function dcTimerText(text: string): RawSession[] {
  const out: RawSession[] = [];
  let current: RawSession | null = null;
  for (const line of text.split(/[\r\n]+/)) {
    if (/^\d+$/.test(line.trim())) {
      current = { name: line.trim(), event: '333', sourceType: 'DCTimer', solves: [] };
      out.push(current);
      continue;
    }
    const f = line.split('\t');
    if (f.length < 6) continue;
    if (!current) {
      current = { name: '1', event: '333', sourceType: 'DCTimer', solves: [] };
      out.push(current);
    }
    current.solves.push(dcSolve(f[0], f[1], f[2], f[3], f[4], f[5]));
  }
  return out;
}

function dcSolve(time: unknown, plusTwo: unknown, valid: unknown, scramble: unknown, date: unknown, comment: unknown): RawSolve {
  return {
    timeMs: Math.trunc(Number(time)),
    penalty: str(valid) === '1' ? (str(plusTwo) === '1' ? '+2' : 'OK') : 'DNF',
    scramble,
    comment,
    at: parseLocalDateTime(str(date)),
  };
}

// SQLite backup: sessiontb (id, name); results in resultstb (id, session, time, +2, valid, scramble,
// date, comment), or in older versions resulttb (session 1) / result<N> (session N): (id, time, +2,
// valid, scramble, date, comment). Session ids are 0-based.
function dcTimerSqlite(bytes: Uint8Array): RawSession[] {
  const tables = readSqliteTables(bytes);
  const bySession = new Map<number, RawSession>();
  const session = (sid: number, name?: unknown): RawSession => {
    let s = bySession.get(sid);
    if (!s) {
      s = { name: name ? str(name) : String(sid + 1), event: '333', sourceType: 'DCTimer', solves: [] };
      bySession.set(sid, s);
    }
    return s;
  };
  for (const [id, name] of tables.get('sessiontb') ?? []) session(Number(id), name);
  for (const [table, rows] of tables) {
    const m = /^result(\d+|tb)$/.exec(table);
    if (!m) continue;
    const sid = (m[1] === 'tb' ? 1 : Number(m[1])) - 1;
    for (const r of rows) session(sid).solves.push(dcSolve(r[1], r[2], r[3], r[4], r[5], r[6]));
  }
  for (const r of tables.get('resultstb') ?? []) session(Number(r[1])).solves.push(dcSolve(r[2], r[3], r[4], r[5], r[6], r[7]));
  return [...bySession.values()];
}

// ---------------------------------------------------------------- mateus' Cubetimer

const MATEUS_EVENTS: Record<string, string | null> = {
  '3x3x3': '333',
  '2x2x2': '222',
  '4x4x4': '444',
  '5x5x5': '555',
  Pyraminx: 'pyram',
  Skewb: 'skewb',
  Megaminx: 'minx',
  'Square-1': 'sq1',
  "Rubik's Clock": 'clock',
  '6x6x6': '666',
  '7x7x7': '777',
  '3x3x3 Blindfolded': '333bf',
  '4x4x4 Blindfolded': '444bf',
  '5x5x5 Blindfolded': '555bf',
  '3x3x3 One-Handed': '333oh',
  '3x3x3 Multi-Blindfolded': null,
  '3x3x3 With Feet': eventForScrType('333ft'),
  '3x3x3 Fewest Moves': '333fm',
};

// "Category";"Time (MM:SS.SSS)";"Scrambler";"Date";"Penalty +2 (yes or no)";"DNF (yes or no)";"Section"
function mateus(text: string): RawSession[] {
  const groups = new Grouper();
  for (const row of readDelimited(text, ';').slice(1)) {
    if (row.length < 7) continue;
    const [category, time, scramble, date, plusTwo, dnf, section] = row;
    const t = parseTimeString(time);
    const session = groups.session(`${category}-${section}`, () => ({
      name: `${category}-${section}`,
      event: category in MATEUS_EVENTS ? MATEUS_EVENTS[category] : '333',
      sourceType: category,
    }));
    session.solves.push({
      timeMs: t ? t.ms : NaN,
      penalty: dnf === 'yes' ? 'DNF' : plusTwo === 'yes' ? '+2' : 'OK',
      scramble,
      at: parseLocalDateTime(date),
    });
  }
  return groups.sessions;
}

// ---------------------------------------------------------------- CubeDesk

const CUBEDESK_EVENTS: Record<string, string> = {
  '222': '222',
  '333': '333',
  '444': '444',
  '555': '555',
  '666': '666',
  '777': '777',
  pyram: 'pyram',
  skewb: 'skewb',
  minx: 'minx',
  sq1: 'sq1',
  clock: 'clock',
  '333mirror': '333',
  '222oh': '222',
  '333oh': '333oh',
  '333bl': '333bf',
};

// { sessions: [{ id, name, order }], solves: [{ session_id, cube_type, raw_time (s), dnf, plus_two, scramble, notes, started_at (ms) }] }
function cubeDesk(root: Record<string, unknown>): RawSession[] {
  const meta = new Map<string, { name: unknown; order: number }>();
  for (const s of root.sessions as Record<string, unknown>[]) if (s) meta.set(str(s.id), { name: s.name, order: Number(s.order) });
  const groups = new Grouper();
  for (const x of root.solves as Record<string, unknown>[]) {
    if (!x) continue;
    const sid = str(x.session_id);
    const cube = str(x.cube_type);
    const session = groups.session(`${sid}-${cube}`, () => {
      const m = meta.get(sid);
      return {
        name: `${m?.name ? str(m.name) : sid}-${cube}`,
        event: CUBEDESK_EVENTS[cube] ?? '333',
        sourceType: cube,
        rank: m && Number.isFinite(m.order) ? m.order : undefined,
      };
    });
    session.solves.push({
      timeMs: Number(x.raw_time) * 1000,
      penalty: x.dnf ? 'DNF' : x.plus_two ? '+2' : 'OK',
      scramble: x.scramble,
      comment: x.notes,
      at: Number(x.started_at),
    });
  }
  return groups.sessions;
}

// ---------------------------------------------------------------- GAN CubeStation

// { code: 200, data: { data: [{ startTime (s), leagueId, duration (ms), scramble, normalScore }] } }
// One session per league, or per month for solves outside a league; everything is 3x3.
function ganCubeStation(list: unknown[]): RawSession[] {
  const groups = new Grouper();
  for (const raw of list) {
    const x = raw as Record<string, unknown> | null;
    if (!x) continue;
    const start = Number(x.startTime);
    const at = start > 1e12 ? start : start * 1000; // seconds (as csTimer reads it); tolerate ms
    const d = new Date(Number.isFinite(at) ? at : 0);
    const name = x.leagueId ? `League${str(x.leagueId)}` : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const ok = Boolean(x.normalScore);
    groups
      .session(name, () => ({ name, event: '333', sourceType: 'GAN' }))
      .solves.push({
        // a DNF needs no real time; a finished solve of 0 ms is broken data (and would be a 0.001 s
        // "PB"), so it stays below 1 ms and is skipped as invalid
        timeMs: ok ? Number(x.duration) : Math.max(1, Number(x.duration)),
        penalty: ok ? 'OK' : 'DNF',
        scramble: x.scramble,
        at,
      });
  }
  return groups.sessions;
}
