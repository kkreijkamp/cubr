// csTimer's scramble drawings, redrawn the way cubr draws its own nets (components/ScrambleNet). For
// a puzzle cubing.js has no net for, the scramble service sends csTimer's drawing of the scramble
// (GET /api/scrambles/:event/image): flat polygons with thin black outlines, in csTimer's colours.
// Its shapes are read here and laid out as cubr's nets are: rounded stickers with a gap between
// them, on a dark plate for each face, in cubr's colours (or yours). Everything here is pure (no DOM).
import {
  closeUp,
  convexHull,
  corners,
  FLAT_STYLE,
  IDENTITY,
  insetConvex,
  insetPolygon,
  multiply,
  NET_STYLE,
  parsePoints,
  parseTransform,
  pathPoints,
  PLATE_RADIUS,
  SCHEMES,
  signedArea,
  SLIDING_COLOURS,
  stickerColour,
  tile,
  touchingGroups,
  transformPoint,
  type Matrix,
  type Point,
  type Scheme,
  type Tile,
} from './scrambleNet';

export interface DrawnShape {
  points: Point[];
  /** #rrggbb */
  fill: string;
}

export interface DrawnText {
  x: number;
  y: number;
  size: number;
  text: string;
}

export interface Drawing {
  shapes: DrawnShape[];
  texts: DrawnText[];
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? whole;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3] ?? '');
  return out;
}

/** a property's value in a style attribute ("fill:#ff0;stroke:#000;") */
function styleValue(style: string | undefined, prop: string): string | undefined {
  for (const decl of (style ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0 && decl.slice(0, i).trim().toLowerCase() === prop) return decl.slice(i + 1).trim();
  }
  return undefined;
}

/** '#abc' or '#AABBCC' as '#aabbcc'; anything else trimmed, in lower case */
export function hexColour(c: string): string {
  const v = c.trim().toLowerCase();
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : v;
}

function shapePoints(tag: string, a: Record<string, string>): Point[] | null {
  switch (tag) {
    case 'polygon':
      return parsePoints(a.points);
    case 'rect': {
      const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => Number(a[k] ?? 0));
      return [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
    }
    case 'path':
      try {
        return pathPoints(a.d ?? '');
      } catch {
        return null; // a curve
      }
    default:
      return null;
  }
}

/**
 * The filled shapes and the words of an SVG drawing, in its own coordinates (group transforms
 * applied): polygons, rectangles and straight-sided paths. Circles and curves are left out (csTimer
 * draws them only for the clock, which cubing.js draws).
 */
export function parseDrawing(svg: string): Drawing {
  const shapes: DrawnShape[] = [];
  const texts: DrawnText[] = [];
  const stack: Matrix[] = [IDENTITY];
  let text: { at: Point; size: number; chars: string } | null = null;
  for (const [, close, name, rest, selfClosing, chars] of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g)) {
    if (chars !== undefined) {
      if (text) text.chars += decode(chars);
      continue;
    }
    const tag = name.toLowerCase();
    if (close) {
      if (tag === 'g' && stack.length > 1) stack.pop();
      if (tag === 'text' && text) {
        if (text.chars.trim()) texts.push({ x: text.at[0], y: text.at[1], size: text.size, text: text.chars.trim() });
        text = null;
      }
      continue;
    }
    const a = attributes(rest);
    const m = multiply(stack[stack.length - 1], parseTransform(a.transform));
    if (tag === 'g') {
      if (!selfClosing) stack.push(m);
    } else if (tag === 'text') {
      const font = styleValue(a.style, 'font') ?? styleValue(a.style, 'font-size') ?? a['font-size'] ?? '';
      const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? 16) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
      text = selfClosing ? null : { at: transformPoint(m, [Number(a.x ?? 0), Number(a.y ?? 0)]), size, chars: '' };
    } else {
      const fill = styleValue(a.style, 'fill') ?? a.fill;
      const pts = fill && fill !== 'none' ? shapePoints(tag, a) : null;
      if (fill && pts && pts.length >= 3 && pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) {
        shapes.push({ points: pts.map((p) => transformPoint(m, p)), fill: hexColour(fill) });
      }
    }
  }
  return { shapes, texts };
}

/**
 * The outline of polygons that meet side to side (the stickers of one face): the sides two of them
 * share cancel out, and what's left joins up into loops, going round the same way as the polygons
 * (holes the other way). Corners within `eps` of each other are one corner, and a corner lying on
 * another polygon's side splits that side there. Null if the sides left don't join up into loops.
 */
