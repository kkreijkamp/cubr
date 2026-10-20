import { randomInt } from 'node:crypto';
import { fetchJson } from '@cubetype/common';
import type { FastifyBaseLogger } from 'fastify';
import type { ScrambleSource } from './types.js';

/**
 * FALLBACK scrambles. The real scrambles come from scramble-service (cubing.js random-state).
 * When that service is unreachable a race must still be able to start, so we generate a
 * WCA-notation *random-move* scramble locally. Random-move scrambles are less uniform than
 * random-state ones, which is fine for a casual race but is why this is only a fallback.
 */

/** Random integer in [0, n). Injectable for deterministic tests. */
export type Rng = (n: number) => number;
const cryptoRng: Rng = (n) => randomInt(n);

const pick = <T>(xs: readonly T[], rng: Rng): T => xs[rng(xs.length)];
const SUFFIXES = ['', "'", '2'] as const;

// Faces grouped by axis: moves on the same axis commute, so "R L R" is redundant.
const AXIS: Record<string, number> = { U: 0, D: 0, L: 1, R: 1, F: 2, B: 2 };

/**
 * NxN random-move scramble. A move is (face, width): width 1 = "R", 2 = "Rw", k >= 3 = "kRw".
 * Rules: never the same (face, width) twice in a row, never three consecutive moves on one axis.
 */
export function nxnScramble(size: number, length: number, rng: Rng = cryptoRng, faces = ['U', 'D', 'L', 'R', 'F', 'B']): string {
  const maxWidth = Math.max(1, Math.floor(size / 2));
  const moves: { face: string; width: number }[] = [];
  while (moves.length < length) {
    const face = pick(faces, rng);
    const width = 1 + rng(maxWidth);
    const prev = moves[moves.length - 1];
    const prev2 = moves[moves.length - 2];
    if (prev && prev.face === face && prev.width === width) continue;
    if (prev && prev2 && AXIS[prev.face] === AXIS[face] && AXIS[prev2.face] === AXIS[face]) continue;
    moves.push({ face, width });
  }
  return moves
    .map(({ face, width }) => {
      const base = width === 1 ? face : width === 2 ? `${face}w` : `${width}${face}w`;
      return base + pick(SUFFIXES, rng);
    })
    .join(' ');
}

/** Faces-only scramble for puzzles where a move may not repeat (skewb, pyraminx). */
function noRepeatScramble(faces: string[], length: number, rng: Rng): string[] {
  const out: string[] = [];
  let prev = '';
  while (out.length < length) {
    const f = pick(faces, rng);
    if (f === prev) continue;
    prev = f;
    out.push(f + (rng(2) ? "'" : ''));
  }
  return out;
}

/** Pyraminx: 11 moves on U L R B + random tip turns (u l r b), like WCA scrambles. */
export function pyraminxScramble(rng: Rng = cryptoRng): string {
  const moves = noRepeatScramble(['U', 'L', 'R', 'B'], 11, rng);
  for (const tip of ['u', 'l', 'r', 'b']) {
    const t = rng(3); // 0 = untouched, 1 = cw, 2 = ccw
    if (t) moves.push(t === 1 ? tip : `${tip}'`);
  }
  return moves.join(' ');
}

/** Skewb: 11 moves on R U L B. */
export const skewbScramble = (rng: Rng = cryptoRng): string => noRepeatScramble(['R', 'U', 'L', 'B'], 11, rng).join(' ');

/** Megaminx (Pochmann notation, which is what WCA uses): 7 lines of 10 R/D moves + U. */
export function megaminxScramble(rng: Rng = cryptoRng): string {
  const lines: string[] = [];
  for (let l = 0; l < 7; l++) {
    const parts: string[] = [];
    for (let i = 0; i < 10; i++) parts.push(`${i % 2 === 0 ? 'R' : 'D'}${rng(2) ? '++' : '--'}`);
    parts.push(rng(2) ? 'U' : "U'");
    lines.push(parts.join(' '));
  }
  return lines.join(' ');
}

/** Clock: WCA notation - pin settings are uniformly random, so this is effectively random-state. */
export function clockScramble(rng: Rng = cryptoRng): string {
  const turn = (name: string) => {
    const amount = rng(12) - 5; // -5..6
    return `${name}${Math.abs(amount)}${amount < 0 ? '-' : '+'}`;
  };
  const front = ['UR', 'DR', 'DL', 'UL', 'U', 'R', 'D', 'L', 'ALL'].map(turn);
  const back = ['U', 'R', 'D', 'L', 'ALL'].map(turn);
  const pins = ['UR', 'DR', 'DL', 'UL'].filter(() => rng(2) === 1);
  return [...front, 'y2', ...back, ...pins].join(' ');
}

