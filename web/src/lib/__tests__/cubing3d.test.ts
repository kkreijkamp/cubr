import { describe, expect, it } from 'vitest';
import { KPuzzle } from 'cubing/kpuzzle';
import { ExperimentalPGNotation, getPuzzleDescriptionString, getPuzzleGeometryByDesc } from 'cubing/puzzle-geometry';
import { puzzles } from 'cubing/puzzles';
import { randomMoveScramble } from '@cubr/cubestats';
import { DESCRIPTIONS, PREVIEW_3D_TYPES, preview3D, type Puzzle3D } from '../cubing3d';
import { ICOSAMATE_COLOURS } from '../drawnNet';
import { stickerSources } from '../scrambleNet';
import fixtures from './fixtures/cstimer/preview3d.json';

// csTimer's drawings of real scrambles (scripts/cstimer-fixtures.ts, cstimer_module 0.1.5): per type,
// the solved puzzle and three scrambles, each sticker's colour an index into the type's palette
const FIXTURES = fixtures as unknown as Record<string, { event: string; palette: string[]; drawings: [string, string][] }>;

// each csTimer colour as cubing.js colours the same face (csTimer's palettes, by its face names,
// against cubing.js's puzzle-geometry colours); the icosahedra were lined up by their U and F faces
const CUBE = { '#ffffff': '#ffffff', '#ff0000': '#ff0000', '#00dd00': '#44ee00', '#ffff00': '#f4f400', '#ffaa00': '#ff8000', '#0000ff': '#2266ff' };
const DODECAHEDRON = {
  '#ffffff': '#ffffff', '#006600': '#008800', '#dd0000': '#ff0000', '#0000bb': '#0000ff', '#ffcc00': '#f4f400', '#8811ff': '#8800dd',
  '#999999': '#888888', '#77ee00': '#99ff00', '#ff8833': '#ff8000', '#88ddff': '#3399ff', '#ffffbb': '#e8d0a0', '#ff99ff': '#ff66cc',
};
const OCTAHEDRON = { '#ffffff': '#ffffff', '#ff0000': '#ff0000', '#880088': '#8800dd', '#00dd00': '#44ee00', '#ffff00': '#f4f400', '#ffaa00': '#ff8000', '#bbbbbb': '#888888', '#0000ff': '#2266ff' };
const TETRAHEDRON = { '#00ff00': '#44ee00', '#ff0000': '#ff0000', '#0000ff': '#2266ff', '#ffff00': '#f4f400' };
// the icosahedron: the map the 2D net draws in too, so this also checks that 2D and 3D colour it alike
const ICOSAHEDRON = ICOSAMATE_COLOURS;
const BY_FACES: Record<number, Record<string, string>> = { 4: TETRAHEDRON, 6: CUBE, 8: OCTAHEDRON, 12: DODECAHEDRON, 20: ICOSAHEDRON };

/** cubing.js's puzzle and its net, as <twisty-player> loads it (a description: cubing.js's customPGPuzzleLoader) */
const loaded = new Map<string, Promise<{ kpuzzle: KPuzzle; svg: string }>>();
function load(p: Puzzle3D) {
  const key = 'id' in p ? p.id : p.description;
  if (!loaded.has(key)) {
    loaded.set(
      key,
      (async () => {
        if ('id' in p) return { kpuzzle: await puzzles[p.id].kpuzzle(), svg: await puzzles[p.id].svg() };
        const pg = getPuzzleGeometryByDesc(p.description, { allMoves: true, orientCenters: true, addRotations: true });
        const notation = new ExperimentalPGNotation(pg, pg.getOrbitsDef(true));
        return { kpuzzle: new KPuzzle(notation.remapKPuzzleDefinition(pg.getKPuzzleDefinition(true)), { experimentalPGNotation: notation }), svg: pg.generatesvg() };
      })(),
    );
  }
  return loaded.get(key)!;
}