export function outline(polygons: Point[][], eps: number): Point[][] | null {
  const verts: Point[] = [];
  const grid = new Map<string, number[]>();
  const vertex = (p: Point): number => {
    const gx = Math.floor(p[0] / eps);
    const gy = Math.floor(p[1] / eps);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (Math.hypot(verts[i][0] - p[0], verts[i][1] - p[1]) <= eps) return i;
        }
      }
    }
    verts.push(p);
    grid.set(`${gx},${gy}`, [...(grid.get(`${gx},${gy}`) ?? []), verts.length - 1]);
    return verts.length - 1;
  };
  // every polygon the same way round, as corner numbers
  const rings: number[][] = [];
  for (const poly of polygons) {
    const a = signedArea(poly);
    if (a === 0) continue;
    const ring = (a < 0 ? [...poly].reverse() : poly).map(vertex);
    const kept = ring.filter((v, i) => v !== ring[(i + 1) % ring.length]);
    if (kept.length >= 3) rings.push(kept);
  }
  // the sides, split at any corner on them; a side and the same side the other way cancel out
  const sides = new Map<string, number>();
  const add = (a: number, b: number) => {
    const back = `${b}>${a}`;
    const n = sides.get(back);
    if (n === undefined) sides.set(`${a}>${b}`, (sides.get(`${a}>${b}`) ?? 0) + 1);
    else if (n === 1) sides.delete(back);
    else sides.set(back, n - 1);
  };
  for (const ring of rings) {
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length];
      const [p, q] = [verts[a], verts[b]];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const on: [number, number][] = [];
      verts.forEach((v, k) => {
        if (k === a || k === b) return;
        const along = ((v[0] - p[0]) * (q[0] - p[0]) + (v[1] - p[1]) * (q[1] - p[1])) / len;
        const off = Math.abs((q[0] - p[0]) * (v[1] - p[1]) - (q[1] - p[1]) * (v[0] - p[0])) / len;
        if (along > eps && along < len - eps && off <= eps) on.push([along, k]);
      });
      on.sort((x, y) => x[0] - y[0]);
      let from = a;
      for (const [, k] of on) {
        add(from, k);
        from = k;
      }
      add(from, b);
    });
  }
  // what's left, joined into loops; where two loops touch at a corner, the sharpest turn towards the
  // polygons' side keeps each loop to itself
  const next = new Map<number, number[]>();
  let count = 0;
  for (const [key, n] of sides) {
    const [a, b] = key.split('>').map(Number);
    for (let i = 0; i < n; i++) next.set(a, [...(next.get(a) ?? []), b]);
    count += n;
  }
  const loops: Point[][] = [];
  for (const [start, from] of next) {
    while (from.length) {
      const loop = [start];
      let prev = start;
      let at = from.pop()!;
      for (let steps = 0; at !== start; steps++) {
        const out = next.get(at);
        if (steps > count || !out?.length) return null;
        loop.push(at);
        const din = [verts[at][0] - verts[prev][0], verts[at][1] - verts[prev][1]];
        let best = 0;
        let bestTurn = -Infinity;
        out.forEach((w, j) => {
          const dout = [verts[w][0] - verts[at][0], verts[w][1] - verts[at][1]];
          const turn = Math.atan2(din[0] * dout[1] - din[1] * dout[0], din[0] * dout[0] + din[1] * dout[1]);
          if (turn > bestTurn) {
            bestTurn = turn;
            best = j;
          }
        });
        prev = at;
        at = out.splice(best, 1)[0];
      }
      loops.push(loop.map((i) => verts[i]));
    }
  }
  return loops.map((l) => corners(l, eps)).filter((l) => l.length >= 3);
}

/** How a drawing is redrawn: a puzzle's faces, square-1's flat layers, or a sliding puzzle's board. */
export type DrawnKind = 'net' | 'flat' | 'board';

export interface DrawnPath {
  /** SVG path data: one or more outlines */
  d: string;
  /** the width of the round-joined stroke that rounds its corners (0: none) */
  stroke: number;
}

