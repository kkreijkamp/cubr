import { randomInt } from 'node:crypto';
import { fetchJson, unavailable } from '@cubetype/common';
import type { FastifyBaseLogger } from 'fastify';
import type { ScrambleSource } from './types.js';

/**
 * FALLBACK scrambles. The real scrambles come from scramble-service (cubing.js random-state).
 * When that service is unreachable a race should still be able to start, so for the cube events
 * we generate a WCA-notation *random-move* scramble locally. Random-move scrambles are less
 * uniform than random-state ones, which is fine for a casual race but is why this is only a fallback.
 */

/** Random integer in [0, n). Injectable for deterministic tests. */
export type Rng = (n: number) => number;
const cryptoRng: Rng = (n) => randomInt(n);

const pick = <T>(xs: readonly T[], rng: Rng): T => xs[rng(xs.length)];
const SUFFIXES = ['', "'", '2'] as const;

// Faces grouped by axis: moves on the same axis commute, so "R L R" is redundant.
const AXIS: Record<string, number> = { U: 0, D: 0, L: 1, R: 1, F: 2, B: 2 };

/**
 * NxN random-move scramble. A move is (face, width): width 1 = "R", 2 = "Rw", k ≥ 3 = "kRw".
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

/** Local random-move scramble for the cube events; null for puzzles without a local generator. */
export function fallbackScramble(event: string, rng: Rng = cryptoRng): string | null {
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
    case '333':
    case '333oh':
    case '333bf':
    case '333fm':
      return nxnScramble(3, 25, rng);
    default: // clock, minx, pyram, skewb, sq1
      return null;
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
 * Fetches one scramble from scramble-service. If the service is unreachable, cube events fall
 * back to the local generator; other puzzles have to wait until the service is back.
 */
export function makeScrambleFetcher(baseUrl: string, log: FastifyBaseLogger): ScrambleFetcher {
  return {
    async get(event) {
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
        const scramble = fallbackScramble(event);
        if (scramble === null) throw unavailable('Scrambles for this event are unavailable right now, try again shortly');
        log.warn({ err: (err as Error).message, event }, 'scramble-service unavailable, using fallback scramble');
        return { scramble, source: 'fallback' };
      }
    },
  };
}
