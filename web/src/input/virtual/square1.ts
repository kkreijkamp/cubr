// Square-1 for the virtual puzzle. The state is cubing.js's (so a scramble matches the preview): 24
// wedges of 30 degrees, top 0-11 and bottom 12-23, where (1,0) moves each top wedge one place on, (0,1)
// each bottom one, and / swaps top wedges 6-11 with bottom 12-17 and turns the right middle piece over.
// A corner is two wedges, so the slash only works when no corner sits across the cut. Pieces keep their
// shape when they move, so each is drawn from its own geometry where it is now.
import { add, apply, centroid, cross, dot, IDENTITY, mulMat, rotation, scale, sub, unit, type Mat, type Vec } from './geometry';

export interface Sq1State {
  /** the wedge (by its home slot) in each slot */
  wedges: number[];
  /** how each middle piece (0: home on the left, 1: on the right) is turned */
  middle: [Mat, Mat];
}

export type Sq1Move = { kind: 'turn'; top: number; bottom: number } | { kind: 'slash' } | { kind: 'rotate'; axis: 'y' | 'x' | 'z' };

const DEG = Math.PI / 180;
/** half the width of the square-1 seen from above, and the heights of its layers */
export const SQ1 = { w: 1 + Math.sqrt(3) / 2, layer: 1.2, middle: 0.73 };
/** the slash turns the right half about this axis (square to the cut, 15 degrees off the right face) */
export const SLICE_AXIS: Vec = [Math.cos(15 * DEG), 0, Math.sin(15 * DEG)];
/** in the cut, square to the slice axis (csTimer's z2) */
const CUT_AXIS: Vec = [Math.sin(15 * DEG), 0, -Math.cos(15 * DEG)];

// cube scheme faces: white, green, red, blue, orange, yellow (lib/scrambleNet), as cubing.js colours them
const C = { white: 0, green: 1, red: 2, blue: 3, orange: 4, yellow: 5 };
const SIDE = [C.red, C.blue, C.blue, C.blue, C.orange, C.orange, C.orange, C.green, C.green, C.green, C.red, C.red, C.red, C.red, C.green, C.green, C.green, C.orange, C.orange, C.orange, C.blue, C.blue, C.blue, C.red];
const EDGES = new Set([2, 5, 8, 11, 12, 15, 18, 21]);
/** the two wedges of each corner */
const PARTNER = new Map<number, number>();
for (const [a, b] of [
  [0, 1],
  [3, 4],
  [6, 7],
  [9, 10],
  [13, 14],
  [16, 17],
  [19, 20],
  [22, 23],
])
  PARTNER.set(a, b).set(b, a);

/** a slot's direction seen from above: degrees counter-clockwise from the right face */
export function slotAngle(slot: number): number {
  return slot < 12 ? 240 - 30 * slot : -90 + 30 * (slot - 12);
}

export const sq1Solved = (): Sq1State => ({ wedges: Array.from({ length: 24 }, (_, i) => i), middle: [IDENTITY, IDENTITY] });

export const faceColour = (wedge: number) => (wedge < 12 ? C.yellow : C.white);
export const sideColour = (wedge: number) => SIDE[wedge];
export const isEdge = (wedge: number) => EDGES.has(wedge);

/** the slash is blocked while a corner sits across the cut on either layer */
export function canSlash(s: Sq1State): boolean {
  const w = s.wedges;
  return !(PARTNER.get(w[5]) === w[6] || PARTNER.get(w[11]) === w[0] || PARTNER.get(w[17]) === w[18] || PARTNER.get(w[23]) === w[12]);
}

/** where each slot's wedge goes under a whole-puzzle half turn */
function rotateSlot(slot: number, axis: 'y' | 'x' | 'z'): number {
  const top = slot < 12;
  const i = top ? slot : slot - 12;
  if (axis === 'y') return top ? (i + 6) % 12 : 12 + ((i + 6) % 12);
  // about the slice axis: top i <-> bottom 12 + (i + 6) mod 12 (the slash does this to the right half)
  if (axis === 'x') return top ? 12 + ((i + 6) % 12) : (i + 6) % 12;
  // about the axis in the cut: both of the above
  return rotateSlot(rotateSlot(slot, 'x'), 'y');
}

const HALF_TURN: Record<'y' | 'x' | 'z', Mat> = {
  y: rotation([0, 1, 0], Math.PI),
  x: rotation(SLICE_AXIS, Math.PI),
  z: rotation(CUT_AXIS, Math.PI),
};

