import type { Penalty } from './averages.js';

/**
 * csTimer export import. A csTimer export (`cstimer_YYYYMMDD_hhmmss.txt`) is one JSON object:
 *   { "session1": [solve, ...], "session2": [...], ..., "properties": { "sessionData": "<JSON string>", ... } }
 * solve = [[penalty, rawMs, ...phaseEnds], scramble, comment, startUnixSeconds, optionalMoves]
 *   penalty: 0 = OK, 2000 = +2, -1 = DNF (raw time is kept even for DNF)
 * sessionData = JSON string: { "1": { "name": "...", "opt": { "scrType": "444wca" }, ... }, ... }
 *   (empty opt → 3x3; names are HTML-escaped)
 */
export interface ImportedSolve {
  timeMs: number;
  penalty: Penalty;
  scramble: string;
  comment: string | null;
  createdAt: string;
}

export interface ImportedSession {
  name: string;
  event: string;
  sourceType: string;
  solves: ImportedSolve[];
}

/** csTimer scramble type → WCA event id. */
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
};

/** Best-effort mapping for csTimer's many non-WCA scramble types (e.g. "222o", "pyrm", "sq1h"). */
export function eventForScrType(scrType: string | undefined): string {
  if (!scrType) return '333';
  const exact = CSTIMER_SCRTYPE_TO_EVENT[scrType];
  if (exact) return exact;
  const prefixes: [string, string][] = [
    ['222', '222'], ['444', '444'], ['555', '555'], ['666', '666'], ['777', '777'],
    ['pyr', 'pyram'], ['skb', 'skewb'], ['sq1', 'sq1'], ['sqr', 'sq1'], ['clk', 'clock'],
    ['mgm', 'minx'], ['minx', 'minx'],
  ];
  for (const [p, e] of prefixes) if (scrType.startsWith(p)) return e;
  return '333';
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function toPenalty(p: unknown): Penalty {
  if (p === -1) return 'DNF';
  if (typeof p === 'number' && p > 0) return '+2';
  return 'OK';
}

export class CsTimerFormatError extends Error {}

/** Parses the text of a csTimer export file into sessions ready for POST /api/sessions/import. */
export function parseCsTimerExport(text: string): ImportedSession[] {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(text.trim());
  } catch {
    throw new CsTimerFormatError('Not a csTimer export: file is not valid JSON');
  }
  if (!root || typeof root !== 'object') throw new CsTimerFormatError('Not a csTimer export');
  const sessionKeys = Object.keys(root).filter((k) => /^session\d+$/.test(k));
  if (sessionKeys.length === 0) throw new CsTimerFormatError('Not a csTimer export: no session data found');

  let meta: Record<string, { name?: unknown; opt?: { scrType?: string } }> = {};
  const props = root.properties as Record<string, unknown> | undefined;
  if (props && typeof props.sessionData === 'string') {
    try {
      meta = JSON.parse(props.sessionData);
    } catch {
      meta = {};
    }
  } else if (props && typeof props.sessionData === 'object' && props.sessionData) {
    meta = props.sessionData as typeof meta;
  }

  const out: ImportedSession[] = [];
  sessionKeys
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)))
    .forEach((key) => {
      const idx = key.slice(7);
      const raw = root[key];
      if (!Array.isArray(raw) || raw.length === 0) return;
      const m = meta[idx] ?? {};
      const scrType = m.opt?.scrType;
      const event = eventForScrType(scrType);
      const name = m.name !== undefined && m.name !== null && String(m.name).trim() ? unescapeHtml(String(m.name)).slice(0, 40) : `csTimer ${idx}`;
      const solves: ImportedSolve[] = [];
      for (const s of raw) {
        if (!Array.isArray(s) || !Array.isArray(s[0])) continue;
        const [pen, ms] = s[0] as [unknown, unknown];
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) continue;
        const ts = typeof s[3] === 'number' && s[3] > 0 ? s[3] : null;
        solves.push({
          timeMs: Math.round(ms),
          penalty: toPenalty(pen),
          scramble: typeof s[1] === 'string' ? s[1].slice(0, 2000) : '',
          comment: typeof s[2] === 'string' && s[2] ? s[2].slice(0, 500) : null,
          createdAt: ts ? new Date(ts * 1000).toISOString() : new Date(0).toISOString(),
        });
      }
      if (solves.length) out.push({ name, event, sourceType: scrType ?? '333', solves });
    });
  return out;
}
