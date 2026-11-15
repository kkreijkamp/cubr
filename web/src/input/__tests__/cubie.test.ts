import { describe, expect, it } from 'vitest';
import { CubieCube, isFaceletSolved, MOVE_CUBE, scrambleCube, SOLVED_FACELET } from '../cube/cubie';
import { cubeTwisty } from '../virtual/polyTwisty';
import { cubeFacelet } from '../virtual/renderFlat';

/** our virtual 3x3 (checked against cubing.js) as a URFDLB facelet string */
function virtualFacelets(alg: string): string {
  const t = cubeTwisty(3);
  let s = t.puzzle.solved();
  for (const m of t.parse(alg)!) s = t.puzzle.applyMove(s, m);
  // scheme faces (U F R B L D) to letters
  const letter = ['U', 'F', 'R', 'B', 'L', 'D'];
  const out: string[] = [];
  t.puzzle.slots.forEach((slot, i) => (out[cubeFacelet(3, slot.center, slot.normal)] = letter[t.puzzle.slots[s[i]].face]));
  return out.join('');
}

describe("csTimer's CubieCube", () => {
  it('turns faces the way the virtual cube (and cubing.js) does', () => {
    for (let i = 0; i < 40; i++) {
      const moves = Array.from({ length: 20 }, () => 'URFDLB'[Math.floor(Math.random() * 6)] + ['', '2', "'"][Math.floor(Math.random() * 3)]);
      const alg = moves.join(' ');
      const c = scrambleCube(alg)!;
      expect(c.toFaceCube(), alg).toBe(virtualFacelets(alg));
    }
  });

  it('reads facelets back, inverts, and knows a real cube', () => {
    const c = scrambleCube("R U F' L2 D B'")!;
    const f = c.toFaceCube();
    const back = new CubieCube().fromFacelet(f)!;
    expect(back.isEqual(c)).toBe(true);
    expect(back.verify()).toBe(true);
    const inv = new CubieCube().invFrom(c);
    expect(CubieCube.mult(c, inv, new CubieCube()).toFaceCube()).toBe(SOLVED_FACELET);
    // a twisted corner is not a real cube
    const bad = new CubieCube();
    bad.ca[0] = 0 | (1 << 3);
    expect(bad.verify()).toBe(false);
    expect(new CubieCube().fromFacelet('U'.repeat(54))).toBeNull();
  });

  it('every move four times is nothing', () => {
    for (const m of MOVE_CUBE) {
      let c = new CubieCube();
      for (let i = 0; i < 4; i++) c = CubieCube.mult(c, m, new CubieCube());
      expect(c.isEqual(new CubieCube())).toBe(true);
    }
  });

  it('solved: the 2x2 only looks at corners', () => {
    expect(isFaceletSolved(SOLVED_FACELET, false)).toBe(true);
    // an edge flip on a "2x2" (its edges don't exist) still counts as solved
    const c = new CubieCube();
    c.ea[0] ^= 1;
    c.ea[1] ^= 1;
    expect(isFaceletSolved(c.toFaceCube(), true)).toBe(true);
    expect(isFaceletSolved(c.toFaceCube(), false)).toBe(false);
    expect(scrambleCube('R Rw')).toBeNull();
  });
});