export function applySq1(s: Sq1State, m: Sq1Move): Sq1State {
  const w = s.wedges.slice();
  if (m.kind === 'turn') {
    const top = ((m.top % 12) + 12) % 12;
    const bottom = ((m.bottom % 12) + 12) % 12;
    for (let i = 0; i < 12; i++) {
      w[(i + top) % 12] = s.wedges[i];
      w[12 + ((i + bottom) % 12)] = s.wedges[12 + i];
    }
    return { wedges: w, middle: s.middle };
  }
  if (m.kind === 'rotate') {
    for (let i = 0; i < 24; i++) w[rotateSlot(i, m.axis)] = s.wedges[i];
    const r = HALF_TURN[m.axis];
    return { wedges: w, middle: [mulMat(r, s.middle[0]), mulMat(r, s.middle[1])] };
  }
  for (let k = 0; k < 6; k++) {
    w[6 + k] = s.wedges[12 + k];
    w[12 + k] = s.wedges[6 + k];
  }
  const r = HALF_TURN.x;
  const middle = s.middle.map((pose, i) => (middleIsRight(pose, i) ? mulMat(r, pose) : pose)) as [Mat, Mat];
  return { wedges: w, middle };
}

// ---------------------------------------------------------------- geometry
export interface Sq1Face {
  poly: Vec[];
  /** scheme face colour, or null for the dark plastic */
  color: number | null;
  normal: Vec;
}

const at = (angle: number, r: number, y: number): Vec => [r * Math.cos(angle * DEG), y, -r * Math.sin(angle * DEG)];

/** Newell normal of a polygon */
function polyNormal(poly: Vec[]): Vec {
  let n: Vec = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) n = add(n, cross(poly[i], poly[(i + 1) % poly.length]));
  return unit(n);
}

/** a convex piece's faces wound counter-clockwise from outside, with outward normals */
function piece(faces: { poly: Vec[]; color: number | null }[]): Sq1Face[] {
  const c = scale(
    faces.reduce<Vec>((s, f) => add(s, centroid(f.poly)), [0, 0, 0]),
    1 / faces.length,
  );
  return faces.map((f) => {
    let n = polyNormal(f.poly);
    let poly = f.poly;
    if (dot(n, sub(centroid(poly), c)) < 0) {
      poly = [...poly].reverse();
      n = scale(n, -1);
    }
    return { poly, color: f.color, normal: n };
  });
}

/** a wedge's faces in its home slot */
function homeWedge(wedge: number): Sq1Face[] {
  const { w, layer, middle } = SQ1;
  const home = slotAngle(wedge);
  const re = w / Math.cos(15 * DEG);
  let a1: number;
  let a2: number;
  let r1: number;
  let r2: number;
  if (isEdge(wedge)) {
    [a1, a2, r1, r2] = [home - 15, home + 15, re, re];
  } else {
    // half a corner: from the corner's diagonal to 30 degrees off it
    const diag = Math.round((home - 45) / 90) * 90 + 45;
    if (home < diag) [a1, a2, r1, r2] = [diag - 30, diag, re, w * Math.SQRT2];
    else [a1, a2, r1, r2] = [diag, diag + 30, w * Math.SQRT2, re];
  }
  const top = wedge < 12;
  const yIn = top ? middle : -middle;
  const yOut = top ? middle + layer : -middle - layer;
  const o1 = at(a1, r1, yOut);
  const o2 = at(a2, r2, yOut);
  const i1 = at(a1, r1, yIn);
  const i2 = at(a2, r2, yIn);
  const cOut: Vec = [0, yOut, 0];
  const cIn: Vec = [0, yIn, 0];
  return piece([
    { poly: [cOut, o1, o2], color: faceColour(wedge) },
    { poly: [o1, o2, i2, i1], color: sideColour(wedge) },
    { poly: [cIn, i1, i2], color: null },
    { poly: [cOut, o1, i1, cIn], color: null },
    { poly: [cOut, o2, i2, cIn], color: null },
  ]);
}

const HOME_WEDGES = Array.from({ length: 24 }, (_, i) => homeWedge(i));

