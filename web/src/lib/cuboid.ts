// Scramble previews for the cuboids, which neither cubing.js nor csTimer draws: floppy (1x3x3), tower
// (2x2x3), domino (2x3x3), 3x3x4 and 3x3x6. The scramble is applied to a model of the puzzle's stickers,
// and the result laid out as a net (U above L F R B, D below F), in csTimer's cube colours, so it's
// redrawn as csTimer's drawings are (lib/drawnNet, components/DrawnNet): every net in cubr looks alike.
//
// The model is the same for any size: each sticker is a piece's position and the way it faces, and a
// move turns every sticker in its layers about the move's axis. __tests__/cuboid.test.ts checks it
// against cubing.js: as a 3x3x3 and a 4x4x4 (slices and wide turns too) it must give cubing.js's state
// sticker for sticker, and a tower or domino must match a 3x3x3 with the same moves wherever the two
// have the same stickers.
//
// 3x3x5 and 3x3x7 aren't drawn: their scrambles end in a 3x3 scramble after "/", whose quarter turns of
// R, F, L and B have no clear meaning on a cuboid whose sides only half-turn (csTimer draws neither).
import type { Drawing, DrawnShape } from './drawnNet';

/** pieces from left to right (R-L), bottom to top (U-D) and back to front (F-B) */
export interface Dims {
  x: number;
  y: number;
  z: number;
}

/** the cuboid events cubr draws, by their pieces along each axis */
export const CUBOIDS: Readonly<Record<string, Dims>> = {
  '133': { x: 3, y: 1, z: 3 },
  '223': { x: 2, y: 3, z: 2 },
  '233': { x: 3, y: 2, z: 3 },
  '334': { x: 3, y: 4, z: 3 },
  '336': { x: 3, y: 6, z: 3 },
};

type Vec = [number, number, number];
type Axis = 0 | 1 | 2;
type FaceName = 'U' | 'R' | 'F' | 'D' | 'L' | 'B';

/** each face: the axis and side it faces, and csTimer's colour for it (as in its cube drawings) */
const FACES: Readonly<Record<FaceName, { axis: Axis; side: 1 | -1; colour: string }>> = {
  U: { axis: 1, side: 1, colour: '#ffffff' },
  D: { axis: 1, side: -1, colour: '#ffff00' },
  R: { axis: 0, side: 1, colour: '#ff0000' },
  L: { axis: 0, side: -1, colour: '#ffaa00' },
  F: { axis: 2, side: 1, colour: '#00dd00' },
  B: { axis: 2, side: -1, colour: '#0000ff' },
};

/** a sticker: its piece's centre (in half-piece units, so the middle of the puzzle is 0) and the way it faces */
interface Sticker {
  at: Vec;
  facing: Vec;
  colour: string;
}

const size = (d: Dims, axis: Axis) => [d.x, d.y, d.z][axis];

/** a quarter turn (+90 degrees, right-handed) about an axis, `k` times */
function rotate(v: Vec, axis: Axis, k: number): Vec {
  let [x, y, z] = v;
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) {
    if (axis === 0) [y, z] = [-z, y];
    else if (axis === 1) [x, z] = [z, -x];
    else [x, y] = [-y, x];
  }
  return [x, y, z];
}

export function solvedStickers(d: Dims): Sticker[] {
  const out: Sticker[] = [];
  const along = (n: number) => Array.from({ length: n }, (_, i) => 2 * i - (n - 1));
  for (const face of Object.values(FACES)) {
    const [a, b] = ([0, 1, 2] as Axis[]).filter((ax) => ax !== face.axis);
    for (const u of along(size(d, a)))
      for (const v of along(size(d, b))) {
        const at: Vec = [0, 0, 0];
        at[face.axis] = face.side * (size(d, face.axis) - 1);
        at[a] = u;
        at[b] = v;
        const facing: Vec = [0, 0, 0];
        facing[face.axis] = face.side;
        out.push({ at, facing, colour: face.colour });
      }
  }
  return out;
}

/** a move: the layers it turns (piece centres along `axis`) and by how many quarter turns about +axis */
interface Move {
  axis: Axis;
  layers: number[];
  turns: number;
}

/**
 * One move of a cuboid scramble, null if it isn't one: a face (U), a slice (3U, SiGN) or a block of
 * layers from a face (u or 3u, SiGN; Uw or 3Uw), the middle slices M, E and S, each as is, ' or 2.
 * A quarter turn of a layer that isn't square (a tower's or domino's R) can only be a half turn, which
 * is how floppy scrambles are written (R is a half turn).
 */
