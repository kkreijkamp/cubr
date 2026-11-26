import type { Penalty } from './averages.js';
import { ALL_EVENTS } from './events.js';
import { escapeHtml, finishImport, unescapeHtml, type ImportedSession, type RawSession, type RawSolve } from './importCommon.js';
import { scrambleTypesFor } from './scrambleTypes.js';

/**
 * csTimer files. A csTimer export (`cstimer_YYYYMMDD_hhmmss.txt`) is one JSON object:
 *   { "session1": [solve, ...], "session2": [...], ..., "properties": { "sessionData": "<JSON string>", ... } }
 * solve = [[penalty, rawMs, ...phaseEnds], scramble, comment, startUnixSeconds, optionalMoves]
 *   penalty: 0 = OK, 2000 = +2, -1 = DNF (raw time is kept even for DNF)
 * sessionData = JSON string: { "1": { "name": "...", "opt": { "scrType": "444wca" }, "rank": 1 }, ... }
 *   (empty opt -> 3x3; names are HTML-escaped). Older files store a session or `properties` as a
 *   JSON string, and an older sessionData entry has `scr` instead of `opt.scrType`.
 */

/** csTimer scramble type -> WCA event id. */
export const CSTIMER_SCRTYPE_TO_EVENT: Record<string, string> = {
  '333': '333',
  '222so': '222',
  '444wca': '444',
  '555wca': '555',
  '666wca': '666',
  '777wca': '777',
  '333oh': '333oh',
  '333ni': '333bf',
  '333fm': '333fm',
  '444bld': '444bf',
  '555bld': '555bf',
  clkwca: 'clock',
  mgmp: 'minx',
  pyrso: 'pyram',
  skbso: 'skewb',
  sqrs: 'sq1',
  ftoso: 'fto',
};

/**
 * The event, and the practice scramble type if it's one, for a csTimer scramble type: "pll" is a
 * 3x3 PLL practice session, "klmso" kilominx, "r234w" the 2-4 relay. Anything else falls back to
 * the best-effort prefix mapping (eventForScrType).
 */
export function scrambleForScrType(scrType: string | undefined): { event: string; scramble?: string } {
  if (!scrType) return { event: '333' };
  const exact = CSTIMER_SCRTYPE_TO_EVENT[scrType];
  if (exact) return { event: exact };
  for (const e of ALL_EVENTS) {
    const i = scrambleTypesFor(e.id).findIndex((t) => t.id === scrType);
    if (i === 0) return { event: e.id };
    if (i > 0) return { event: e.id, scramble: scrType };
  }
  return { event: eventForScrType(scrType) };
}

/** Best-effort mapping for csTimer's many non-WCA scramble types (e.g. "222o", "pyrm", "sq1h"). */
export function eventForScrType(scrType: string | undefined): string {
  if (!scrType) return '333';
  const exact = CSTIMER_SCRTYPE_TO_EVENT[scrType];
  if (exact) return exact;
  for (const e of ALL_EVENTS) if (scrambleTypesFor(e.id).some((t) => t.id === scrType)) return e.id;
  const prefixes: [string, string][] = [
    ['222', '222'],
    ['444', '444'],
    ['555', '555'],
    ['666', '666'],
    ['777', '777'],
    ['pyr', 'pyram'],
    ['skb', 'skewb'],
    ['sq1', 'sq1'],
    ['sqr', 'sq1'],
    ['clk', 'clock'],
    ['mgm', 'minx'],
    ['minx', 'minx'],
  ];
  for (const [p, e] of prefixes) if (scrType.startsWith(p)) return e;
  return '333';
}

/** csTimer's multi-blind scramble type: an attempt is a score, not a single time, and cubr has no such event. */
export const isMultiBlindScrType = (scrType: string | undefined): boolean => scrType === 'r3ni';

export class CsTimerFormatError extends Error {}

export function penaltyFromCsTimer(code: unknown): Penalty {
  const n = Number(code);
  if (n === -1) return 'DNF';
  if (n > 0) return '+2';
  return 'OK';
}

/** A JSON value that older csTimer versions stored as a JSON string. */
function maybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

type SessionMeta = { name?: unknown; opt?: { scrType?: string }; scr?: string; rank?: unknown };

