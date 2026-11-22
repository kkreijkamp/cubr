// Scramble preview nets. cubing.js has a 2D net for each puzzle: an SVG with one shape per sticker,
// id "ORBIT-l<piece>-o<orientation>", coloured for the solved puzzle. The preview keeps that layout
// and that mapping from a scrambled state to stickers, but redraws every sticker as a flat rounded
// tile with a gap around it, in cubr's sticker colours. Everything here is pure (no DOM).

export type Point = [number, number];
/** a 2D affine transform [a, b, c, d, e, f], as in SVG: x' = a x + c y + e, y' = b x + d y + f */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function transformPoint(m: Matrix, [x, y]: Point): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** an SVG transform attribute, e.g. "translate(5,40) scale(40)" or "rotate(120 130 88)" */
export function parseTransform(value: string | null | undefined): Matrix {
  let m = IDENTITY;
  for (const [, fn, args] of (value ?? '').matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
    const rad = ((a[0] ?? 0) * Math.PI) / 180;
    let t: Matrix;
    switch (fn) {
      case 'translate':
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case 'scale':
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const [, cx = 0, cy = 0] = a;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        t = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(rad), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(rad), 0, 1, 0, 0];
        break;
      case 'matrix':
        t = [a[0], a[1], a[2], a[3], a[4], a[5]];
        break;
      default:
        continue;
    }
    m = multiply(m, t);
  }
  return m;
}

/** a polygon's "points" attribute */
export function parsePoints(value: string | null | undefined): Point[] {
  const n = (value ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  const out: Point[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
}

/** the corners of a path made of straight lines (M/L/H/V/Z, absolute or relative); throws on curves */
export function pathPoints(d: string): Point[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: Point[] = [];
  let x = 0;
  let y = 0;
  let cmd = '';
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === 'z' || cmd === 'Z') break;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toLowerCase()) {
      case 'm':
      case 'l': {
        const dx = num();
        const dy = num();
        x = rel ? x + dx : dx;
        y = rel ? y + dy : dy;
        // further pairs after a moveto are linetos
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'h':
        x = rel ? x + num() : num();
        break;
      case 'v':
        y = rel ? y + num() : num();
        break;
      default:
        throw new Error(`unsupported path command "${cmd}"`);
    }
    out.push([x, y]);
  }
  return out;
}

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

export function signedArea(points: Point[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/** drops repeated corners and corners on a straight edge */
export function corners(points: Point[], eps: number): Point[] {
  let pts = points.filter((p, i) => {
    const q = points[(i + 1) % points.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > eps;
  });
  for (let changed = true; changed && pts.length > 3; ) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i + pts.length - 1) % pts.length];
      const next = pts[(i + 1) % pts.length];
      if (Math.abs(cross(prev, pts[i], next)) <= eps * Math.hypot(next[0] - prev[0], next[1] - prev[1])) {
        pts = pts.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/**
 * A simple polygon, convex or not, moved in by `d` on every side, or null when a side would turn
 * round or vanish (moved in further than the shape is wide there). Corners stay sharp: a convex one
 * moves in along its bisector, a concave one out. `sign`: which way round "in" is, by default the
 * polygon's own winding; a hole in a shape goes round the other way, so it takes the shape's.
 */
export function insetPolygon(points: Point[], d: number, sign = Math.sign(signedArea(points))): Point[] | null {
  const size = Math.sqrt(Math.abs(signedArea(points)));
  const pts = corners(points, size * 1e-4);
  const n = pts.length;
  if (n < 3 || size === 0 || sign === 0) return null;
  // each side as a line moved inwards: a point on it and its direction
  const sides = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const dir: Point = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
    return { at: [p[0] - sign * dir[1] * d, p[1] + sign * dir[0] * d] as Point, dir };
  });
  const out = sides.map((s, i) => {
    const r = sides[(i + n - 1) % n];
    // where the previous side's line meets this one
    const den = r.dir[0] * s.dir[1] - r.dir[1] * s.dir[0];
    const t = ((s.at[0] - r.at[0]) * s.dir[1] - (s.at[1] - r.at[1]) * s.dir[0]) / den;
    return [r.at[0] + t * r.dir[0], r.at[1] + t * r.dir[1]] as Point;
  });
  // moved in too far, the sides cross over and point the other way
  for (let i = 0; i < n; i++) {
    const a = out[i];
    const b = out[(i + 1) % n];
    if ((b[0] - a[0]) * sides[i].dir[0] + (b[1] - a[1]) * sides[i].dir[1] <= 0) return null;
  }
  return out;
}

/**
 * The convex polygon moved in by `d` on every side, or null when the polygon is not convex or is
 * too small to move in that far.
 */
export function insetConvex(points: Point[], d: number): Point[] | null {
  const size = Math.sqrt(Math.abs(signedArea(points)));
  const pts = corners(points, size * 1e-4);
  const n = pts.length;
  if (n < 3 || size === 0) return null;
  const sign = Math.sign(signedArea(pts));
  for (let i = 0; i < n; i++) {
    if (Math.sign(cross(pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n])) !== sign) return null;
  }
  return insetPolygon(pts, d, sign);
}

