// 3D vectors and convex polygons for the virtual puzzles: just enough geometry to cut a polyhedron's
// faces into stickers and to turn layers. Everything here is pure.

export type Vec = [number, number, number];

export const EPS = 1e-7;

export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec): number => Math.sqrt(dot(a, a));
export const unit = (a: Vec): Vec => scale(a, 1 / norm(a));
export const dist = (a: Vec, b: Vec): number => norm(sub(a, b));

/** A 3x3 rotation matrix, row-major. */
export type Mat = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Rotation by `angle` (radians) about the unit `axis`, counter-clockwise seen from the axis tip (right-hand rule). */
export function rotation(axis: Vec, angle: number): Mat {
  const [x, y, z] = unit(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

export function mulMat(a: Mat, b: Mat): Mat {
  const out = new Array(9) as Mat;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return out;
}

export const apply = (m: Mat, v: Vec): Vec => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** points p with dot(n, p) = d; n is a unit vector and the "outside" is dot(n, p) > d */
export interface Plane {
  n: Vec;
  d: number;
}

export const side = (p: Plane, v: Vec): number => dot(p.n, v) - p.d;

/** the part of a convex polygon on the inner side of a plane (dot(n, v) <= d), or null when nothing is left */
export function clip(poly: Vec[], plane: Plane): Vec[] | null {
  const out: Vec[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = side(plane, a);
    const sb = side(plane, b);
    if (sa <= EPS) out.push(a);
    if ((sa < -EPS && sb > EPS) || (sa > EPS && sb < -EPS)) {
      const t = sa / (sa - sb);
      out.push(add(a, scale(sub(b, a), t)));
    }
  }
  const cleaned = dedupe(out);
  return cleaned.length >= 3 && area(cleaned) > 1e-9 ? cleaned : null;
}

/** a convex polygon split by a plane into [inside, outside]; either may be null */
export function split(poly: Vec[], plane: Plane): [Vec[] | null, Vec[] | null] {
  return [clip(poly, plane), clip(poly, { n: scale(plane.n, -1), d: -plane.d })];
}

function dedupe(poly: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const v of poly) {
    if (out.length === 0 || dist(out[out.length - 1], v) > 1e-6) out.push(v);
  }
  while (out.length > 1 && dist(out[0], out[out.length - 1]) <= 1e-6) out.pop();
  return out;
}

export function area(poly: Vec[]): number {
  let s: Vec = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) s = add(s, cross(poly[i], poly[(i + 1) % poly.length]));
  return norm(s) / 2;
}

/** area-weighted centre of a convex polygon */
export function centroid(poly: Vec[]): Vec {
  let total = 0;
  let c: Vec = [0, 0, 0];
  for (let i = 1; i + 1 < poly.length; i++) {
    const a = area([poly[0], poly[i], poly[i + 1]]);
    total += a;
    c = add(c, scale(add(add(poly[0], poly[i]), poly[i + 1]), a / 3));
  }
  return total > 0 ? scale(c, 1 / total) : poly[0];
}

/**
 * A convex polygon shrunk towards its inside: every edge moves `gap` inwards (the corners stay
 * sharp). Falls back to scaling about the centre when the polygon is too small to keep its edges.
 */
export function inset(poly: Vec[], gap: number, normal: Vec): Vec[] {
  const n = poly.length;
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n];
    const dir = unit(sub(b, a));
    const inward = unit(cross(normal, dir));
    return { p: add(a, scale(inward, gap)), dir };
  });
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i + n - 1) % n];
    const l2 = lines[i];
    // l1.p + s l1.dir = l2.p + t l2.dir, solved in the plane
    const w = sub(l2.p, l1.p);
    const den = dot(cross(l1.dir, l2.dir), normal);
    if (Math.abs(den) < 1e-12) return shrink(poly, 0.85);
    const s = dot(cross(w, l2.dir), normal) / den;
    out.push(add(l1.p, scale(l1.dir, s)));
  }
  // an edge that turned around means the gap was wider than the polygon
  const c = centroid(poly);
  for (let i = 0; i < n; i++) {
    if (dot(sub(out[i], c), sub(poly[i], c)) <= 0) return shrink(poly, 0.85);
    const e0 = sub(poly[(i + 1) % n], poly[i]);
    const e1 = sub(out[(i + 1) % n], out[i]);
    if (dot(e0, e1) <= 0) return shrink(poly, 0.85);
  }
  return out;
}

function shrink(poly: Vec[], k: number): Vec[] {
  const c = centroid(poly);
  return poly.map((v) => add(c, scale(sub(v, c), k)));
}

/** two unit vectors spanning the plane with normal n */
export function basis(n: Vec): [Vec, Vec] {
  const helper: Vec = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(helper, n));
  return [u, cross(n, u)];
}

/**
 * The face of a convex polyhedron lying in `plane`: a big square in the plane, clipped by every other
 * face plane. Wound counter-clockwise seen from outside.
 */
export function facePolygon(plane: Plane, others: Plane[], size = 100): Vec[] | null {
  const [u, v] = basis(plane.n);
  const c = scale(plane.n, plane.d);
  let poly: Vec[] | null = [
    add(c, add(scale(u, -size), scale(v, -size))),
    add(c, add(scale(u, size), scale(v, -size))),
    add(c, add(scale(u, size), scale(v, size))),
    add(c, add(scale(u, -size), scale(v, size))),
  ];
  for (const o of others) {
    if (!poly) return null;
    poly = clip(poly, o);
  }
  return poly;
}
