import { describe, expect, it } from 'vitest';
import { EVENT_IDS } from '@cubr/cubestats';
import {
  clockScramble, fallbackScramble, megaminxScramble, nxnScramble, pyraminxScramble, skewbScramble, sq1Apply, sq1Scramble,
  sq1SolvedLayers,
} from '../src/scramble.js';

const AXIS: Record<string, number> = { U: 0, D: 0, L: 1, R: 1, F: 2, B: 2 };

function parseNxn(move: string) {
  const m = /^(\d*)([UDLRFB])(w?)(['2]?)$/.exec(move);
  if (!m) throw new Error(`bad move ${move}`);
  const width = m[3] ? (m[1] ? Number(m[1]) : 2) : 1;
  return { face: m[2], width };
}

/** Replays a Square-1 scramble; false if any slash would be physically blocked. */
function sq1Valid(scramble: string): boolean {
  let state = sq1SolvedLayers();
  let u = 0;
  let d = 0;
  for (const tok of scramble.match(/\(\s*-?\d+\s*,\s*-?\d+\s*\)|\//g) ?? []) {
    if (tok === '/') {
      const next = sq1Apply(state, u, d);
      if (!next) return false;
      state = next;
      u = d = 0;
    } else {
      const [, a, b] = /(-?\d+)\s*,\s*(-?\d+)/.exec(tok)!;
      u += Number(a);
      d += Number(b);
    }
  }
  return true;
}

describe('fallback scrambles', () => {
  it('produces a non-empty scramble for every supported event', () => {
    for (const ev of EVENT_IDS) {
      const s = fallbackScramble(ev);
      expect(s.length, ev).toBeGreaterThan(10);
      expect(s.length, ev).toBeLessThanOrEqual(2000);
    }
  });

  it('3x3 is 25 moves with no redundant face repeats or same-axis triples', () => {
    for (let i = 0; i < 300; i++) {
      const moves = fallbackScramble('333').split(' ');
      expect(moves).toHaveLength(25);
      const parsed = moves.map(parseNxn);
      for (let k = 0; k < parsed.length; k++) {
        expect(parsed[k].width).toBe(1);
        if (k > 0) expect(parsed[k].face).not.toBe(parsed[k - 1].face);
        if (k > 1) {
          const sameAxis = AXIS[parsed[k].face] === AXIS[parsed[k - 1].face] && AXIS[parsed[k].face] === AXIS[parsed[k - 2].face];
          expect(sameAxis).toBe(false);
        }
      }
    }
  });

  it('big cubes use wide moves with the right lengths', () => {
    const lengths: Record<string, [number, number]> = { '444': [40, 2], '555': [60, 2], '666': [80, 3], '777': [100, 3] };
    for (const [ev, [len, maxWidth]] of Object.entries(lengths)) {
      const parsed = fallbackScramble(ev).split(' ').map(parseNxn);
      expect(parsed).toHaveLength(len);
      expect(Math.max(...parsed.map((p) => p.width))).toBeLessThanOrEqual(maxWidth);
    }
    expect(nxnScramble(7, 200).split(' ').some((m) => /^3[UDLRFB]w/.test(m))).toBe(true);
  });

  it('2x2 only turns U, R and F', () => {
    for (let i = 0; i < 50; i++) expect(fallbackScramble('222')).toMatch(/^([URF]['2]? ?){11}$/);
  });

  it('pyraminx: 11 moves without repeats, then optional tips', () => {
    for (let i = 0; i < 100; i++) {
      const moves = pyraminxScramble().split(' ');
      const main = moves.slice(0, 11);
      main.forEach((m, k) => {
        expect(m).toMatch(/^[ULRB]'?$/);
        if (k > 0) expect(m[0]).not.toBe(main[k - 1][0]);
      });
      for (const tip of moves.slice(11)) expect(tip).toMatch(/^[ulrb]'?$/);
    }
  });

  it('skewb: 11 moves without repeats', () => {
    const moves = skewbScramble().split(' ');
    expect(moves).toHaveLength(11);
    moves.forEach((m, k) => k > 0 && expect(m[0]).not.toBe(moves[k - 1][0]));
  });

  it('megaminx: 7 lines in Pochmann notation', () => {
    expect(megaminxScramble()).toMatch(/^((R(\+\+|--) D(\+\+|--) ){5}U'? ?){7}$/);
  });

  it('clock: WCA notation', () => {
    expect(clockScramble()).toMatch(
      /^UR\d[+-] DR\d[+-] DL\d[+-] UL\d[+-] U\d[+-] R\d[+-] D\d[+-] L\d[+-] ALL\d[+-] y2 U\d[+-] R\d[+-] D\d[+-] L\d[+-] ALL\d[+-]( (UR|DR|DL|UL))*$/,
    );
  });

  it('square-1 model accepts real random-state scrambles (cubing.js output)', () => {
    const real = [
      '(1, 0) / (0, 3) / (-3, 0) / (0, -3) / (0, -3) / (5, 2) / (-3, 0) / (0, -5) / (3, 3) / (-1, 0) / (4, 2) / (-4, 2) / (6, 3)',
      '(-2, 0) / (3, 0) / (-3, 0) / (2, 2) / (3, 0) / (0, -3) / (0, -2) / (3, 0) / (0, 2) / (1, 0) / (-2, 0) / (0, 1) / (-4, 0) / (-3, 0) / (-1, 0)',
      '(0, -4) / (-3, 0) / (-2, -2) / (-3, 6) / (-1, 3) / (0, 3) / (0, 3) / (0, 1) / (-2, 0) / (3, 0) / (0, -2) / (6, 0)',
    ];
    for (const s of real) expect(sq1Valid(s)).toBe(true);
    expect(sq1Valid('(-1, 0) /')).toBe(false); // corner straddles the cut from cube shape
    expect(sq1Valid('(0, 1) /')).toBe(false);
  });

  it('square-1 fallback scrambles are always physically legal', () => {
    for (let i = 0; i < 300; i++) {
      const s = sq1Scramble();
      expect(s.match(/\//g)).toHaveLength(12);
      expect(sq1Valid(s), s).toBe(true);
    }
  });

  it('is deterministic with an injected rng', () => {
    let seed = 7;
    const rng = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const a = fallbackScramble('333', rng);
    seed = 7;
    expect(fallbackScramble('333', rng)).toBe(a);
  });
});
