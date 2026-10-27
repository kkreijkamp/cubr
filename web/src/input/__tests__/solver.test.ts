import { describe, expect, it } from 'vitest';
import { CubieCube, moveName, scrambleCube, SOLVED_FACELET } from '../cube/cubie';
import { cornersBetween, movesBetween, scrambleForFacelet, solveCubie } from '../cube/solver';

/** a uniformly random cube: random pieces, random twists and flips, parities matched */
function randomCube(rand: () => number): CubieCube {
  const shuffle = (n: number) => {
    const p = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    return p;
  };
  const parity = (p: number[]) => p.reduce((n, v, i) => n + p.slice(i + 1).filter((w) => w < v).length, 0) & 1;
  const cp = shuffle(8);
  const ep = shuffle(12);
  if (parity(cp) !== parity(ep)) [ep[0], ep[1]] = [ep[1], ep[0]];
  let twist = 0;
  let flip = 0;
  const c = new CubieCube();
  for (let i = 0; i < 8; i++) {
    const o = i < 7 ? Math.floor(rand() * 3) : (3 - (twist % 3)) % 3;
    twist += o;
    c.ca[i] = cp[i] | (o << 3);
  }
  for (let i = 0; i < 12; i++) {
    const o = i < 11 ? Math.floor(rand() * 2) : flip & 1;
    flip += o;
    c.ea[i] = (ep[i] << 1) | o;
  }
  return c;
}

function seeded(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
}

describe('two-phase solver', () => {
  it('solves random cubes, almost always in 21 turns or fewer', () => {
    const rand = seeded(7);
    const lengths: number[] = [];
    for (let i = 0; i < 40; i++) {
      const c = randomCube(rand);
      expect(c.verify()).toBe(true);
      const sol = solveCubie(c)!;
      expect(sol).not.toBeNull();
      const d = c.clone();
      for (const m of sol) d.move(moveName(m));
      expect(d.toFaceCube()).toBe(SOLVED_FACELET);
      lengths.push(sol.length);
    }
    expect(Math.max(...lengths)).toBeLessThanOrEqual(23);
    expect(lengths.filter((n) => n > 21).length).toBeLessThanOrEqual(2);
  }, 60_000);

  it('gives a scramble for a cube state (csTimer genFacelet), and the way from one state to another', () => {
    const rand = seeded(99);
    for (let i = 0; i < 10; i++) {
      const c = randomCube(rand);
      const scr = scrambleForFacelet(c.toFaceCube())!;
      expect(scr).toMatch(/^([URFDLB]['2]? ?)+$/);
      expect(scrambleCube(scr)!.isEqual(c)).toBe(true);
    }
    const from = scrambleCube("R U R' U'")!;
    const to = scrambleCube("F2 D L' B U2 R")!;
    const way = movesBetween(from, to)!;
    const d = from.clone();
    for (const m of way.split(' ')) d.move(m.length === 1 ? m + ' ' : m);
    expect(d.isEqual(to)).toBe(true);
    expect(scrambleForFacelet(SOLVED_FACELET)).toBe('');
    expect(scrambleForFacelet('U'.repeat(54))).toBeNull();
  }, 30_000);

  it('finds the turns between the corners of two 2x2 states', () => {
    const rand = seeded(5);
    for (let i = 0; i < 6; i++) {
      const from = randomCube(rand);
      const to = randomCube(rand);
      const way = cornersBetween(from, to)!;
      const d = from.clone();
      for (const m of way.split(' ').filter(Boolean)) d.move(m.length === 1 ? m + ' ' : m);
      expect(d.cornersEqual(to)).toBe(true);
      expect(way.split(' ').length).toBeLessThanOrEqual(14);
    }
  }, 60_000);
});