/**
 * Square-1 layer model used to only emit twists after which a slash ("/") is physically possible.
 * Each layer has 12 slots of 30 degrees; an edge fills 1 slot, a corner 2. A slash is possible when no
 * piece straddles the cut (between slots 11|0 and 5|6) on either layer. Solved cube shape:
 * top = corner,corner,edge,...  bottom = edge,corner,corner,...  which matches WCA notation where
 * "(1,0) /" and "(0,-1) /" are legal first moves.
 */
export function sq1SolvedLayers(): { top: number[]; bottom: number[] } {
  const top = [1, 1, 2, 3, 3, 4, 5, 5, 6, 7, 7, 8]; // piece ids; repeated id = corner (2 slots)
  const bottom = [9, 10, 10, 11, 12, 12, 13, 14, 14, 15, 16, 16];
  return { top, bottom };
}

const rotate = (layer: number[], by: number): number[] => layer.map((_, i) => layer[(((i - by) % 12) + 12) % 12]);
const canSlash = (layer: number[]): boolean => layer[11] !== layer[0] && layer[5] !== layer[6];

/** Applies "(u,d) /" to a Square-1 state; returns null if the slash would be blocked. */
export function sq1Apply(state: { top: number[]; bottom: number[] }, u: number, d: number) {
  const top = rotate(state.top, u);
  const bottom = rotate(state.bottom, d);
  if (!canSlash(top) || !canSlash(bottom)) return null;
  // The slash turns the right half 180 degrees about the horizontal axis perpendicular to the cut:
  // top slot i lands in bottom slot i (bottom slots are counted clockwise as seen from below)
  // and vice versa. Verified against cubing.js random-state scrambles.
  const newTop = [...bottom.slice(0, 6), ...top.slice(6)];
  const newBottom = [...top.slice(0, 6), ...bottom.slice(6)];
  return { top: newTop, bottom: newBottom };
}

/** Square-1: 12 random legal "(u,d) /" twists. */
export function sq1Scramble(rng: Rng = cryptoRng, slashes = 12): string {
  let state = sq1SolvedLayers();
  const parts: string[] = [];
  while (parts.length < slashes) {
    const u = rng(12) - 5;
    const d = rng(12) - 5;
    if (u === 0 && d === 0) continue; // "/ /" would cancel
    const next = sq1Apply(state, u, d);
    if (!next) continue;
    state = next;
    parts.push(`(${u}, ${d}) /`);
  }
  return parts.join(' ');
}

/** Local random-move scramble for any supported WCA event. */
export function fallbackScramble(event: string, rng: Rng = cryptoRng): string {
  switch (event) {
    case '222':
      // 2x2: moving only U/R/F (with fixed opposite layers) reaches every state
      return nxnScramble(2, 11, rng, ['U', 'R', 'F']);
    case '444':
    case '444bf':
      return nxnScramble(4, 40, rng);
    case '555':
    case '555bf':
      return nxnScramble(5, 60, rng);
    case '666':
      return nxnScramble(6, 80, rng);
    case '777':
      return nxnScramble(7, 100, rng);
    case 'pyram':
      return pyraminxScramble(rng);
    case 'skewb':
      return skewbScramble(rng);
    case 'minx':
      return megaminxScramble(rng);
    case 'clock':
      return clockScramble(rng);
    case 'sq1':
      return sq1Scramble(rng);
    default: // 333, 333oh, 333bf, 333fm
      return nxnScramble(3, 25, rng);
  }
}

export interface ScrambleResult {
  scramble: string;
  source: ScrambleSource;
}

export interface ScrambleFetcher {
  get(event: string): Promise<ScrambleResult>;
}

/**
 * Fetches one scramble from scramble-service, falling back to the local generator. After a
 * failure the service is skipped for `cooldownMs` (a tiny circuit breaker) so that while it is
 * down every new round starts instantly instead of waiting for timeouts.
 */
export function makeScrambleFetcher(baseUrl: string, log: FastifyBaseLogger, cooldownMs = 15_000): ScrambleFetcher {
  let skipUntil = 0;
  return {
    async get(event) {
      if (Date.now() >= skipUntil) {
        try {
          const res = await fetchJson<{ scrambles?: unknown }>(
            `${baseUrl}/api/scrambles/${encodeURIComponent(event)}?count=1`,
            { timeoutMs: 4000, retries: 1 },
          );
          const s = Array.isArray(res?.scrambles) ? res.scrambles[0] : undefined;
          if (typeof s === 'string' && s.trim() && s.length <= 2000) {
            return { scramble: s.trim(), source: 'scramble-service' };
          }
          throw new Error('scramble-service returned no scramble');
        } catch (err) {
          skipUntil = Date.now() + cooldownMs;
          log.warn({ err: (err as Error).message, event }, 'scramble-service unavailable, using fallback scramble');
        }
      }
      return { scramble: fallbackScramble(event), source: 'fallback' };
    },
  };
}