/** The sessions of a parsed csTimer export, before limits (see finishImport). */
export function csTimerSessions(root: Record<string, unknown>): RawSession[] {
  const props = maybeJson(root.properties) as Record<string, unknown> | undefined;
  const meta = ((props && maybeJson(props.sessionData)) ?? {}) as Record<string, SessionMeta>;
  const out: RawSession[] = [];
  for (const key of Object.keys(root)) {
    const m = /^session(\d+)$/.exec(key);
    if (!m) continue;
    const times = maybeJson(root[key]);
    if (!Array.isArray(times) || times.length === 0) continue;
    const idx = String(Number(m[1]));
    const info: SessionMeta | undefined = meta[idx];
    const scrType = info?.opt?.scrType ?? info?.scr;
    const name = info?.name !== undefined && info.name !== null && String(info.name).trim() ? unescapeHtml(String(info.name)) : `csTimer ${idx}`;
    const solves: RawSolve[] = [];
    for (const s of times) {
      if (!Array.isArray(s) || !Array.isArray(s[0])) continue;
      const ts = Number(s[3]);
      solves.push({
        timeMs: Number(s[0][1]),
        penalty: penaltyFromCsTimer(s[0][0]),
        scramble: s[1],
        comment: s[2],
        at: Number.isFinite(ts) && ts > 0 ? ts * 1000 : null,
      });
    }
    const rank = Number(info?.rank);
    const mapped = scrambleForScrType(scrType);
    out.push({
      name,
      event: isMultiBlindScrType(scrType) ? null : mapped.event,
      ...(mapped.scramble ? { scramble: mapped.scramble } : {}),
      sourceType: scrType ?? '333',
      rank: Number.isFinite(rank) ? rank : Number(idx),
      solves,
    });
  }
  return out;
}

/** Parses the text of a csTimer export file into sessions ready for POST /api/sessions/import. */
export function parseCsTimerExport(text: string): ImportedSession[] {
  let root: unknown;
  try {
    root = JSON.parse(text.trim());
  } catch {
    throw new CsTimerFormatError('Not a csTimer export: file is not valid JSON');
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new CsTimerFormatError('Not a csTimer export');
  if (!Object.keys(root).some((k) => /^session\d+$/.test(k))) throw new CsTimerFormatError('Not a csTimer export: no session data found');
  return finishImport(csTimerSessions(root as Record<string, unknown>)).sessions;
}

/** The sessions and solves of a cubr export (only the fields a csTimer file can hold). */
export interface ExportSession {
  name: string;
  event: string;
  solves: { timeMs: number; penalty: Penalty; scramble: string; comment: string | null; createdAt: string }[];
}

const EVENT_TO_SCRTYPE: Record<string, string> = Object.fromEntries(Object.entries(CSTIMER_SCRTYPE_TO_EVENT).map(([scr, event]) => [event, scr]));

/**
 * A csTimer export file of these sessions. It starts with `{"session1"` so csTimer's "Import
 * session(s) from other timers" accepts it and adds the sessions; "Import from file" also reads
 * it, but replaces all csTimer data. Names are HTML-escaped as csTimer stores them.
 */
export function toCsTimerExport(sessions: ExportSession[]): string {
  const out: Record<string, unknown> = {};
  const sessionData: Record<string, unknown> = {};
  const list = sessions.length ? sessions : [{ name: 'cubr', event: '333', solves: [] }];
  list.forEach((s, i) => {
    const n = i + 1;
    out[`session${n}`] = [...s.solves]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((x) => [
        [x.penalty === 'DNF' ? -1 : x.penalty === '+2' ? 2000 : 0, x.timeMs],
        x.scramble ?? '',
        x.comment ?? '',
        Math.max(0, Math.round(Date.parse(x.createdAt) / 1000) || 0),
      ]);
    const scrType = EVENT_TO_SCRTYPE[s.event] ?? '333';
    sessionData[n] = { name: escapeHtml(s.name), opt: scrType === '333' ? {} : { scrType }, rank: n };
  });
  out.properties = { sessionN: list.length, sessionData: JSON.stringify(sessionData) };
  return JSON.stringify(out);
}