export interface Tile {
  points: Point[];
  /** draw with a round-joined stroke this wide in the fill colour (0: no stroke) */
  stroke: number;
}

/**
 * A sticker's tile: its cell less `gap / 2` all round, corners rounded to `radius`. The rounding is
 * a stroke: the cell is moved in by gap / 2 + radius and stroked 2 * radius wide with round joins,
 * which puts the edge back at gap / 2 with round corners (concave corners stay sharp). Stickers too
 * small for that (or, with the default `inset`, not convex) get square corners or, failing that, are
 * shrunk towards their middle.
 */
export function tile(points: Point[], gap: number, radius: number, inset: (points: Point[], d: number) => Point[] | null = insetConvex): Tile {
  const rounded = inset(points, gap / 2 + radius);
  if (rounded) return { points: rounded, stroke: 2 * radius };
  const square = inset(points, gap / 2);
  if (square) return { points: square, stroke: 0 };
  const c = points.reduce<Point>((s, p) => [s[0] + p[0] / points.length, s[1] + p[1] / points.length], [0, 0]);
  return { points: points.map((p) => [c[0] + (p[0] - c[0]) * 0.8, c[1] + (p[1] - c[1]) * 0.8]), stroke: 0 };
}

/** the convex hull of some points (monotone chain), in order */
export function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const half = (list: Point[]) => {
    const out: Point[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/**
 * Groups polygons that touch (share a corner, to within `eps`) into faces, as lists of indexes.
 * A net's faces are drawn apart from each other, so each group is one face of the puzzle.
 */
export function touchingGroups(polygons: Point[][], eps: number): number[][] {
  const parent = polygons.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byCorner = new Map<string, number>();
  polygons.forEach((poly, i) => {
    for (const [x, y] of poly) {
      // a corner and its 8 neighbouring grid cells, so values either side of a grid line still meet
      const gx = Math.round(x / eps);
      const gy = Math.round(y / eps);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const other = byCorner.get(`${gx + dx},${gy + dy}`);
          if (other !== undefined) parent[find(other)] = find(i);
        }
      }
      byCorner.set(`${gx},${gy}`, i);
    }
  });
  const groups = new Map<number, number[]>();
  polygons.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });
  return [...groups.values()];
}

const segmentDistance = (p: Point, a: Point, b: Point) => {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

/** the shortest distance between two polygons that don't overlap */
export function polygonDistance(a: Point[], b: Point[]): number {
  let best = Infinity;
  for (const [from, to] of [
    [a, b],
    [b, a],
  ]) {
    for (const p of from) {
      for (let i = 0; i < to.length; i++) best = Math.min(best, segmentDistance(p, to[i], to[(i + 1) % to.length]));
    }
  }
  return best;
}

/**
 * Moves a net's faces (given as outlines) towards its middle, all by the same factor, until the
 * closest two are `gap` apart: the same layout, tighter. Returns how far to move each face. Faces
 * that are already closer than that stay where they are.
 */
export function closeUp(faces: Point[][], gap: number): Point[] {
  const centres = faces.map((f) => f.reduce<Point>((s, p) => [s[0] + p[0] / f.length, s[1] + p[1] / f.length], [0, 0]));
  // moving every face (1 - k) of the way to the middle brings two faces (1 - k) * (their distance) closer
  let pull = 1;
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const d = Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1]);
      pull = Math.min(pull, (polygonDistance(faces[i], faces[j]) - gap) / d);
    }
  }
  pull = Math.max(0, pull);
  const mid = centres.reduce<Point>((s, c) => [s[0] + c[0] / centres.length, s[1] + c[1] / centres.length], [0, 0]);
  return centres.map((c) => [pull * (mid[0] - c[0]), pull * (mid[1] - c[1])]);
}

/** How a net is drawn. */
export interface NetStyle {
  /** the gap between stickers and their corner radius, as fractions of a typical sticker's size */
  gap: number;
  radius: number;
  /** a dark plate behind each face, so white and yellow stickers stand out on light themes too */
  plates: boolean;
  /** the gap between faces as a fraction of a face's size (cubing.js lays them out further apart), or null to keep its layout */
  faceGap: number | null;
}
export const NET_STYLE: NetStyle = { gap: 0.14, radius: 0.16, plates: true, faceGap: 0.035 };
/**
 * square-1's net splits each sticker into a few polygons, and its pieces are irregular: drawn flat,
 * each polygon overlapping its neighbours a little so no seams show, as one shape per layer
 */
