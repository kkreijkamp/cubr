import { describe, expect, it } from 'vitest';
import { puzzles } from 'cubing/puzzles';
import { schemeFor, stickerSources } from '../../lib/scrambleNet';
import { cubeTwisty, megaminxTwisty, pyraminxTwisty, skewbTwisty, type PolyTwisty } from '../virtual/polyTwisty';

// a seeded random source, so a failure can be reproduced
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, a: T[]) => a[Math.floor(r() * a.length)];

/** for each face (by its solved colour), the colours on it now - from cubing.js */
async function cubingFaces(id: string, alg: string): Promise<Map<number, number[]>> {
  const scheme = schemeFor(id)!;
  const kp = await puzzles[id].kpuzzle();
  const svg = await puzzles[id].svg();
  const fill = new Map([...svg.matchAll(/id="([A-Z0-9_]+-l\d+-o\d+)"[^>]*style="fill: ?([^;"]+)/g)].map((m) => [m[1], m[2].trim().toLowerCase()]));
  const face = (c: string) => scheme.faces.findIndex((f) => f.cubing.includes(c));
  const src = stickerSources(kp.definition.orbits, kp.defaultPattern().applyAlg(alg).patternData);
  const out = new Map<number, number[]>();
  // a piece drawn as several shapes on one face (megaminx centres) counts once
  const seen = new Set<string>();
  for (const [sid, solved] of fill) {
    const key = `${sid.replace(/-o\d+$/, '')}|${solved}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const f = face(solved);
    out.set(f, [...(out.get(f) ?? []), face(fill.get(src.get(sid)!)!)]);
  }
  for (const v of out.values()) v.sort((a, b) => a - b);
  return out;
}

function ourFaces(t: PolyTwisty, alg: string): Map<number, number[]> {
  const moves = t.parse(alg);
  expect(moves, alg).not.toBeNull();
  let state = t.puzzle.solved();
  for (const m of moves!) state = t.puzzle.applyMove(state, m);
  const out = new Map<number, number[]>();
  t.puzzle.slots.forEach((s, i) => out.set(s.face, [...(out.get(s.face) ?? []), t.puzzle.slots[state[i]].face]));
  for (const v of out.values()) v.sort((a, b) => a - b);
  return out;
}

const cubeAlg = (n: number, r: () => number, len: number) =>
  Array.from({ length: len }, () => {
    const face = pick(r, ['U', 'R', 'F', 'D', 'L', 'B']);
    const amt = pick(r, ['', '2', "'"]);
    const kind = n > 2 ? pick(r, ['outer', 'outer', 'wide', 'deep', 'rot']) : pick(r, ['outer', 'outer', 'rot']);
    if (kind === 'rot') return pick(r, ['x', 'y', 'z']) + amt;
    if (kind === 'wide') return face + 'w' + amt;
    if (kind === 'deep' && n > 3) return `${2 + Math.floor(r() * (Math.floor(n / 2) - 1))}${face}w${amt}`;
    return face + amt;
  }).join(' ');

describe('virtual puzzles match cubing.js (the scramble preview)', () => {
  it.each([2, 3, 4, 5, 6, 7])('%dx%d cube', async (n) => {
    const t = cubeTwisty(n);
    expect(t.puzzle.slots).toHaveLength(6 * n * n);
    const r = rng(n * 101);
    for (let i = 0; i < 6; i++) {
      const alg = cubeAlg(n, r, 25);
      expect(ourFaces(t, alg), alg).toEqual(await cubingFaces(`${n}x${n}x${n}`, alg));
    }
    // slices on odd cubes
    if (n % 2 === 1) for (const alg of ["M E S'", 'M2 U M\' U2 E', "R M' x' S E2"]) expect(ourFaces(t, alg), alg).toEqual(await cubingFaces(`${n}x${n}x${n}`, alg));
  });

  it('pyraminx', async () => {
    const t = pyraminxTwisty();
    expect(t.puzzle.slots).toHaveLength(36);
    const r = rng(7);
    for (let i = 0; i < 10; i++) {
      const alg = Array.from({ length: 14 }, () => pick(r, ['U', 'L', 'R', 'B', 'u', 'l', 'r', 'b']) + pick(r, ['', "'"])).join(' ');
      expect(ourFaces(t, alg), alg).toEqual(await cubingFaces('pyraminx', alg));
    }
  });

  it('skewb', async () => {
    const t = skewbTwisty();
    expect(t.puzzle.slots).toHaveLength(30);
    const r = rng(11);
    for (let i = 0; i < 10; i++) {
      const alg = Array.from({ length: 12 }, () => pick(r, ['U', 'L', 'R', 'B', 'U', 'L', 'R', 'B', 'x', 'y', 'z']) + pick(r, ['', "'"])).join(' ');
      expect(ourFaces(t, alg), alg).toEqual(await cubingFaces('skewb', alg));
    }
  });

  it('megaminx (Pochmann scrambles and face turns)', async () => {
    const t = megaminxTwisty();
    expect(t.puzzle.slots).toHaveLength(132);
    const r = rng(13);
    for (let i = 0; i < 6; i++) {
      const line = () => Array.from({ length: 10 }, (_, k) => (k % 2 ? 'D' : 'R') + pick(r, ['++', '--'])).join(' ') + ' ' + pick(r, ['U', "U'"]);
      const alg = [line(), line(), line()].join(' ');
      expect(ourFaces(t, alg), alg).toEqual(await cubingFaces('megaminx', alg));
    }
    for (let i = 0; i < 6; i++) {
      const alg = Array.from({ length: 12 }, () => pick(r, ['U', 'F', 'R', 'L', 'BR', 'BL', 'FR', 'FL', 'DR', 'DL', 'B', 'D']) + pick(r, ['', "'", '2', "2'"])).join(' ');
      expect(ourFaces(t, alg), alg).toEqual(await cubingFaces('megaminx', alg));
    }
  });
});

describe('virtual puzzles', () => {
  it('a move and its inverse cancel out, and a sequence has the right order', () => {
    const t = cubeTwisty(3);
    let s = t.puzzle.solved();
    const seq = t.parse("R U R' U'")!;
    for (let i = 0; i < 6; i++) for (const m of seq) s = t.puzzle.applyMove(s, m);
    expect(t.puzzle.isSolved(s)).toBe(true);
    s = t.puzzle.solved();
    const ru = t.parse('R U')!;
    let order = 0;
    do {
      for (const m of ru) s = t.puzzle.applyMove(s, m);
      order++;
    } while (!t.puzzle.isSolved(s) && order < 200);
    expect(order).toBe(105);
  });

  it('a whole-puzzle rotation still counts as solved', () => {
    for (const [t, alg] of [
      [cubeTwisty(3), 'x y2 z'],
      [cubeTwisty(4), "x' y"],
      [pyraminxTwisty(), "[u] [r']"],
      [skewbTwisty(), 'x y'],
      [megaminxTwisty(), "[u] [r] [f']"],
    ] as const) {
      let s = t.puzzle.solved();
      for (const m of t.parse(alg)!) {
        expect(t.isRotation(m), alg).toBe(true);
        s = t.puzzle.applyMove(s, m);
      }
      expect(t.puzzle.isSolved(s), alg).toBe(true);
    }
  });

  it('reads every WCA scramble format', () => {
    expect(cubeTwisty(4).parse("Rw2 3Fw' U Uw2 x' 2R 2-3Lw")).toHaveLength(7);
    expect(cubeTwisty(7).parse("3Bw2 Uw 3Fw2 Bw Rw2 3Bw2 D'")).toHaveLength(7);
    expect(cubeTwisty(3).parse("F L' U D L2 B R F2 Dw")).toHaveLength(9);
    expect(megaminxTwisty().parse("R-- D++ R-- D++ R++ D-- R-- D-- R++ D-- U'\nR-- D-- R++ D-- R-- D-- R-- D++ R-- D-- U'")).toHaveLength(22);
    expect(pyraminxTwisty().parse("L R L U' R' L' U R' U' r l'")).toHaveLength(11);
    expect(skewbTwisty().parse("U L' U B' U' L' R L R' U B'")).toHaveLength(11);
    expect(cubeTwisty(3).parse('R Q')).toBeNull();
  });

  it("every key of csTimer's layout makes a move the puzzle can do", () => {
    const codes = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => `Key${c}`).concat(['Semicolon', 'Comma', 'Period', 'Slash'], [...'0123456789'].map((d) => `Digit${d}`));
    for (const t of [cubeTwisty(2), cubeTwisty(3), cubeTwisty(5), pyraminxTwisty(), skewbTwisty(), megaminxTwisty()]) {
      let moves = 0;
      for (const code of codes) {
        const r = t.key(code);
        if (r && 'move' in r) {
          moves++;
          expect(() => t.puzzle.applyMove(t.puzzle.solved(), r.move), `${t.id} ${code}`).not.toThrow();
        }
      }
      expect(moves, t.id).toBeGreaterThan(15);
    }
    // I is R, J is U and so on, as on csTimer
    const c = cubeTwisty(3);
    expect(c.name((c.key('KeyI') as { move: never }).move)).toBe('R');
    expect(c.name((c.key('KeyF') as { move: never }).move)).toBe("U'");
    expect(c.name((c.key('Semicolon') as { move: never }).move)).toBe('y');
    expect(c.name((c.key('KeyU') as { move: never }).move)).toBe('Rw');
  });

  it('the depth keys make outer moves deeper on big cubes', () => {
    const t = cubeTwisty(5);
    expect(t.key('Digit7')).toEqual({ depth: true });
    t.pressDepth('Digit7');
    expect(t.name((t.key('KeyI') as { move: never }).move)).toBe('Rw');
    t.resetDepth();
    expect(t.name((t.key('KeyI') as { move: never }).move)).toBe('R');
  });

  it('looking up what every key does (the key legend) leaves the depth alone', () => {
    const t = cubeTwisty(3);
    for (const d of '1234567890') t.key(`Digit${d}`);
    expect(t.name((t.key('KeyD') as { move: never }).move)).toBe('L');
    expect(t.name((t.key('KeyE') as { move: never }).move)).toBe("L'");
    expect(t.name((t.key('KeyI') as { move: never }).move)).toBe('R');
  });
});