export function parseMove(token: string, d: Dims): Move | null {
  const m = /^(\d*)([URFDLBurfdlb]|[MES])(w?)(2'|2|')?$/.exec(token);
  if (!m) return null;
  const [, num, letter, w, amount] = m;
  const n = num ? Number(num) : null;
  let axis: Axis;
  let from: number[];
  let side: 1 | -1;
  if ('MES'.includes(letter)) {
    if (n !== null || w) return null;
    // M turns as L does, E as D, S as F; the middle layer of an odd number of pieces
    ({ axis, side } = { M: FACES.L, E: FACES.D, S: FACES.F }[letter as 'M' | 'E' | 'S']);
    const count = size(d, axis);
    if (count % 2 === 0 || count < 3) return null;
    from = [0];
  } else {
    const face = FACES[letter.toUpperCase() as FaceName];
    ({ axis, side } = face);
    const count = size(d, axis);
    const wide = letter !== letter.toUpperCase() || w === 'w';
    const depth = wide ? (n ?? 2) : 1;
    const slice = !wide && n !== null ? n : null;
    if (depth > count || (slice !== null && (slice < 1 || slice > count))) return null;
    // the layers counted from the face, as piece centres along its axis
    const layer = (i: number) => side * (count - 1 - 2 * i);
    from = slice !== null ? [layer(slice - 1)] : Array.from({ length: depth }, (_, i) => layer(i));
  }
  // clockwise seen from the face it turns as: -90 degrees about the face's own outward axis
  let turns = amount === '2' || amount === "2'" ? 2 : amount === "'" ? 1 : 3;
  if (side === -1) turns = (4 - turns) % 4;
  const [a, b] = ([0, 1, 2] as Axis[]).filter((ax) => ax !== axis);
  if (turns % 2 === 1 && size(d, a) !== size(d, b)) turns = 2;
  return { axis, layers: from, turns };
}

function apply(stickers: Sticker[], move: Move): Sticker[] {
  return stickers.map((s) =>
    move.layers.includes(s.at[move.axis]) ? { ...s, at: rotate(s.at, move.axis, move.turns), facing: rotate(s.facing, move.axis, move.turns) } : s,
  );
}

/** The stickers after `scramble` (whitespace between moves), null if a move isn't one. */
export function scrambled(d: Dims, scramble: string): Sticker[] | null {
  let stickers = solvedStickers(d);
  for (const token of scramble.split(/\s+/)) {
    if (!token) continue;
    const move = parseMove(token, d);
    if (!move) return null;
    stickers = apply(stickers, move);
  }
  return stickers;
}

/** each face's stickers as rows and columns, as the face is seen from outside (U with F below it, D with F above it) */
export type Faces = Record<FaceName, string[][]>;

export function faceGrids(d: Dims, stickers: Sticker[]): Faces {
  const blank = (rows: number, cols: number) => Array.from({ length: rows }, () => Array<string>(cols).fill(''));
  const grids: Faces = { U: blank(d.z, d.x), D: blank(d.z, d.x), F: blank(d.y, d.x), B: blank(d.y, d.x), R: blank(d.y, d.z), L: blank(d.y, d.z) };
  // index from the low end (left, bottom, back) and from the high end
  const lo = (v: number, n: number) => (v + n - 1) / 2;
  const hi = (v: number, n: number) => (n - 1 - v) / 2;
  for (const {
    at: [x, y, z],
    facing,
    colour,
  } of stickers) {
    const face = (Object.keys(FACES) as FaceName[]).find((f) => facing[FACES[f].axis] === FACES[f].side)!;
    const [row, col] = {
      U: [lo(z, d.z), lo(x, d.x)],
      D: [hi(z, d.z), lo(x, d.x)],
      F: [hi(y, d.y), lo(x, d.x)],
      B: [hi(y, d.y), hi(x, d.x)],
      R: [hi(y, d.y), hi(z, d.z)],
      L: [hi(y, d.y), lo(z, d.z)],
    }[face];
    grids[face][row][col] = colour;
  }
  return grids;
}

/** the gap between faces in the net, in stickers (DrawnNet then draws them as close as cubr's nets are) */
const GAP = 0.5;

/** The net as a drawing: one unit square per sticker, each face apart from the next. */
export function netDrawing(d: Dims, faces: Faces): Drawing {
  const left = { L: 0, F: d.z + GAP, R: d.z + d.x + 2 * GAP, B: 2 * d.z + d.x + 3 * GAP, U: d.z + GAP, D: d.z + GAP };
  const top = { U: 0, L: d.z + GAP, F: d.z + GAP, R: d.z + GAP, B: d.z + GAP, D: d.z + d.y + 2 * GAP };
  const shapes: DrawnShape[] = [];
  for (const face of ['U', 'L', 'F', 'R', 'B', 'D'] as FaceName[]) {
    faces[face].forEach((row, r) =>
      row.forEach((fill, c) => {
        const [x, y] = [left[face] + c, top[face] + r];
        shapes.push({
          fill,
          points: [
            [x, y],
            [x + 1, y],
            [x + 1, y + 1],
            [x, y + 1],
          ],
        });
      }),
    );
  }
  return { shapes, texts: [] };
}

/** The net of `scramble` on the cuboid `event`, null if cubr doesn't draw that puzzle or can't read the scramble. */
export function cuboidDrawing(event: string, scramble: string): Drawing | null {
  const d = CUBOIDS[event];
  const stickers = d ? scrambled(d, scramble) : null;
  return d && stickers ? netDrawing(d, faceGrids(d, stickers)) : null;
}
