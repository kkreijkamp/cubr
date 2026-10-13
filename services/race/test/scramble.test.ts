import { describe, expect, it } from 'vitest';
import { fallbackScramble, nxnScramble } from '../src/scramble.js';

const AXIS: Record<string, number> = { U: 0, D: 0, L: 1, R: 1, F: 2, B: 2 };

function parseNxn(move: string) {
  const m = /^(\d*)([UDLRFB])(w?)(['2]?)$/.exec(move);
  if (!m) throw new Error(`bad move ${move}`);
  const width = m[3] ? (m[1] ? Number(m[1]) : 2) : 1;
  return { face: m[2], width };
}

describe('fallback scrambles', () => {
  it('produces a scramble for every cube event and none for the other puzzles', () => {
    for (const ev of ['333', '222', '444', '555', '666', '777', '333oh', '333bf', '333fm', '444bf', '555bf']) {
      const s = fallbackScramble(ev);
      expect(s?.length, ev).toBeGreaterThan(10);
      expect(s?.length, ev).toBeLessThanOrEqual(2000);
    }
    for (const ev of ['clock', 'minx', 'pyram', 'skewb', 'sq1']) expect(fallbackScramble(ev), ev).toBeNull();
  });

  it('3x3 is 25 moves with no redundant face repeats or same-axis triples', () => {
    for (let i = 0; i < 300; i++) {
      const moves = fallbackScramble('333')!.split(' ');
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
      const parsed = fallbackScramble(ev)!.split(' ').map(parseNxn);
      expect(parsed).toHaveLength(len);
      expect(Math.max(...parsed.map((p) => p.width))).toBeLessThanOrEqual(maxWidth);
    }
    expect(nxnScramble(7, 200).split(' ').some((m) => /^3[UDLRFB]w/.test(m))).toBe(true);
  });

  it('2x2 only turns U, R and F', () => {
    for (let i = 0; i < 50; i++) expect(fallbackScramble('222')).toMatch(/^([URF]['2]? ?){11}$/);
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
