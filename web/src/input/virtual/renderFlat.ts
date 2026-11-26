// qCube: the virtual puzzle drawn flat, the way csTimer's qCube draws it. Cubes: the top face, the
// front face under it and a strip of each side face beside them (csTimer's twisty/qcubennn.js);
// megaminx: the top face and the five faces around it; the others as an unfolded net.
import { apply, cross, dot, inset, rotation, scale, sub, unit, type Mat, type Vec } from './geometry';
import type { PolyPuzzle } from './polyPuzzle';
import type { Palette } from './render3d';
import { cornerFaces, middleFaces, partnerOf, SQ1, wedgeFaces, type Sq1State } from './square1';

type Pt = [number, number];

function fill(ctx: CanvasRenderingContext2D, pts: Pt[], color: string, round: number) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  if (round > 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = round;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

/** a sticker's place on a cube, as an index into a URFDLB facelet string (rows and columns as the standard nets read them) */
export function cubeFacelet(n: number, center: Vec, normal: Vec): number {
  const [x, y, z] = center;
  const col = (v: number) => Math.round((v + n - 1) / 2);
  const row = (v: number) => Math.round((n - 1 - v) / 2);
  let face: number;
  let r: number;
  let c: number;
  if (normal[1] > 0.5) [face, r, c] = [0, col(z), col(x)];
  else if (normal[0] > 0.5) [face, r, c] = [1, row(y), row(z)];
  else if (normal[2] > 0.5) [face, r, c] = [2, row(y), col(x)];
  else if (normal[1] < -0.5) [face, r, c] = [3, row(z), col(x)];
  else if (normal[0] < -0.5) [face, r, c] = [4, row(y), col(z)];
  else [face, r, c] = [5, row(y), row(x)];
  return face * n * n + r * n + c;
}

/** csTimer's qCube for an NxN cube: `colors` by facelet (URFDLB order) */
export function drawQCube(ctx: CanvasRenderingContext2D, width: number, height: number, n: number, colors: string[]) {
  const gap = Math.sqrt(n / 3) * 0.1;
  const w = n + 2 + gap * 4;
  const h = n * 2 + gap * 3;
  const unitPx = Math.min(width / w, height / h);
  const ox = (width - w * unitPx) / 2;
  const oy = (height - h * unitPx) / 2;
  const inset = 0.06;
  const round = Math.max(1, unitPx * 0.06);
  const cell = (x: number, y: number, cw: number, ch: number, color: string) => {
    const x0 = ox + (x + inset) * unitPx;
    const y0 = oy + (y + inset) * unitPx;
    const x1 = ox + (x + cw - inset) * unitPx;
    const y1 = oy + (y + ch - inset) * unitPx;
    fill(
      ctx,
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ],
      color,
      round,
    );
  };
  const at = (face: number, r: number, c: number) => colors[face * n * n + r * n + c];
  const U = 0;
  const R = 1;
  const F = 2;
  const L = 4;
  const x0 = 1 + gap * 2;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      cell(x0 + c, gap + r, 1, 1, at(U, r, c));
      cell(x0 + c, n + gap * 2 + r, 1, 1, at(F, r, c));
    }
  }
  // the side strips: each side face's top row beside U (back to front), its front column beside F,
  // the corner between them drawn tall across both
  for (let r = 0; r < n - 1; r++) {
    cell(gap, gap + r, 1, 1, at(L, 0, r));
    cell(x0 + n + gap, gap + r, 1, 1, at(R, 0, n - 1 - r));
  }
  cell(gap, gap + n - 1, 1, 2 + gap, at(L, 0, n - 1));
  cell(x0 + n + gap, gap + n - 1, 1, 2 + gap, at(R, 0, 0));
  for (let r = 1; r < n; r++) {
    cell(gap, n + gap * 2 + r, 1, 1, at(L, r, n - 1));
    cell(x0 + n + gap, n + gap * 2 + r, 1, 1, at(R, r, 0));
  }
}

