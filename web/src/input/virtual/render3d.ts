// Drawing the virtual puzzles in 3D on a 2D canvas: our own perspective projection, back-face culling
// and painter's order. A convex puzzle needs no depth sorting within a piece of it, so a turning
// puzzle is drawn as the slabs its moving layers cut it into, far ones first, with a dark cap where a
// layer is cut open. Or, as csTimer draws its cubes, as the stickers alone floating off a hollow
// puzzle, the far side seen through the gaps: every sticker, far ones first.
import { add, apply, centroid, dot, inset, mulMat, rotation, scale, sub, IDENTITY, type Mat, type Vec } from './geometry';
import type { Move, PolyPuzzle } from './polyPuzzle';
import { cornerFaces, middleFaces, partnerOf, rightMiddle, SLICE_AXIS, wedgeFaces, type Sq1Face, type Sq1Move, type Sq1State } from './square1';

export interface Palette {
  /** sticker colour of each scheme face */
  faces: string[];
  /** the plastic */
  body: string;
  /** stickers hidden by a blindfolded solve */
  hidden?: string;
}

export interface Camera {
  yaw: number;
  pitch: number;
  /** distance from the centre, in puzzle radii */
  distance: number;
  /** radius of the puzzle's bounding sphere */
  radius: number;
}

interface Projected {
  view: Mat;
  eye: Vec;
  project(v: Vec): [number, number];
}

function camera(cam: Camera, width: number, height: number): Projected {
  const view = mulMat(rotation([1, 0, 0], cam.pitch), rotation([0, 1, 0], -cam.yaw));
  const d = cam.distance * cam.radius;
  // the eye in world space: the inverse view applied to (0, 0, d)
  const eye: Vec = [d * Math.sin(cam.yaw) * Math.cos(cam.pitch), d * Math.sin(cam.pitch), d * Math.cos(cam.yaw) * Math.cos(cam.pitch)];
  // fit the bounding sphere: its silhouette is radius / sqrt(d^2 - r^2) in projected units
  const fit = (Math.min(width, height) / 2) * 0.94 * (Math.sqrt(d * d - cam.radius * cam.radius) / cam.radius);
  return {
    view,
    eye,
    project(v) {
      const q = apply(view, v);
      const s = fit / (d - q[2]);
      return [width / 2 + q[0] * s, height / 2 - q[1] * s];
    },
  };
}

