// A twisty puzzle as a convex polyhedron cut by planes (cubes, pyraminx, skewb, megaminx). Its
// surface is cut into stickers ("slots", fixed in space); a move turns the slots on one side of the
// cuts about an axis, which permutes which sticker sits in which slot. The permutations are found
// geometrically (turn each slot's centre, find the slot that is there now), so they are exact, and a
// state is just "which sticker is in each slot". The renderer draws the slots and, while a move is
// animated, turns the moving slots part of the way.
import { apply, area, centroid, dot, dist, facePolygon, inset, rotation, scale, split, type Plane, type Vec } from './geometry';

export interface Slot {
  /** the face this slot is on (its sticker colour when solved) */
  face: number;
  /** which of the solid's faces it is on (index into `faces`) */
  faceIdx: number;
  poly: Vec[];
  center: Vec;
  normal: Vec;
  /** the sticker drawn inside the slot, `gap` in from its edges */
  sticker: Vec[];
}

export interface Axis {
  name: string;
  /** unit vector out of the puzzle */
  n: Vec;
  /** quarter-turns etc: a move by 1 turns 2π/order */
  order: number;
  /** offsets along n where the puzzle is cut, highest first; layer k (from 1) lies between cuts k-1 and k */
  cuts: number[];
}

/** a turn of layers `from`..`to` (1 = the layer at the tip of the axis) by `amount` steps clockwise (seen from the tip) */
export interface Move {
  axis: number;
  from: number;
  to: number;
  amount: number;
}

export interface PolyDef {
  /** the faces of the solid: plane and the colour (scheme face) its stickers have */
  faces: { plane: Plane; color: number }[];
  axes: Axis[];
  /** gap between a sticker and the edge of its slot (puzzle units) */
  gap: number;
  /** slots smaller than this are dropped (sliver cuts) */
  minArea?: number;
}

export class PolyPuzzle {
  readonly slots: Slot[];
  readonly axes: Axis[];
  readonly faces: { plane: Plane; color: number }[];
  /** gap between a sticker and the edge of its slot (PolyDef.gap) */
  readonly gap: number;
  /** each face's outline */
  readonly facePolys: (Vec[] | null)[];
  /** the cross-section of the solid at each cut, per axis (dark caps drawn while a layer turns) */
  readonly caps: Map<string, Vec[]>;
  private perms = new Map<string, Int32Array>();

  constructor(def: PolyDef) {
    this.axes = def.axes;
    this.faces = def.faces;
    this.gap = def.gap;
    const planes = def.faces.map((f) => f.plane);
    // every distinct cut plane (an axis and its opposite share theirs)
    const cuts: Plane[] = [];
    for (const a of def.axes) {
      for (const d of a.cuts) {
        const p: Plane = { n: a.n, d };
        const same = cuts.some(
          (q) => (dist(q.n, p.n) < 1e-6 && Math.abs(q.d - p.d) < 1e-6) || (dist(q.n, scale(p.n, -1)) < 1e-6 && Math.abs(q.d + p.d) < 1e-6),
        );
        if (!same) cuts.push(p);
      }
    }
    const slots: Slot[] = [];
    this.facePolys = def.faces.map((f, i) =>
      facePolygon(
        f.plane,
        planes.filter((_, j) => j !== i),
      ),
    );
    def.faces.forEach((f, i) => {
      const face = this.facePolys[i];
      if (!face) return;
      let polys: Vec[][] = [face];
      for (const c of cuts) {
        const next: Vec[][] = [];
        for (const p of polys) {
          const [a, b] = split(p, c);
          if (a) next.push(a);
          if (b) next.push(b);
        }
        polys = next;
      }
      for (const poly of polys) {
        if (area(poly) < (def.minArea ?? 1e-6)) continue;
        slots.push({ face: f.color, faceIdx: i, poly, center: centroid(poly), normal: f.plane.n, sticker: inset(poly, def.gap, f.plane.n) });
      }
    });
    this.slots = slots;
    this.caps = new Map();
    for (const a of def.axes) {
      for (const d of a.cuts) {
        const cap = facePolygon({ n: a.n, d }, planes);
        if (cap) this.caps.set(`${a.name}:${d}`, cap);
      }
    }
  }