/** faces unfolded into one plane: the root, then each child turned flat about the edge it shares with its parent */
function unfold(puzzle: PolyPuzzle, tree: [number, number][], root: number): Map<number, Mat & { t?: Vec }> {
  const out = new Map<number, { m: Mat; t: Vec }>();
  out.set(root, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
  const xf = (f: number, v: Vec): Vec => {
    const x = out.get(f)!;
    const r = apply(x.m, v);
    return [r[0] + x.t[0], r[1] + x.t[1], r[2] + x.t[2]];
  };
  for (const [parent, child] of tree) {
    const pp = puzzle.facePolys[parent]!;
    const cp = puzzle.facePolys[child]!;
    const shared = pp.filter((a) => cp.some((b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6));
    if (shared.length < 2) continue;
    const [a, b] = shared;
    const axis = unit(sub(b, a));
    const np = puzzle.faces[parent].plane.n;
    const nc = puzzle.faces[child].plane.n;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(np, nc))));
    // turn the child about the shared edge until its normal is the parent's
    let r = rotation(axis, angle);
    if (dot(apply(r, nc), np) < 0.999) r = rotation(axis, -angle);
    // rotate about the edge through a: v -> r(v - a) + a, then the parent's own transform
    const pt = out.get(parent)!;
    const m = mulM(pt.m, r);
    const ta = apply(r, a);
    const t = sub(xf(parent, a), apply(pt.m, ta));
    out.set(child, { m, t });
  }
  return out as never;
}