function path(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

/** a sticker: filled, with its corners softened by a stroke of the same colour */
function sticker(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string, round: number) {
  path(ctx, pts);
  ctx.fillStyle = color;
  ctx.fill();
  if (round > 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = round;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

function plate(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string) {
  path(ctx, pts);
  ctx.fillStyle = color;
  ctx.fill();
  // a hairline of the same colour closes the seams between neighbouring plates
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

const facing = (eye: Vec, n: Vec, p: Vec) => dot(n, sub(eye, p)) > 1e-9;

export interface Turning {
  move: Move;
  /** how far it has turned, radians about the axis */
  angle: number;
}

/** floating stickers at their most (float 1): this much smaller, and lifted this part of the way out again */
const FLOAT_SHRINK = 0.4;
const FLOAT_LIFT = 0.25;

/** a hex colour this part of the way to another */
function mix(a: string, b: string, t: number): string {
  const ca = /^#[0-9a-f]{6}$/i.test(a) ? a : null;
  const cb = /^#[0-9a-f]{6}$/i.test(b) ? b : null;
  if (!ca || !cb) return a;
  const ch = (c: string, i: number) => parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16);
  return '#' + [0, 1, 2].map((i) => Math.round(ch(ca, i) * (1 - t) + ch(cb, i) * t).toString(16).padStart(2, '0')).join('');
}

/** the stickers alone, off a hollow puzzle: the far side's seen from inside, in the shade. Far ones
 * first; at rest the puzzle is convex, so the far side all goes first */
function drawFloating(ctx: CanvasRenderingContext2D, pc: Projected, puzzle: PolyPuzzle, palette: Palette, turning: Turning[], color: (slot: number) => string, round: number, float: number) {
  const k = 1 - FLOAT_SHRINK * float;
  const shade = new Map<string, string>();
  const drawn = puzzle.slots.map((s, i) => {
    const t = turning.find((tt) => puzzle.selects(tt.move, s.center));
    const m = t ? rotation(puzzle.axes[t.move.axis].n, t.angle) : IDENTITY;
    const lift = scale(s.normal, FLOAT_LIFT * float * dot(s.center, s.normal));
    const pts = s.sticker.map((v) => apply(m, add(add(s.center, scale(sub(v, s.center), k)), lift)));
    const center = apply(m, add(s.center, lift));
    return { i, pts, depth: apply(pc.view, center)[2], front: facing(pc.eye, apply(m, s.normal), center) };
  });
  const still = turning.length === 0;
  drawn.sort((a, b) => (still && a.front !== b.front ? (a.front ? 1 : -1) : a.depth - b.depth));
  for (const d of drawn) {
    let c = color(d.i);
    if (!d.front) {
      if (!shade.has(c)) shade.set(c, mix(c, palette.body, 0.35));
      c = shade.get(c)!;
    }
    sticker(ctx, d.pts.map(pc.project), c, round);
  }
}

export interface PolyOptions {
  /** each slot's colour instead of its sticker's (a blindfolded solve) */
  colorOf?: (slot: number) => string;
  /** 0: a solid puzzle; up to 1: the stickers float off a hollow one, smaller and further out */
  float?: number;
}

/**
 * A polyhedral puzzle. `turning` are moves being animated: all about one axis (they are only animated
 * together when parallel), each on its own layers.
 */
export function drawPoly(ctx: CanvasRenderingContext2D, width: number, height: number, puzzle: PolyPuzzle, state: Int16Array, cam: Camera, palette: Palette, turning: Turning[], opts: PolyOptions = {}) {
  const float = Math.max(0, Math.min(1, opts.float ?? 0));
  // lifted stickers reach further out: the view takes them in
  const pc = camera(float > 0 ? { ...cam, radius: cam.radius * (1 + FLOAT_LIFT * float) } : cam, width, height);
  const round = Math.max(1, Math.min(width, height) / 160);
  const color = opts.colorOf ?? ((slot: number) => palette.faces[puzzle.slots[state[slot]].face] ?? palette.body);

  if (float > 0) {
    drawFloating(ctx, pc, puzzle, palette, turning, color, round, float);
    return;
  }

  if (turning.length === 0) {
    puzzle.slots.forEach((s, i) => {
      if (!facing(pc.eye, s.normal, s.center)) return;
      plate(ctx, s.poly.map(pc.project), palette.body);
      sticker(ctx, s.sticker.map(pc.project), color(i), round);
    });
    return;
  }

  const axis = puzzle.axes[turning[0].move.axis];
  const n = axis.n;
  // the slabs between the turning layers' cuts, each with its own turn
  const bounds = new Set<number>();
  for (const t of turning) {
    if (t.move.from > 1) bounds.add(axis.cuts[t.move.from - 2]);
    if (t.move.to <= axis.cuts.length) bounds.add(axis.cuts[t.move.to - 1]);
  }
  const cuts = [...bounds].sort((a, b) => b - a);
  const slabs = Array.from({ length: cuts.length + 1 }, (_, i) => ({ hi: i === 0 ? Infinity : cuts[i - 1], lo: i === cuts.length ? -Infinity : cuts[i], m: IDENTITY as Mat }));
  for (const s of slabs) {
    // a point inside the slab, to see which move (if any) turns it
    const mid = Number.isFinite(s.hi) && Number.isFinite(s.lo) ? (s.hi + s.lo) / 2 : Number.isFinite(s.hi) ? s.hi - 1 : Number.isFinite(s.lo) ? s.lo + 1 : 0;
    const t = turning.find((tt) => {
      const hi = tt.move.from <= 1 ? Infinity : axis.cuts[tt.move.from - 2];
      const lo = tt.move.to > axis.cuts.length ? -Infinity : axis.cuts[tt.move.to - 1];
      return mid < hi && mid > lo;
    });
    if (t) s.m = rotation(n, t.angle);
  }
  // painter's order: slabs below the eye from the bottom up, slabs above it from the top down, the
  // eye's own slab last
  const e = dot(pc.eye, n);
  const order = slabs.map((s, i) => ({ s, i }));
  order.sort((a, b) => {
    const da = a.s.lo >= e ? a.s.lo - e : a.s.hi <= e ? e - a.s.hi : 0;
    const db = b.s.lo >= e ? b.s.lo - e : b.s.hi <= e ? e - b.s.hi : 0;
    return db - da;
  });
  for (const { s, i } of order) {
    // dark caps where the slab is cut open: its top faces up the axis, its bottom down
    for (const [d, sign] of [
      [s.hi, 1],
      [s.lo, -1],
    ] as const) {
      if (!Number.isFinite(d)) continue;
      const cap = puzzle.caps.get(`${axis.name}:${d}`) ?? puzzle.caps.get(`${axis.name}:${d.toFixed(6)}`);
      if (!cap) continue;
      const pts = cap.map((v) => apply(s.m, v));
      const normal = apply(s.m, [n[0] * sign, n[1] * sign, n[2] * sign]);
      if (facing(pc.eye, normal, centroid(pts))) plate(ctx, pts.map(pc.project), palette.body);
    }
    puzzle.slots.forEach((slot, k) => {
      const t = dot(slot.center, n);
      if (!(t < s.hi && t > s.lo)) return;
      const normal = apply(s.m, slot.normal);
      const center = apply(s.m, slot.center);
      if (!facing(pc.eye, normal, center)) return;
      plate(
        ctx,
        slot.poly.map((v) => pc.project(apply(s.m, v))),
        palette.body,
      );
      sticker(
        ctx,
        slot.sticker.map((v) => pc.project(apply(s.m, v))),
        color(k),
        round,
      );
    });
    void i;
  }
}

/** the turn applied to each part of a square-1 while a move is animated */
export interface Sq1Turning {
  move: Sq1Move;
  /** 0..1 */
  progress: number;
}

/** Square-1: pieces are convex, drawn far group first (layers, or the two halves during a slash), far piece first. */
export function drawSq1(ctx: CanvasRenderingContext2D, width: number, height: number, state: Sq1State, cam: Camera, palette: Palette, turning: Sq1Turning | null) {
  const pc = camera(cam, width, height);
  const round = Math.max(1, Math.min(width, height) / 170);
  type Piece = { faces: Sq1Face[]; group: number };
  const pieces: Piece[] = [];
  const m = turning?.move;
  const p = turning?.progress ?? 0;
  // groups: 0 bottom, 1 middle, 2 top (or 0 left half, 1 right half during a slash)
  let groupAxis: Vec = [0, 1, 0];
  let groupTurn: Mat[] = [IDENTITY, IDENTITY, IDENTITY];
  let whole: Mat = IDENTITY;
  if (m?.kind === 'turn') {
    groupTurn = [rotation([0, 1, 0], (m.bottom * Math.PI * p) / 6), IDENTITY, rotation([0, 1, 0], (-m.top * Math.PI * p) / 6)];
  } else if (m?.kind === 'slash') {
    groupAxis = SLICE_AXIS;
    groupTurn = [IDENTITY, rotation(SLICE_AXIS, Math.PI * p)];
  } else if (m?.kind === 'rotate') {
    const axis: Vec = m.axis === 'y' ? [0, 1, 0] : m.axis === 'x' ? SLICE_AXIS : [SLICE_AXIS[2], 0, -SLICE_AXIS[0]];
    whole = rotation(axis, Math.PI * p);
  }
  const slash = m?.kind === 'slash';
  const right = rightMiddle(state);
  for (let slot = 0; slot < 24; slot++) {
    const group = slash ? (slot >= 6 && slot < 18 ? 1 : 0) : slot < 12 ? 2 : 0;
    const wedge = state.wedges[slot];
    const partner = partnerOf(wedge);
    const turn = mulMat(whole, groupTurn[group]);
    if (partner < 0) {
      pieces.push({ faces: wedgeFaces(wedge, slot, turn), group });
      continue;
    }
    // a corner is drawn once, from the slot of its first half (its partner is in the next slot round)
    const base = slot < 12 ? 0 : 12;
    const next = base + ((slot - base + 1) % 12);
    if (state.wedges[next] !== partner) continue;
    pieces.push({ faces: cornerFaces(wedge, slot, partner, next, turn), group });
  }
  for (let piece = 0; piece < 2; piece++) {
    const group = slash ? (piece === right ? 1 : 0) : 1;
    pieces.push({ faces: middleFaces(state, piece, mulMat(whole, groupTurn[group])), group });
  }
  // groups are separated by planes square to groupAxis (turned with the whole puzzle)
  const ga = apply(whole, groupAxis);
  const e = dot(pc.eye, ga);
  const groupOrder = slash ? (e > 0 ? [0, 1] : [1, 0]) : e > 0 ? [0, 1, 2] : [2, 1, 0];
  const depth = (f: Sq1Face[]) => {
    let c: Vec = [0, 0, 0];
    let k = 0;
    for (const face of f) for (const v of face.poly) (c = [c[0] + v[0], c[1] + v[1], c[2] + v[2]]), k++;
    c = [c[0] / k, c[1] / k, c[2] / k];
    return -dot(sub(c, pc.eye), sub(c, pc.eye));
  };
  for (const g of groupOrder) {
    const inGroup = pieces.filter((x) => x.group === g).sort((a, b) => depth(a.faces) - depth(b.faces));
    for (const piece of inGroup) {
      for (const f of piece.faces) {
        if (!facing(pc.eye, f.normal, centroid(f.poly))) continue;
        plate(ctx, f.poly.map(pc.project), palette.body);
        // stickers sit an even gap in from their piece's edges
        if (f.color !== null) sticker(ctx, inset(f.poly, 0.075, f.normal).map(pc.project), palette.faces[f.color] ?? palette.body, round);
      }
    }
  }
}
