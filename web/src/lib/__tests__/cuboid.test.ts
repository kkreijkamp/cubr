import { describe, expect, it } from 'vitest';
import { KPuzzle } from 'cubing/kpuzzle';
import { ExperimentalPGNotation, getPuzzleDescriptionString, getPuzzleGeometryByDesc } from 'cubing/puzzle-geometry';
import { randomMoveScramble } from '@cubr/cubestats';
import { CUBOIDS, cuboidDrawing, faceGrids, parseMove, scrambled, type Dims, type Faces } from '../cuboid';
import { buildDrawnNet } from '../drawnNet';
import { stickerSources } from '../scrambleNet';

// The cuboid nets: one model of a puzzle's stickers for any size (lib/cuboid). It's checked against
// cubing.js, which cubr didn't write: as a 3x3x3 and a 4x4x4 it must give cubing.js's state for random
// scrambles with face, wide and slice turns, and a tower or domino must match a 3x3x3 turned the same
// way wherever the two have the same stickers. The nets' layout is checked by moves anyone can picture.

const CUBE: Dims = { x: 3, y: 3, z: 3 };
const FOUR: Dims = { x: 4, y: 4, z: 4 };
const [W, Y, G, B, R, O] = ['#ffffff', '#ffff00', '#00dd00', '#0000ff', '#ff0000', '#ffaa00'];

const grids = (d: Dims, alg: string): Faces => faceGrids(d, scrambled(d, alg)!);
/** a face's colours, row by row, as one letter each (w y g b r o) */
const LETTER: Record<string, string> = { [W]: 'w', [Y]: 'y', [G]: 'g', [B]: 'b', [R]: 'r', [O]: 'o' };
const rows = (face: string[][]) => face.map((row) => row.map((c) => LETTER[c]).join(''));
const flat = (f: Faces) => (['U', 'L', 'F', 'R', 'B', 'D'] as const).flatMap((k) => f[k].flat());

/** cubing.js's puzzle from its geometry, and the colour of each of its stickers after `alg` */
function cubing(description: string) {
  const pg = getPuzzleGeometryByDesc(description, { allMoves: true });
  const notation = new ExperimentalPGNotation(pg, pg.getOrbitsDef(true));
  const kpuzzle = new KPuzzle(notation.remapKPuzzleDefinition(pg.getKPuzzleDefinition(true)), { experimentalPGNotation: notation });
  const svg = pg.generatesvg();
  const stickers = [...svg.matchAll(/<polygon\b[^>]*>/g)].map(([tag]) => ({
    id: /(?<![\w-])id="(\w+-l\d+-o\d+)"/.exec(tag)![1],
    fill: /fill:\s*(#[0-9a-f]{6})/i.exec(tag)![1].toLowerCase(),
  }));
  const solved = new Map(stickers.map((s) => [s.id, s.fill]));
  // cubing.js's colours as csTimer's (lib/cuboid draws in csTimer's)
  const ours: Record<string, string> = { '#ffffff': W, '#f4f400': Y, '#44ee00': G, '#2266ff': B, '#ff0000': R, '#ff8000': O };
  return (alg: string) => {
    const src = stickerSources(kpuzzle.definition.orbits, kpuzzle.defaultPattern().applyAlg(alg).patternData);
    return stickers.map((s) => ours[solved.get(src.get(s.id)!)!]);
  };
}

/**
 * Pairs each sticker of one model with a sticker of the other that has the same colours after every
 * alg: none left over means the two states agree, however the two lay their stickers out.
 */
function unmatched(a: string[][], b: string[][]): number {
  const sigs = (xs: string[][]) => xs[0].map((_, i) => xs.map((x) => x[i]).join(' '));
  const bag = new Map<string, number>();
  for (const s of sigs(b)) bag.set(s, (bag.get(s) ?? 0) + 1);
  let missing = 0;
  for (const s of sigs(a)) {
    const n = bag.get(s) ?? 0;
    if (n) bag.set(s, n - 1);
    else missing++;
  }
  return missing;
}

/** a random scramble of `n` moves from `moves`, each as is, ' or 2 */
function randomAlg(moves: string[], n: number, seed: number): string {
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: n }, () => moves[Math.floor(next() * moves.length)] + ['', "'", '2'][Math.floor(next() * 3)]).join(' ');
}