  axisIndex(name: string): number {
    return this.axes.findIndex((a) => a.name === name);
  }

  /** the slots a move turns */
  selects(move: Pick<Move, 'axis' | 'from' | 'to'>, center: Vec): boolean {
    const a = this.axes[move.axis];
    const t = dot(center, a.n);
    const hi = move.from <= 1 ? Infinity : a.cuts[move.from - 2];
    const lo = move.to > a.cuts.length ? -Infinity : a.cuts[move.to - 1];
    return t < hi && t > lo;
  }

  /** the angle (radians, about the axis) of a move: clockwise seen from the axis tip */
  angle(move: Move): number {
    return (-2 * Math.PI * move.amount) / this.axes[move.axis].order;
  }

  /** where each slot's sticker goes for one step of a layer range: perm[i] = the slot it lands in (-1 = not turned) */
  perm(axis: number, from: number, to: number): Int32Array {
    const key = `${axis}:${from}:${to}`;
    let p = this.perms.get(key);
    if (p) return p;
    p = new Int32Array(this.slots.length).fill(-1);
    const a = this.axes[axis];
    const r = rotation(a.n, (-2 * Math.PI) / a.order);
    // a spatial hash of slot centres, so each lookup is close to O(1)
    const grid = new Map<string, number[]>();
    const cell = (v: Vec) => v.map((x) => Math.round(x * 20)).join(',');
    this.slots.forEach((s, i) => {
      const k = cell(s.center);
      grid.set(k, [...(grid.get(k) ?? []), i]);
    });
    this.slots.forEach((s, i) => {
      if (!this.selects({ axis, from, to }, s.center)) return;
      const moved = apply(r, s.center);
      const [x, y, z] = moved.map((v) => Math.round(v * 20));
      let best = -1;
      let bestD = 1e-4;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            for (const j of grid.get(`${x + dx},${y + dy},${z + dz}`) ?? []) {
              const d = dist(this.slots[j].center, moved);
              if (d < bestD && dot(this.slots[j].normal, apply(r, s.normal)) > 0.999) {
                bestD = d;
                best = j;
              }
            }
          }
      if (best < 0) throw new Error(`no slot for a turn of ${a.name} (${from}-${to})`);
      p![i] = best;
    });
    this.perms.set(key, p);
    return p;
  }

  solved(): Int16Array {
    return Int16Array.from(this.slots, (_, i) => i);
  }

  /** the state after a move: state[slot] = the sticker (its home slot) sitting there */
  applyMove(state: Int16Array, move: Move): Int16Array {
    const order = this.axes[move.axis].order;
    const steps = ((move.amount % order) + order) % order;
    if (steps === 0) return state;
    const p = this.perm(move.axis, move.from, move.to);
    let cur = state;
    for (let s = 0; s < steps; s++) {
      const next = cur.slice();
      for (let i = 0; i < p.length; i++) if (p[i] >= 0) next[p[i]] = cur[i];
      cur = next;
    }
    return cur;
  }

  /** the colour (scheme face) of the sticker in each slot */
  colors(state: Int16Array): number[] {
    return Array.from(state, (s) => this.slots[s].face);
  }

  /** every slot on each face shows one colour (the puzzle may be turned as a whole) */
  isSolved(state: Int16Array): boolean {
    const seen = new Map<string, number>();
    for (let i = 0; i < state.length; i++) {
      const key = this.slots[i].normal.map((v) => Math.round(v * 1000)).join(',');
      const c = this.slots[state[i]].face;
      const prev = seen.get(key);
      if (prev === undefined) seen.set(key, c);
      else if (prev !== c) return false;
    }
    return true;
  }
}
