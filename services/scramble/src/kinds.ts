// How each event's scramble types are made (packages/cubestats/src/scrambleTypes.ts lists them):
// a WCA event's default comes from the pool or cubing.js; the 3x3 and 2x2 practice types from a
// pinned random state (practice.ts); csTimer's random-move types from its move tables
// (randomMoves.ts); relays and cuboids from WCA scrambles; a few other puzzles from cubing.js; and
// everything else from csTimer's own scramblers (cstimer.ts). Pending types throw.
import {
  ALL_EVENTS,
  cuboidPrefix,
  defaultScrambleType,
  getEvent,
  getScrambleType,
  isWcaEvent,
  randomMoveScramble,
  RANDOM_MOVE_TYPES,
  RELAY_EVENTS,
  RELAY_PARTS,
  scrambleTypesFor,
} from '@cubr/cubestats';
import { encodeSolveJob, practiceJob, PRACTICE_STATE_TYPES } from './practice.js';

export interface MakeDeps {
  /** a cubing.js job through the generator queue: an event id or a practice state */
  generate(job: string): Promise<string>;
  /** a WCA event's default scramble: from the pool when it has one, else generated */
  wca(event: string): Promise<string>;
  /** a scramble from csTimer's own scramblers (`length`: csTimer's length setting) */
  cstimer(type: string, length: number): Promise<string>;
}

/**
 * The 3x3 move subsets cubr can also make as random moves (offline), but which csTimer makes
 * random-state within the subgroup: on the server, csTimer's.
 */
// prettier-ignore
const CSTIMER_RANDOM_STATE: ReadonlySet<string> = new Set(['2gen', '2genl', 'roux', '3gen_F', '3gen_L', 'RrU', 'half', '333drud']);

/** csTimer's length setting where its default isn't 0 (en-us.js `scrdata`): random-move lengths and easy xcross */
// prettier-ignore
export const CSTIMER_LENGTHS: Readonly<Record<string, number>> = {
  '444yj': 40, '5edge': 8, '6edge': 8, '7edge': 8, pyrm: 25, sq1h: 40, sq1t: 20, mpyr: 42, redim: 8, redi: 20, heli: 40, helicv: 40, heli2x2: 70,
  heli2x2g: 5, sq2: 20, ssq1t: 20, bsq: 25, ctico: 60, bic: 30, '15p': 80, '15pat': 80, '15pm': 80, easyxc: 4,
};

/** other puzzles cubing.js scrambles random-state (its event ids) */
const CUBING: Readonly<Record<string, string>> = {
  klmso: 'kilominx',
  rediso: 'redi_cube',
  mpyrso: 'master_tetraminx',
};

/** a relay's own (only) scramble type: one WCA scramble per puzzle (cubestats RELAY_PARTS) */
const isRelay = (event: string, id: string) => RELAY_PARTS[event] !== undefined && defaultScrambleType(event)?.id === id;

export class ScrambleTypeUnavailableError extends Error {}

/** Moves in a scramble (a practice state can land a move away from solved; csTimer re-rolls those). */
const moveCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** One scramble of `event`'s type `typeId` (the event's default when omitted). */
export async function makeScramble(event: string, typeId: string | undefined, deps: MakeDeps): Promise<string> {
  const def = defaultScrambleType(event);
  const type = typeId === undefined ? def : getScrambleType(event, typeId);
  if (!type || type.pending) throw new ScrambleTypeUnavailableError(`no ${typeId ?? 'default'} scrambles for ${event} yet`);
  if (type === def && isWcaEvent(event)) return deps.wca(event);
  const id = type.id;
  if (CSTIMER_TYPES.has(id)) return deps.cstimer(id, CSTIMER_LENGTHS[id] ?? 0);
  const moves = randomMoveScramble(id);
  if (moves !== null) return moves;
  if (PRACTICE_STATE_TYPES.has(id)) {
    for (let attempt = 0; ; attempt++) {
      const job = practiceJob(id);
      if (!job) break;
      const solution = await deps.generate(encodeSolveJob(job.puzzle, job.state));
      if (moveCount(solution) >= 2 || attempt >= 4) return job.suffix ? `${solution} ${job.suffix}` : solution;
    }
  }
  if (CUBING[id]) return deps.generate(CUBING[id]);
  if (id === 'mrbl') return deps.wca('333');
  if (id === '335' || id === '337') return `${cuboidPrefix(id)} / ${await deps.wca('333')}`;
  const relay = isRelay(event, id) ? RELAY_PARTS[event] : undefined;
  if (relay) {
    const parts = await Promise.all(relay.map(([, ev]) => deps.wca(ev)));
    return relay.map(([label], i) => `${label}: ${parts[i]}`).join('\n');
  }
  throw new ScrambleTypeUnavailableError(`no ${id} scrambles yet`);
}

/** made by cubr's own code (or cubing.js), not csTimer's */
function ownMaker(event: string, id: string): boolean {
  const def = defaultScrambleType(event);
  if (def?.id === id && isWcaEvent(event)) return true;
  if (CSTIMER_RANDOM_STATE.has(id)) return false;
  return RANDOM_MOVE_TYPES.has(id) || PRACTICE_STATE_TYPES.has(id) || id in CUBING || id === 'mrbl' || id === '335' || id === '337' || isRelay(event, id);
}

/** The types csTimer's scramblers make: every listed, non-pending type cubr has no maker of its own for. */
export const CSTIMER_TYPES: ReadonlySet<string> = new Set(
  ALL_EVENTS.flatMap((e) =>
    scrambleTypesFor(e.id)
      .filter((t) => !t.pending && !ownMaker(e.id, t.id))
      .map((t) => t.id),
  ),
);

/** Every scramble type this service can make (for the registry consistency test). */
export function canMake(event: string, id: string): boolean {
  return ownMaker(event, id) || CSTIMER_TYPES.has(id);
}

/** csTimer's relay labels ("2) ...", "3oh) ...") for cubr's ("2x2: ...", "3x3 oh: ...") */
// prettier-ignore
const CSTIMER_RELAY_LABELS: Readonly<Record<string, string>> = {
  '2x2': '2', '3x3': '3', '4x4': '4', '5x5': '5', '6x6': '6', '7x7': '7', '3x3 oh': '3oh', pyra: 'pyr', skewb: 'skb', 'sq-1': 'sq1', clock: 'clk', mega: 'mgm',
};

/**
 * What to ask csTimer for to draw a scramble of `event` (type `typeId`, the default when absent):
 * its type, and the scramble as csTimer writes it (relays). The web app asks for it where cubing.js
 * can't draw the puzzle, or can't read the scramble (a type in csTimer's own notation). Null for an
 * event or type that isn't known.
 */
export function cstimerImageRequest(event: string, typeId: string | undefined, scramble: string): { type: string; scramble: string } | null {
  if (!getEvent(event)) return null;
  const type = typeId === undefined ? defaultScrambleType(event) : getScrambleType(event, typeId);
  if (!type) return null;
  if (RELAY_EVENTS.includes(event)) {
    const lines = scramble.replace(/^([^:\n]+):[ \t]*/gm, (whole, label: string) => `${CSTIMER_RELAY_LABELS[label] ?? label}) `);
    return { type: type.id, scramble: lines };
  }
  return { type: type.id, scramble };
}