function mulM(a: Mat, b: Mat): Mat {
  const o = new Array(9) as Mat;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

export interface NetLayout {
  /** groups of faces drawn as one unfolded piece, each round its root, side by side */
  pieces: { root: number; tree: [number, number][]; up: Vec }[];
}

/** a polyhedral puzzle as an unfolded net */
export function drawNet(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  puzzle: PolyPuzzle,
  layout: NetLayout,
  colorOf: (slot: number) => string,
  palette: Palette,
) {
  // every slot in 2D, piece by piece
  const shapes: { piece: number; plate: Pt[]; sticker: Pt[]; slot: number }[] = [];
  layout.pieces.forEach((pc, idx) => {
    const t = unfold(puzzle, pc.tree, pc.root) as unknown as Map<number, { m: Mat; t: Vec }>;
    const n = puzzle.faces[pc.root].plane.n;
    // the root's plane, with `up` pointing up on the screen
    const v = unit(sub(pc.up, scale(n, dot(pc.up, n))));
    const u = cross(v, n);
    const to2 = (p: Vec): Pt => [dot(p, u), -dot(p, v)];
    puzzle.slots.forEach((s, i) => {
      const x = t.get(s.faceIdx);
      if (!x) return;
      const f = (p: Vec): Pt => {
        const r = apply(x.m, p);
        return to2([r[0] + x.t[0], r[1] + x.t[1], r[2] + x.t[2]]);
      };
      shapes.push({ piece: idx, plate: s.poly.map(f), sticker: s.sticker.map(f), slot: i });
    });
  });
  // lay the pieces out left to right and fit everything
  const boxes = layout.pieces.map((_, idx) => {
    const pts = shapes.filter((s) => s.piece === idx).flatMap((s) => s.plate);
    return {
      x0: Math.min(...pts.map((p) => p[0])),
      x1: Math.max(...pts.map((p) => p[0])),
      y0: Math.min(...pts.map((p) => p[1])),
      y1: Math.max(...pts.map((p) => p[1])),
    };
  });
  const gapU = 0.08 * Math.max(...boxes.map((b) => b.y1 - b.y0));
  const totalW = boxes.reduce((s, b) => s + (b.x1 - b.x0), 0) + gapU * (boxes.length - 1);
  const totalH = Math.max(...boxes.map((b) => b.y1 - b.y0));
  const k = Math.min(width / totalW, height / totalH) * 0.96;
  const offsets: number[] = [];
  let x = (width - totalW * k) / 2;
  for (const b of boxes) {
    offsets.push(x - b.x0 * k);
    x += (b.x1 - b.x0 + gapU) * k;
  }
  const round = Math.max(1, Math.min(width, height) / 170);
  for (const s of shapes) {
    const b = boxes[s.piece];
    const oy = (height - (b.y1 - b.y0) * k) / 2 - b.y0 * k;
    const map = (p: Pt): Pt => [offsets[s.piece] + p[0] * k, oy + p[1] * k];
    fill(ctx, s.plate.map(map), palette.body, 1);
    fill(ctx, s.sticker.map(map), colorOf(s.slot), round);
  }
}

/** Square-1 flat: the top seen from above and the bottom seen from below, sides as a band around them, the middle under them */
export function drawSq1Flat(ctx: CanvasRenderingContext2D, width: number, height: number, state: Sq1State, palette: Palette) {
  const { w } = SQ1;
  const band = 0.5;
  const span = (w * Math.SQRT2 + band) * 2;
  const k = Math.min(width / (span * 2 + 0.6), height / (span + 0.9)) * 0.96;
  const cy = height / 2 - 0.3 * k;
  const round = Math.max(1, k * 0.04);
  const centres = [width / 2 - (span / 2 + 0.3) * k, width / 2 + (span / 2 + 0.3) * k];
  for (let layer = 0; layer < 2; layer++) {
    const cx = centres[layer];
    // the top from above (front at the bottom); the bottom from below, tipped forwards (front at the top)
    const view = (v: Vec): Pt => [cx + v[0] * k, cy + (layer === 0 ? v[2] : -v[2]) * k];
    for (let i = 0; i < 12; i++) {
      const slot = layer * 12 + i;
      const wedge = state.wedges[slot];
      const [face, side] = wedgeFaces(wedge, slot);
      // a corner's top is one kite, drawn from its first half
      const partner = partnerOf(wedge);
      const next = layer * 12 + ((i + 1) % 12);
      const prev = layer * 12 + ((i + 11) % 12);
      if (partner < 0 || state.wedges[next] === partner) {
        const topFace = partner < 0 ? face : cornerFaces(wedge, slot, partner, next)[0];
        fill(ctx, topFace.poly.map(view), palette.body, 1);
        fill(ctx, inset(topFace.poly, 0.075, topFace.normal).map(view), palette.faces[topFace.color!] ?? palette.body, round);
      } else if (state.wedges[prev] !== partner) {
        continue;
      }
      // the side sticker's outer edge, pushed out into a band
      const yOuter = Math.max(...side.poly.map((v) => Math.abs(v[1])));
      const outer = side.poly.filter((v) => Math.abs(Math.abs(v[1]) - yOuter) < 1e-6);
      if (outer.length < 2) continue;
      const push = (v: Vec, d: number): Vec => {
        const r = Math.hypot(v[0], v[2]);
        return [(v[0] * (r + d)) / r, v[1], (v[2] * (r + d)) / r];
      };
      const strip = [view(push(outer[0], 0.08)), view(push(outer[1], 0.08)), view(push(outer[1], band)), view(push(outer[0], band))];
      fill(ctx, strip, palette.body, 1);
      fill(ctx, shrink(strip, round * 1.5), palette.faces[side.color!] ?? palette.body, round);
    }
  }
  // the middle: each half as the colour it shows at the front
  const barY = cy + (span / 2 + 0.2) * k;
  const barH = 0.36 * k;
  const barW = span * 0.7 * k;
  for (let piece = 0; piece < 2; piece++) {
    const faces = middleFaces(state, piece);
    const front = faces.find((f) => f.color !== null && f.normal[2] > 0.9);
    const isRight = faces.reduce((s, f) => s + f.poly.reduce((t, v) => t + v[0], 0), 0) > 0;
    const x0 = width / 2 + (isRight ? 2 : -barW - 2);
    const rect: Pt[] = [
      [x0, barY],
      [x0 + barW, barY],
      [x0 + barW, barY + barH],
      [x0, barY + barH],
    ];
    fill(ctx, rect, palette.body, 1);
    if (front) fill(ctx, shrink(rect, round * 2), palette.faces[front.color!] ?? palette.body, round);
  }
}

function shrink(pts: Pt[], px: number): Pt[] {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map(([x, y]) => {
    const len = Math.hypot(x - cx, y - cy) || 1;
    const k = Math.max(0, (len - px) / len);
    return [cx + (x - cx) * k, cy + (y - cy) * k];
  });
}