/** the turn that takes a wedge from its home slot to `slot` */
export function wedgePose(wedge: number, slot: number): Mat {
  const from = slotAngle(wedge);
  const to = slotAngle(slot);
  if (wedge < 12 === slot < 12) return rotation([0, 1, 0], (to - from) * DEG);
  // over to the other layer: half a turn about x (angle a -> -a, up -> down), then about the vertical
  return mulMat(rotation([0, 1, 0], (to + from) * DEG), rotation([1, 0, 0], Math.PI));
}

/** the other half of a corner (or -1 for an edge) */
export const partnerOf = (wedge: number) => PARTNER.get(wedge) ?? -1;

/**
 * A corner (two wedges) as one piece: one kite on top instead of two triangles, both side stickers,
 * and the outer dark faces. `slotA` holds `a`, its partner sits in the next or previous slot.
 */
export function cornerFaces(a: number, slotA: number, b: number, slotB: number, extra?: Mat): Sq1Face[] {
  const fa = wedgeFaces(a, slotA, extra);
  const fb = wedgeFaces(b, slotB, extra);
  // the kite: the four distinct corners of the two top triangles, in order round their middle
  const pts: Vec[] = [];
  for (const v of [...fa[0].poly, ...fb[0].poly]) if (!pts.some((q) => Math.hypot(q[0] - v[0], q[1] - v[1], q[2] - v[2]) < 1e-6)) pts.push(v);
  const n = fa[0].normal;
  const c = scale(
    pts.reduce<Vec>((s, v) => add(s, v), [0, 0, 0]),
    1 / pts.length,
  );
  const ref = sub(pts[0], c);
  const other = cross(n, ref);
  const kite = pts.slice().sort((p, q) => {
    const ap = Math.atan2(dot(sub(p, c), other), dot(sub(p, c), ref));
    const aq = Math.atan2(dot(sub(q, c), other), dot(sub(q, c), ref));
    return ap - aq;
  });
  // the two halves' inner faces against each other are hidden inside the piece
  const shared = (f: Sq1Face, g: Sq1Face[]) => g.some((h) => h.color === null && Math.abs(dot(h.normal, f.normal) + 1) < 1e-6 && Math.abs(dot(f.normal, sub(centroid(h.poly), centroid(f.poly)))) < 1e-6);
  const keep = (fs: Sq1Face[], others: Sq1Face[]) => fs.slice(1).filter((f) => !(f.color === null && shared(f, others)));
  return [{ poly: kite, color: fa[0].color, normal: n }, ...keep(fa, fb), ...keep(fb, fa)];
}

export function wedgeFaces(wedge: number, slot: number, extra?: Mat): Sq1Face[] {
  const pose = extra ? mulMat(extra, wedgePose(wedge, slot)) : wedgePose(wedge, slot);
  return HOME_WEDGES[wedge].map((f) => ({ poly: f.poly.map((v) => apply(pose, v)), color: f.color, normal: apply(pose, f.normal) }));
}

function cutPoint(angle: number): Vec {
  const a = angle * DEG;
  const dx = Math.cos(a);
  const dz = -Math.sin(a);
  const t = SQ1.w / Math.max(Math.abs(dx), Math.abs(dz));
  return [dx * t, 0, dz * t];
}

/** the two middle pieces in their home places: 0 left of the cut, 1 right of it */
const HOME_MIDDLE: Sq1Face[][] = (() => {
  const { w, middle } = SQ1;
  const cutFront = cutPoint(-105);
  const cutBack = cutPoint(75);
  const corner = (deg: number) => at(deg, w * Math.SQRT2, 0);
  // seen from above, counter-clockwise; the last edge is the cut
  const outlines = [
    [cutBack, corner(135), corner(225), cutFront],
    [cutFront, corner(315), corner(45), cutBack],
  ];
  // side colours (cubing.js): front red, right green, back orange, left blue
  const sideOf = (a: Vec, b: Vec): number => {
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[2] + b[2]) / 2;
    if (Math.abs(mx) > Math.abs(mz)) return mx > 0 ? C.green : C.blue;
    return mz > 0 ? C.red : C.orange;
  };
  return outlines.map((outline) => {
    const top = outline.map((p): Vec => [p[0], middle, p[2]]);
    const bottom = outline.map((p): Vec => [p[0], -middle, p[2]]);
    const faces: { poly: Vec[]; color: number | null }[] = [
      { poly: top, color: null },
      { poly: bottom, color: null },
    ];
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length;
      faces.push({ poly: [top[i], top[j], bottom[j], bottom[i]], color: i === outline.length - 1 ? null : sideOf(outline[i], outline[j]) });
    }
    return piece(faces);
  });
})();