/** the colour of each of cubing.js's stickers after `alg` (a centre it orients, one sticker per orientation, counted once) */
async function cubingColours(p: Puzzle3D, alg: string): Promise<string[]> {
  const { kpuzzle, svg } = await load(p);
  const stickers = [...svg.matchAll(/<polygon\b[^>]*>/g)].flatMap(([tag]) => {
    const id = /\bid="(\w+-l\d+-o\d+)"/.exec(tag)?.[1];
    return id ? [{ id, fill: /fill:\s*(#[0-9a-f]{6})/i.exec(tag)![1].toLowerCase() }] : [];
  });
  const solved = new Map(stickers.map((s) => [s.id, s.fill]));
  const fills = new Map<string, Set<string>>();
  for (const s of stickers) fills.set(s.id.replace(/-o\d+$/, ''), (fills.get(s.id.replace(/-o\d+$/, '')) ?? new Set()).add(s.fill));
  const src = stickerSources(kpuzzle.definition.orbits, kpuzzle.defaultPattern().applyAlg(alg).patternData);
  return stickers.filter((s) => fills.get(s.id.replace(/-o\d+$/, ''))!.size > 1 || /-o0$/.test(s.id)).map((s) => solved.get(src.get(s.id)!)!);
}

/**
 * Pairs each of csTimer's stickers with a cubing.js sticker that has the same colours in every
 * drawing. No `missing` means the states match, whichever way the two nets lay their stickers out;
 * `left` are the cubing.js stickers no csTimer sticker took, by their colours.
 */
function pair(cstimer: string[][], cubing: string[][]): { missing: number; left: string[] } {
  const sigs = (xs: string[][]) => xs[0].map((_, i) => xs.map((x) => x[i]).join(' '));
  const bag = new Map<string, number>();
  for (const s of sigs(cubing)) bag.set(s, (bag.get(s) ?? 0) + 1);
  let missing = 0;
  for (const s of sigs(cstimer)) {
    const n = bag.get(s) ?? 0;
    if (n) bag.set(s, n - 1);
    else missing++;
  }
  return { missing, left: [...bag].flatMap(([s, n]) => Array<string>(n).fill(s)) };
}

/** the type's drawings, csTimer's and cubing.js's colours, with the moves `tweak`ed (a wrong translation, for the test of the test) */
async function compare(type: string, tweak: (alg: string) => string = (a) => a) {
  const { event, palette, drawings } = FIXTURES[type];
  const colours = BY_FACES[palette.length];
  const puzzle = preview3D(event, type, drawings[1][0])!.puzzle;
  const cstimer = drawings.map(([, c]) => [...c].map((d) => colours[palette[parseInt(d, 36)]]));
  const cubing = await Promise.all(drawings.map(([s]) => cubingColours(puzzle, s ? tweak(preview3D(event, type, s)!.alg) : '')));
  return { cstimer, cubing };
}

describe('preview3D', () => {
  it("describes each puzzle as cubing.js's puzzle geometry names it", () => {
    for (const [name, description] of Object.entries(DESCRIPTIONS)) expect(getPuzzleDescriptionString(name), name).toBe(description);
  });

  it('translates only the scramble types cubing.js shows in 3D once translated', () => {
    expect(preview3D('giga', undefined, "R++ d- y2'")).toEqual({ puzzle: { id: 'gigaminx' }, alg: "2-5L2' 3-5U Uv2'" });
    expect(preview3D('minx', 'mgmc', "+- U'")).toEqual({ puzzle: { id: 'megaminx' }, alg: "R++ D-- U'" });
    expect(preview3D('minx', 'mgmso', "DBL2' DR")).toEqual({ puzzle: { id: 'megaminx' }, alg: "DL2' FR" });
    expect(preview3D('dino', undefined, "F l'")).toEqual({ puzzle: { description: DESCRIPTIONS.dino }, alg: "UFR DFL'" });
    expect(preview3D('mpyr', 'mpyr', "u' U Bw'")).toEqual({ puzzle: { description: DESCRIPTIONS['master pyraminx'] }, alg: "U' 1-2U 1-3B'" });
    expect(preview3D('ctico', undefined, "UrUl2 LBl'")?.alg).toBe("UGJMQ2' JGEIS");
    // what cubing.js reads as it is, or has no model of
    expect(preview3D('minx', undefined, 'R++ D-- U')).toBeNull();
    expect(preview3D('mpyr', undefined, 'U L')).toBeNull();
    expect(preview3D('333', undefined, 'R U')).toBeNull();
    expect(preview3D('gear', undefined, 'R U')).toBeNull();
    expect(preview3D('r234', undefined, '2x2: R U')).toBeNull();
    // another event's type, a move that isn't the type's, nothing to show
    expect(preview3D('999', '888', 'R U')).toBeNull();
    expect(preview3D('dino', undefined, 'F U')).toBeNull();
    expect(preview3D('heli', undefined, '  ')).toBeNull();
  });

  it("has csTimer's drawings of every type it translates", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...PREVIEW_3D_TYPES].sort());
  });

  it.each(PREVIEW_3D_TYPES)('shows %s as csTimer draws it, sticker for sticker', async (type) => {
    const { cstimer, cubing } = await compare(type);
    const { missing, left } = pair(cstimer, cubing);
    expect(missing).toBe(0);
    if (type === 'helicv') {
      // cubing.js's curvy copter has a fixed centre on each face, which the real one hasn't
      expect(left).toHaveLength(6);
      for (const s of left) expect(new Set(s.split(' ')).size, s).toBe(1);
    } else expect(left).toEqual([]);
  }, 60_000);

  it('notices a move turned the wrong way', async () => {
    const flip = (alg: string) => alg.replace(/\S+/g, (m) => (m.endsWith("'") ? m.slice(0, -1) : `${m}'`));
    for (const type of ['dinoso', 'ctico', 'mpyr', 'giga']) {
      const { cstimer, cubing } = await compare(type, flip);
      expect(pair(cstimer, cubing).missing, type).toBeGreaterThan(cstimer[0].length / 4);
    }
  }, 60_000);

  it("reads every random-move scramble cubr makes of them, and cubing.js applies it", async () => {
    for (const type of PREVIEW_3D_TYPES) {
      const event = FIXTURES[type].event;
      for (let i = 0; i < 10; i++) {
        const scramble = randomMoveScramble(type);
        if (scramble === null) break; // made by csTimer: the fixtures' scrambles cover it
        const t = preview3D(event, type, scramble);
        expect(t, `${type}: ${scramble}`).not.toBeNull();
        const { kpuzzle } = await load(t!.puzzle);
        expect(() => kpuzzle.defaultPattern().applyAlg(t!.alg), `${type}: ${t!.alg}`).not.toThrow();
      }
    }
  }, 60_000);
});