export const FLAT_STYLE: NetStyle = { gap: -0.03, radius: 0.015, plates: false, faceGap: null };
/** a face plate's corner radius, as a fraction of a typical sticker's size */
export const PLATE_RADIUS = 0.22;

export interface Orbit {
  orbitName: string;
  numPieces: number;
  numOrientations: number;
}
export interface OrbitPattern {
  pieces: number[];
  orientation: number[];
}

export const stickerId = (orbit: string, piece: number, orientation: number) => `${orbit}-l${piece}-o${orientation}`;

/**
 * For each sticker position, the solved-state sticker that a pattern puts there (so it shows that
 * sticker's colour). The same mapping cubing.js's own 2D view uses.
 */
export function stickerSources(orbits: Orbit[], pattern: Record<string, OrbitPattern>): Map<string, string> {
  const out = new Map<string, string>();
  for (const { orbitName, numPieces, numOrientations } of orbits) {
    const at = pattern[orbitName];
    if (!at) continue;
    for (let piece = 0; piece < numPieces; piece++) {
      for (let o = 0; o < numOrientations; o++) {
        out.set(stickerId(orbitName, piece, o), stickerId(orbitName, at.pieces[piece], (numOrientations - at.orientation[piece] + o) % numOrientations));
      }
    }
  }
  return out;
}

// cubing.js colours its nets, and csTimer its drawings (lib/drawnNet), with pure web colours; cubr's
// defaults are the same colours a little softer, and each face's colour can be your own (settings:
// sticker colours)
export interface SchemeFace {
  /** what the face is called in the settings (its position, or its usual colour) */
  name: string;
  /** how cubing.js colours this face in its nets */
  cubing: string[];
  /** how csTimer colours it in its drawings (#rrggbb) */
  cstimer?: string[];
  /** cubr's colour for it */
  colour: string;
}

export interface Scheme {
  id: 'cube' | 'skewb' | 'square1' | 'pyraminx' | 'megaminx' | 'fto';
  label: string;
  /** the cubing.js puzzles drawn in it (csTimer's drawings: lib/drawnNet DRAWN_SCHEMES) */
  puzzles: string[];
  faces: SchemeFace[];
}

const WHITE = '#f4f4f4';
const YELLOW = '#ffd500';
const RED = '#e8343a';
const ORANGE = '#ff8a1c';
const GREEN = '#2fb84c';
const BLUE = '#2d6ff2';
const PURPLE = '#8a4fd8';
const GREY = '#9a9a9a';

// the redi cube's net spells some of them differently (#32cd32, #ffa500, #ffff00)
const CUBE_FACES: SchemeFace[] = [
  { name: 'top', cubing: ['white', '#ffffff'], cstimer: ['#ffffff'], colour: WHITE },
  { name: 'front', cubing: ['limegreen', '#44ee00', '#32cd32'], cstimer: ['#00dd00'], colour: GREEN },
  { name: 'right', cubing: ['red', '#ff0000'], cstimer: ['#ff0000'], colour: RED },
  { name: 'back', cubing: ['#26f', '#2266ff'], cstimer: ['#0000ff'], colour: BLUE },
  { name: 'left', cubing: ['orange', '#ff8000', '#ffa500'], cstimer: ['#ffaa00'], colour: ORANGE },
  { name: 'bottom', cubing: ['yellow', '#f4f400', '#ffff00'], cstimer: ['#ffff00'], colour: YELLOW },
];