const MIDDLE_CENTRES = HOME_MIDDLE.map((faces) =>
  scale(
    faces.reduce<Vec>((s, f) => add(s, centroid(f.poly)), [0, 0, 0]),
    1 / faces.length,
  ),
);

function middleIsRight(pose: Mat, piece: number): boolean {
  return dot(apply(pose, MIDDLE_CENTRES[piece]), SLICE_AXIS) > 0;
}

export function middleFaces(s: Sq1State, piece: number, extra?: Mat): Sq1Face[] {
  const pose = extra ? mulMat(extra, s.middle[piece]) : s.middle[piece];
  return HOME_MIDDLE[piece].map((f) => ({ poly: f.poly.map((v) => apply(pose, v)), color: f.color, normal: apply(pose, f.normal) }));
}

/** the middle piece now right of the cut */
export const rightMiddle = (s: Sq1State) => (middleIsRight(s.middle[0], 0) ? 0 : 1);

/** solved: the stickers of each colour all lie in one face of the cube (csTimer's test), in any orientation */
export function sq1IsSolved(s: Sq1State): boolean {
  const planes = new Map<number, [Vec, number]>();
  const check = (f: Sq1Face): boolean => {
    if (f.color === null) return true;
    const d = dot(f.normal, centroid(f.poly));
    const seen = planes.get(f.color);
    if (!seen) {
      planes.set(f.color, [f.normal, d]);
      return true;
    }
    return dot(seen[0], f.normal) > 0.999 && Math.abs(seen[1] - d) < 1e-6;
  };
  for (let slot = 0; slot < 24; slot++) for (const f of wedgeFaces(s.wedges[slot], slot)) if (!check(f)) return false;
  for (let p = 0; p < 2; p++) for (const f of middleFaces(s, p)) if (!check(f)) return false;
  return true;
}

// ---------------------------------------------------------------- notation and keys
/** "(1,0) / (-3,3) /": WCA notation */
export function parseSq1(alg: string): Sq1Move[] | null {
  const out: Sq1Move[] = [];
  for (const m of alg.matchAll(/\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)|(\/)|(\S+)/g)) {
    if (m[1] !== undefined) {
      const top = Number(m[1]);
      const bottom = Number(m[2]);
      if (top || bottom) out.push({ kind: 'turn', top, bottom });
    } else if (m[3]) out.push({ kind: 'slash' });
    else if (/^[yxz]2'?$/.test(m[4])) out.push({ kind: 'rotate', axis: m[4][0] as 'y' | 'x' | 'z' });
    else return null;
  }
  return out;
}

export function sq1MoveName(m: Sq1Move): string {
  if (m.kind === 'slash') return '/';
  if (m.kind === 'rotate') return `${m.axis}2`;
  return `(${m.top},${m.bottom})`;
}

/** csTimer's square-1 keys (twisty/twistysq1.js) */
export function sq1Key(code: string): Sq1Move | null {
  const turn = (top: number, bottom: number): Sq1Move => ({ kind: 'turn', top, bottom });
  switch (code) {
    case 'KeyI':
    case 'KeyK':
      return { kind: 'slash' };
    case 'KeyJ':
      return turn(1, 0);
    case 'KeyF':
      return turn(-1, 0);
    case 'KeyH':
      return turn(3, 0);
    case 'KeyG':
      return turn(-3, 0);
    case 'KeyS':
      return turn(0, 1);
    case 'KeyL':
      return turn(0, -1);
    case 'KeyW':
      return turn(0, 3);
    case 'KeyO':
      return turn(0, -3);
    case 'Semicolon':
    case 'KeyA':
      return { kind: 'rotate', axis: 'y' };
    case 'KeyT':
    case 'KeyY':
    case 'KeyN':
    case 'KeyB':
      return { kind: 'rotate', axis: 'x' };
    case 'KeyP':
    case 'KeyQ':
      return { kind: 'rotate', axis: 'z' };
    default:
      return null;
  }
}

export const sq1IsRotation = (m: Sq1Move) => m.kind === 'rotate';

/** slots on the right of the cut (turned by /) */
export const isRightSlot = (slot: number) => (slot >= 6 && slot < 12) || (slot >= 12 && slot < 18);

export { SLICE_AXIS as sq1SliceAxis };
