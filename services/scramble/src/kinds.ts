// How each event's scramble types are made (packages/cubestats/src/scrambleTypes.ts lists them):
// a WCA event's default comes from the pool or cubing.js; the practice types from a pinned random
// state (practice.ts); csTimer's random-move types from its move tables (randomMoves.ts); relays
// and cuboids from WCA scrambles; a few other puzzles from cubing.js. Pending types throw.
import { cuboidPrefix, defaultScrambleType, getScrambleType, isWcaEvent, randomMoveScramble, RANDOM_MOVE_TYPES } from '@cubr/cubestats';
import { encodeSolveJob, practiceJob, PRACTICE_STATE_TYPES } from './practice.js';

export interface MakeDeps {
  /** a cubing.js job through the generator queue: an event id or a practice state */
  generate(job: string): Promise<string>;
  /** a WCA event's default scramble: from the pool when it has one, else generated */
  wca(event: string): Promise<string>;
}

/** other puzzles cubing.js scrambles random-state (its event ids) */
const CUBING: Readonly<Record<string, string>> = {
  klmso: 'kilominx',
  rediso: 'redi_cube',
  mpyrso: 'master_tetraminx',
};

/** relays: [label, WCA event] per puzzle, in order */
const RELAYS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  r234w: [['2x2', '222'], ['3x3', '333'], ['4x4', '444']],
  r2345w: [['2x2', '222'], ['3x3', '333'], ['4x4', '444'], ['5x5', '555']],
  r23456w: [['2x2', '222'], ['3x3', '333'], ['4x4', '444'], ['5x5', '555'], ['6x6', '666']],
  r234567w: [['2x2', '222'], ['3x3', '333'], ['4x4', '444'], ['5x5', '555'], ['6x6', '666'], ['7x7', '777']],
  rmngf: [['2x2', '222'], ['3x3', '333'], ['4x4', '444'], ['5x5', '555'], ['3x3 oh', '333oh'], ['pyra', 'pyram'], ['skewb', 'skewb'], ['sq-1', 'sq1'], ['clock', 'clock'], ['mega', 'minx']],
  r3: [['1', '333'], ['2', '333'], ['3', '333'], ['4', '333'], ['5', '333']],
};

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
  const relay = RELAYS[id];
  if (relay) {
    const parts = await Promise.all(relay.map(([, ev]) => deps.wca(ev)));
    return relay.map(([label], i) => `${label}: ${parts[i]}`).join('\n');
  }
  throw new ScrambleTypeUnavailableError(`no ${id} scrambles yet`);
}

/** Every scramble type this service can make (for the registry consistency test). */
export function canMake(event: string, id: string): boolean {
  const def = defaultScrambleType(event);
  if (def?.id === id && isWcaEvent(event)) return true;
  return RANDOM_MOVE_TYPES.has(id) || PRACTICE_STATE_TYPES.has(id) || id in CUBING || id === 'mrbl' || id === '335' || id === '337' || id in RELAYS;
}