export const SCHEMES: Scheme[] = [
  { id: 'cube', label: 'cubes', puzzles: ['2x2x2', '3x3x3', '4x4x4', '5x5x5', '6x6x6', '7x7x7', 'redi_cube'], faces: CUBE_FACES },
  { id: 'skewb', label: 'skewb', puzzles: ['skewb'], faces: CUBE_FACES },
  {
    id: 'square1',
    label: 'square-1',
    puzzles: ['square1'],
    faces: [
      // csTimer's square-1 greens and oranges are its own
      ...CUBE_FACES.map((f, i) => ({ ...f, name: ['white', 'green', 'red', 'blue', 'orange', 'yellow'][i], cstimer: [['#ffffff'], ['#00ff00'], ['#ff0000'], ['#0000ff'], ['#ff8800'], ['#ffff00']][i] })),
      { name: 'piece sides', cubing: ['#d8d8d8'], colour: '#a0a0a0' },
    ],
  },
  {
    id: 'pyraminx',
    label: 'pyraminx',
    puzzles: ['pyraminx', 'master_tetraminx'],
    faces: [
      { name: 'front', cubing: ['limegreen', '#44ee00'], cstimer: ['#00ff00'], colour: GREEN },
      { name: 'left', cubing: ['red', '#ff0000'], cstimer: ['#ff0000'], colour: RED },
      { name: 'right', cubing: ['#26f', '#2266ff'], cstimer: ['#0000ff'], colour: BLUE },
      { name: 'bottom', cubing: ['yellow', '#f4f400'], cstimer: ['#ffff00'], colour: YELLOW },
    ],
  },
  {
    id: 'megaminx',
    label: 'megaminx',
    // the kilominx's net spells four of them differently; csTimer's pyraminx crystal is coloured as a megaminx
    puzzles: ['megaminx', 'kilominx', 'gigaminx'],
    faces: [
      { name: 'white', cubing: ['#ffffff'], cstimer: ['#ffffff'], colour: WHITE },
      { name: 'dark green', cubing: ['#008800'], cstimer: ['#006600'], colour: '#16884a' },
      { name: 'red', cubing: ['#ff0000'], cstimer: ['#dd0000'], colour: RED },
      { name: 'purple', cubing: ['#8800dd'], cstimer: ['#8811ff'], colour: PURPLE },
      { name: 'yellow', cubing: ['#f4f400', '#ffff00'], cstimer: ['#ffcc00'], colour: YELLOW },
      { name: 'dark blue', cubing: ['#0000ff'], cstimer: ['#0000bb'], colour: '#2f46c4' },
      { name: 'grey', cubing: ['#888888', '#999999'], cstimer: ['#999999'], colour: GREY },
      { name: 'beige', cubing: ['#e8d0a0', '#ffffd0'], cstimer: ['#ffffbb'], colour: '#ead6aa' },
      { name: 'light blue', cubing: ['#3399ff'], cstimer: ['#88ddff'], colour: '#46a8f5' },
      { name: 'orange', cubing: ['#ff8000', '#ff6633'], cstimer: ['#ff8833'], colour: ORANGE },
      { name: 'light green', cubing: ['#99ff00'], cstimer: ['#77ee00'], colour: '#a3d93b' },
      { name: 'pink', cubing: ['#ff66cc'], cstimer: ['#ff99ff'], colour: '#f472b6' },
    ],
  },
  {
    id: 'fto',
    label: 'fto',
    // csTimer's diamond is coloured as an FTO
    puzzles: ['fto'],
    faces: [
      { name: 'white', cubing: ['#ffffff'], cstimer: ['#ffffff'], colour: WHITE },
      { name: 'red', cubing: ['red', '#ff0000'], cstimer: ['#ff0000'], colour: RED },
      { name: 'green', cubing: ['#44ee00'], cstimer: ['#00dd00'], colour: GREEN },
      { name: 'purple', cubing: ['#8800dd'], cstimer: ['#880088'], colour: PURPLE },
      { name: 'yellow', cubing: ['#f4f400'], cstimer: ['#ffff00'], colour: YELLOW },
      { name: 'blue', cubing: ['#2266ff'], cstimer: ['#0000ff'], colour: BLUE },
      { name: 'grey', cubing: ['#aaaaaa'], cstimer: ['#bbbbbb'], colour: GREY },
      { name: 'orange', cubing: ['#ff8000'], cstimer: ['#ffaa00'], colour: ORANGE },
    ],
  },
];

/**
 * csTimer's sliding puzzle tiles, which it colours by the part of the solve they belong to (the
 * first row and column, the second, the last 2x2), in cubr's colours. Not one of your colour settings.
 */
export const SLIDING_COLOURS: Readonly<Record<string, string>> = { '#ff9999': RED, '#99ff99': GREEN, '#9999ff': BLUE };

export function schemeFor(puzzle: string): Scheme | undefined {
  return SCHEMES.find((s) => s.puzzles.includes(puzzle));
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A net colour (as cubing.js or csTimer gives it) as cubr draws it: your own colour for that face
 * when you picked one (`custom`, one per face of the scheme), otherwise cubr's.
 */
export function stickerColour(original: string, scheme: Scheme | undefined, custom?: readonly unknown[]): string {
  const c = original.trim().toLowerCase();
  const face = scheme ? scheme.faces.findIndex((f) => f.cubing.includes(c) || f.cstimer?.includes(c)) : -1;
  if (!scheme || face < 0) return original;
  const own = custom?.[face];
  return typeof own === 'string' && HEX.test(own) ? own.toLowerCase() : scheme.faces[face].colour;
}