export interface DrawnNet {
  viewBox: string;
  /** behind each face's stickers */
  plates: DrawnPath[];
  /** `fill`: csTimer's colour (drawnColour gives cubr's) */
  stickers: (DrawnPath & { fill: string })[];
  /** a sliding puzzle's numbers */
  texts: DrawnText[];
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const pathData = (loops: Point[][]) => loops.map((l) => `M${l.map((p) => `${round(p[0])},${round(p[1])}`).join('L')}Z`).join('');
const toPath = (t: Tile): DrawnPath => ({ d: pathData([t.points]), stroke: round(t.stroke) });
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const middle = (pts: Point[]): Point => pts.reduce<Point>((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length], [0, 0]);

/**
 * The plate behind a face whose stickers don't make a convex shape (a mirror block's): its outline,
 * corners rounded as a convex face's are, or failing that a plate behind each sticker.
 */
function outlinePlate(polys: Point[][], size: number): DrawnPath[] {
  const loops = outline(polys, size * 0.005);
  if (loops) {
    for (const radius of [PLATE_RADIUS, PLATE_RADIUS / 2]) {
      // holes go round the other way, so they move out: the shape's own side is in for every loop
      const inset = loops.map((l) => insetPolygon(l, radius * size, 1));
      if (inset.every((l): l is Point[] => l !== null)) return [{ d: pathData(inset), stroke: round(2 * radius * size) }];
    }
    return [{ d: pathData(loops), stroke: 0 }];
  }
  return polys.map((p) => ({ d: pathData([p]), stroke: round(NET_STYLE.gap * size) }));
}

/**
 * A csTimer drawing as cubr draws its nets (see the top of this file): `kind` 'net' for a puzzle's
 * faces, 'flat' for a square-1-like puzzle (as cubr's own square-1: no plates, pieces overlapping a
 * little), 'board' for a sliding puzzle (one plate, the space left empty, the numbers kept). Null
 * when the drawing has no shapes.
 */
export function buildDrawnNet(drawing: Drawing, kind: DrawnKind): DrawnNet | null {
  let cells = drawing.shapes.filter((s) => Math.abs(signedArea(s.points)) > 0).map((s) => ({ ...s }));
  if (!cells.length) return null;
  const style = kind === 'flat' ? FLAT_STYLE : NET_STYLE;
  // gaps and corners scale with the stickers, as in cubr's nets
  let size = median(cells.map((c) => Math.sqrt(Math.abs(signedArea(c.points)))));
  let texts: DrawnText[] = [];
  if (kind === 'board') {
    // csTimer leaves a gap between the tiles: each grows to fill its square of the board
    const centres = cells.map((c) => middle(c.points));
    let pitch = Infinity;
    centres.forEach((a, i) => centres.slice(i + 1).forEach((b) => (pitch = Math.min(pitch, Math.hypot(a[0] - b[0], a[1] - b[1])))));
    if (Number.isFinite(pitch) && pitch > size) {
      cells = cells.map((c) => ({ ...c, points: insetConvex(c.points, -(pitch - size) / 2) ?? c.points }));
      size = pitch;
    }
    texts = drawing.texts.map((t) => ({ ...t, x: round(t.x), y: round(t.y), size: round(size * 0.46) }));
  }
  const groups = kind === 'board' ? [cells.map((_, i) => i)] : touchingGroups(cells.map((c) => c.points), size * 0.02);
  const hulls = groups.map((g) => convexHull(g.flatMap((i) => cells[i].points)));
  const convex = groups.map((g, k) => Math.abs(signedArea(hulls[k])) <= 1.02 * g.reduce((s, i) => s + Math.abs(signedArea(cells[i].points)), 0));
  if (kind === 'net' && style.faceGap !== null && groups.length > 1 && convex.every(Boolean)) {
    // every group a whole face: drawn as close together as cubr's nets are
    const moves = closeUp(hulls, style.faceGap * median(hulls.map((h) => Math.sqrt(Math.abs(signedArea(h))))));
    groups.forEach((g, f) => {
      const shift = ([x, y]: Point): Point => [x + moves[f][0], y + moves[f][1]];
      for (const i of g) cells[i] = { ...cells[i], points: cells[i].points.map(shift) };
      hulls[f] = hulls[f].map(shift);
    });
  }
  const plates = style.plates
    ? groups.flatMap((g, k) => (convex[k] ? [toPath(tile(hulls[k], 0, PLATE_RADIUS * size))] : outlinePlate(g.map((i) => cells[i].points), size)))
    : [];
  // a sliding puzzle's space is a white tile in csTimer's drawing
  const stickers = cells
    .filter((c) => !(kind === 'board' && c.fill === '#ffffff'))
    .map((c) => ({ ...toPath(tile(c.points, style.gap * size, style.radius * size, (pts, d) => insetPolygon(pts, d))), fill: c.fill }));
  const all = cells.flatMap((c) => c.points);
  const [x0, y0] = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))];
  const [x1, y1] = [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
  return { viewBox: [x0, y0, x1 - x0, y1 - y0].map(round).join(' '), plates, stickers, texts };
}