describe('the cuboid model', () => {
  it('turns faces as anyone pictures them: R lifts the front up, U brings the right to the front, F turns the top to the right', () => {
    expect(rows(grids(CUBE, 'R').U)).toEqual(['wwg', 'wwg', 'wwg']);
    expect(rows(grids(CUBE, 'R').F)).toEqual(['ggy', 'ggy', 'ggy']);
    expect(rows(grids(CUBE, 'R').B)).toEqual(['wbb', 'wbb', 'wbb']);
    expect(rows(grids(CUBE, 'U').F)).toEqual(['rrr', 'ggg', 'ggg']);
    expect(rows(grids(CUBE, 'U').L)).toEqual(['ggg', 'ooo', 'ooo']);
    expect(rows(grids(CUBE, 'F').U)).toEqual(['www', 'www', 'ooo']);
    expect(rows(grids(CUBE, 'F').R)).toEqual(['wrr', 'wrr', 'wrr']);
    expect(rows(grids(CUBE, 'D').F)).toEqual(['ggg', 'ggg', 'ooo']);
    expect(rows(grids(CUBE, 'L').F)).toEqual(['wgg', 'wgg', 'wgg']);
    expect(rows(grids(CUBE, 'B').U)).toEqual(['rrr', 'www', 'www']);
    // the middle slices turn as the face they follow: M as L, E as D, S as F
    expect(rows(grids(CUBE, 'M').U)).toEqual(['wbw', 'wbw', 'wbw']);
    expect(rows(grids(CUBE, 'E').F)).toEqual(['ggg', 'ooo', 'ggg']);
    expect(rows(grids(CUBE, 'S').U)).toEqual(['www', 'ooo', 'www']);
  });

  it('reads SiGN: u is the top two layers, 2U the second alone; M is 2L, E is 2D, S is 2F', () => {
    expect(rows(grids(FOUR, 'u').F)).toEqual(['rrrr', 'rrrr', 'gggg', 'gggg']);
    expect(rows(grids(FOUR, '2U').F)).toEqual(['gggg', 'rrrr', 'gggg', 'gggg']);
    expect(rows(grids(FOUR, '3u').F)).toEqual(['rrrr', 'rrrr', 'rrrr', 'gggg']);
    expect(grids(FOUR, 'Uw')).toEqual(grids(FOUR, 'u'));
    expect(grids(FOUR, '3Uw2')).toEqual(grids(FOUR, '3u2'));
    expect(grids(CUBE, 'M')).toEqual(grids(CUBE, '2L'));
    expect(grids(CUBE, 'M')).toEqual(grids(CUBE, "2R'"));
    expect(grids(CUBE, 'E')).toEqual(grids(CUBE, '2D'));
    expect(grids(CUBE, 'S')).toEqual(grids(CUBE, '2F'));
  });

  it("gives cubing.js's 3x3x3 and 4x4x4, sticker for sticker, after random face, wide and slice turns", () => {
    for (const [d, description, moves] of [
      [CUBE, '3x3x3', ['U', 'D', 'R', 'L', 'F', 'B', 'u', 'r', 'f', '2U', '2R', '2F']],
      [FOUR, '4x4x4', ['U', 'D', 'R', 'L', 'F', 'B', 'u', 'r', 'f', 'd', '2U', '2R', '2F', '3u', '3r', '3f']],
    ] as const) {
      const theirs = cubing(getPuzzleDescriptionString(description));
      const algs = ['', ...Array.from({ length: 7 }, (_, i) => randomAlg([...moves], 30, 11 + i))];
      const ours = algs.map((a) => flat(grids(d, a)));
      const cubed = algs.map(theirs);
      expect(ours[0]).toHaveLength(cubed[0].length);
      expect(unmatched(ours, cubed), description).toBe(0);
      // a test that can fail: every move turned the other way
      const back = algs.map((a) =>
        flat(
          grids(
            d,
            a.replace(/(\S+?)('?)(?=\s|$)/g, (_, m: string, p: string) => (m.endsWith('2') ? m : p ? m : `${m}'`)),
          ),
        ),
      );
      expect(unmatched(back, cubed), `${description} reversed`).toBeGreaterThan(ours[0].length / 4);
    }
  }, 60_000);

  it('draws a tower or a domino as a 3x3x3 turned the same way, wherever the two have the same stickers', () => {
    // the tower is a 3x3x3 without its middle slices; the domino, without its middle layer
    const towerMoves = ['U', "U'", 'U2', 'D', "D'", 'D2', 'R2', 'F2'];
    const dominoMoves = ['U', "U'", 'U2', 'R2', 'L2', 'F2', 'B2'];
    for (let seed = 1; seed <= 20; seed++) {
      let s = seed;
      const pick = (xs: string[]) => xs[(s = (s * 48271) % 2147483647) % xs.length];
      const tower = Array.from({ length: 25 }, () => pick(towerMoves)).join(' ');
      const domino = Array.from({ length: 25 }, () => pick(dominoMoves)).join(' ');
      const [t, c1] = [grids(CUBOIDS['223'], tower), grids(CUBE, tower)];
      const keep = <T>(xs: T[], at: number[]) => at.map((i) => xs[i]);
      for (const f of ['U', 'D'] as const) expect(t[f], tower).toEqual(keep(c1[f], [0, 2]).map((row) => keep(row, [0, 2])));
      for (const f of ['F', 'B', 'R', 'L'] as const) expect(t[f], tower).toEqual(c1[f].map((row) => keep(row, [0, 2])));
      const [dm, c2] = [grids(CUBOIDS['233'], domino), grids(CUBE, domino)];
      for (const f of ['U', 'D'] as const) expect(dm[f], domino).toEqual(c2[f]);
      for (const f of ['F', 'B', 'R', 'L'] as const) expect(dm[f], domino).toEqual(keep(c2[f], [0, 2]));
    }
  });

  it('flips a floppy cube: R is a half turn, as floppy scrambles write it', () => {
    const f = grids(CUBOIDS['133'], 'R');
    expect(rows(f.U)).toEqual(['wwy', 'wwy', 'wwy']);
    expect(rows(f.D)).toEqual(['yyw', 'yyw', 'yyw']);
    expect(rows(f.F)).toEqual(['ggb']);
    expect(rows(f.B)).toEqual(['gbb']);
    expect(grids(CUBOIDS['133'], "R'")).toEqual(f);
    expect(grids(CUBOIDS['133'], 'R R')).toEqual(grids(CUBOIDS['133'], ''));
  });

  it('turns a 3x3x4 and a 3x3x6 by its top layers, and its columns by half turns', () => {
    expect(rows(grids(CUBOIDS['334'], 'u').F)).toEqual(['rrr', 'rrr', 'ggg', 'ggg']);
    expect(rows(grids(CUBOIDS['336'], '3u').F)).toEqual(['rrr', 'rrr', 'rrr', 'ggg', 'ggg', 'ggg']);
    expect(rows(grids(CUBOIDS['334'], 'M2').U)).toEqual(['wyw', 'wyw', 'wyw']);
    expect(rows(grids(CUBOIDS['334'], 'M2').F)).toEqual(['gbg', 'gbg', 'gbg', 'gbg']);
    expect(rows(grids(CUBOIDS['334'], 'R2').R)).toEqual(['rrr', 'rrr', 'rrr', 'rrr']);
    expect(rows(grids(CUBOIDS['334'], 'S2').R)).toEqual(['ror', 'ror', 'ror', 'ror']);
  });

  it("reads every scramble cubr makes for them, and keeps each face's sticker count", () => {
    const samples: Record<string, string[]> = {
      // csTimer's own (random state), as cstimer_module 0.1.5 writes them: a tower's moves can end in a space
      '133': ['F R L', 'B L F R B L', 'R'],
      '223': ["U2 R2 D' R2 F2 U  R2 U' F2 U ", 'F2 D2 R2 U F2 U2 R2 D'],
    };
    for (const [event, d] of Object.entries(CUBOIDS)) {
      const algs = samples[event] ?? Array.from({ length: 10 }, () => randomMoveScramble(event)!);
      for (const alg of algs) {
        const f = faceGrids(d, scrambled(d, alg) ?? []);
        expect(scrambled(d, alg), `${event}: ${alg}`).not.toBeNull();
        expect(Object.values(f).flat(2).every(Boolean), `${event}: ${alg}`).toBe(true);
        // as many of each colour as a face has stickers
        const counts = new Map<string, number>();
        for (const c of Object.values(f).flat(2)) counts.set(c, (counts.get(c) ?? 0) + 1);
        expect(counts.get(W)).toBe(d.x * d.z);
        expect(counts.get(G)).toBe(d.x * d.y);
        expect(counts.get(R)).toBe(d.z * d.y);
      }
    }
  });

  it('refuses what a cuboid has no move for, and the cuboids it does not draw', () => {
    expect(parseMove('x', CUBE)).toBeNull();
    expect(parseMove('M', FOUR)).toBeNull(); // no middle layer
    expect(parseMove('5u', FOUR)).toBeNull();
    expect(parseMove('3U', { x: 3, y: 2, z: 3 })).toBeNull();
    expect(scrambled(CUBOIDS['334'], 'U R2 Q')).toBeNull();
    expect(cuboidDrawing('335', 'U R2 / R U')).toBeNull();
    expect(cuboidDrawing('337', 'U')).toBeNull();
    expect(cuboidDrawing('333', 'R U')).toBeNull();
  });

  it('lays the net out as the redrawn nets are: six faces, each a plate of its stickers', () => {
    const drawing = cuboidDrawing('334', "U R2 u' F2 M2")!;
    expect(drawing.shapes).toHaveLength(2 * 9 + 4 * 12);
    const net = buildDrawnNet(drawing, 'net')!;
    expect(net.plates).toHaveLength(6);
    expect(net.stickers).toHaveLength(66);
  });
});