/**
 * The icosamate's twenty colours as cubing.js colours the same faces in 3D (csTimer's drawing has its
 * own twenty), so its 2D net and its 3D puzzle match. The faces were lined up by their U and F faces;
 * __tests__/cubing3d.test.ts checks this map against csTimer's drawings, sticker for sticker.
 */
export const ICOSAMATE_COLOURS: Readonly<Record<string, string>> = {
  '#ffffff': '#ffffff', '#008844': '#008800', '#bb3366': '#0000ff', '#aa8855': '#ff8000', '#008888': '#ff66cc',
  '#881111': '#e8d0a0', '#ee7711': '#5ec4b6', '#bb99bb': '#b9a1ff', '#0055aa': '#ff0000', '#eedd11': '#5c5c5c',
  '#888888': '#aaaaaa', '#66aa33': '#44ee00', '#ee88bb': '#3399ff', '#aa5522': '#7d3b11', '#66ccbb': '#d41f69',
  '#cc1100': '#f4f400', '#ffaa00': '#007a89', '#553366': '#8800dd', '#4499cc': '#980000', '#eecc99': '#292929',
};

/**
 * Which of cubr's colour schemes csTimer colours each puzzle's drawing in (lib/scrambleNet SCHEMES):
 * the cube's unless listed here; null for the icosamate, which takes cubing.js's twenty colours
 * (ICOSAMATE_COLOURS). The puzzles cubing.js draws are here too, for the scramble types it can't read
 * (csTimer's notation).
 */
const DRAWN_SCHEMES: Readonly<Record<string, Scheme['id'] | null>> = {
  sq1: 'square1',
  sq2: 'square1',
  ssq1: 'square1',
  bsq: 'square1',
  minx: 'megaminx',
  klm: 'megaminx',
  giga: 'megaminx',
  prc: 'megaminx',
  pyram: 'pyraminx',
  mpyr: 'pyraminx',
  fto: 'fto',
  dmd: 'fto',
  ctico: null,
};

/** How csTimer's drawing of an event is redrawn. */
export function drawnKind(event: string): DrawnKind {
  if (event === '15p' || event === '8p') return 'board';
  return DRAWN_SCHEMES[event] === 'square1' ? 'flat' : 'net';
}

/** csTimer's drawing of a clock is dials and pins, not stickers: shown as it comes. */
export function redrawable(event: string): boolean {
  return event !== 'clock';
}

/**
 * A colour in csTimer's drawing of `event` as cubr draws it: its scheme's colour (yours where you
 * picked one: `custom`, settings customStickers), a sliding puzzle tile's, the icosamate's as in 3D,
 * or csTimer's own.
 */
export function drawnColour(fill: string, event: string, custom?: Readonly<Record<string, readonly unknown[] | undefined>>): string {
  if (drawnKind(event) === 'board') return SLIDING_COLOURS[fill] ?? fill;
  if (event === 'ctico') return ICOSAMATE_COLOURS[fill] ?? fill;
  const id = event in DRAWN_SCHEMES ? DRAWN_SCHEMES[event] : 'cube';
  const scheme = id ? SCHEMES.find((s) => s.id === id) : undefined;
  return scheme ? stickerColour(fill, scheme, custom?.[scheme.id]) : fill;
}

/**
 * How many to a row a relay's `n` puzzles go in a `width` x `height` box, each under a `label`
 * pixels tall: whichever makes them biggest. `tall` is a puzzle's height for its width: a net is
 * about 4 wide by 3 high, a puzzle in 3D about square.
 */
export function relayColumns(n: number, width: number, height: number, label: number, tall = 0.75): number {
  let best = 1;
  let biggest = -Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const size = Math.min(height / Math.ceil(n / cols) - label, (width / cols) * tall);
    if (size > biggest + 0.5) {
      best = cols;
      biggest = size;
    }
  }
  return best;
}
