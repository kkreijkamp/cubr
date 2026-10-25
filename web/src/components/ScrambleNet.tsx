import { useEffect, useMemo, useState } from 'react';
import type { KPuzzle } from 'cubing/kpuzzle';
import {
  convexHull,
  IDENTITY,
  multiply,
  parsePoints,
  parseTransform,
  pathPoints,
  signedArea,
  stickerColour,
  stickerId,
  stickerSources,
  tile,
  touchingGroups,
  transformPoint,
  type Matrix,
  type Point,
  type Tile,
} from '../lib/scrambleNet';

interface Sticker {
  id: string;
  points: string;
  stroke: number;
}

interface Net {
  puzzle: string;
  kpuzzle: KPuzzle;
  viewBox: string;
  /** one plate per face, behind its stickers */
  plates: Omit<Sticker, 'id'>[];
  stickers: Sticker[];
  /** guide lines drawn over the stickers (square-1's slice) */
  lines: { x1: number; y1: number; x2: number; y2: number; width: number }[];
  /** each sticker's colour on the solved puzzle */
  solved: Map<string, string>;
}

interface Style {
  /** the gap between stickers and their corner radius, as fractions of a typical sticker's size */
  gap: number;
  radius: number;
  /** a dark plate behind each face, so white and yellow stickers stand out on light themes too */
  plates: boolean;
}
const STYLE: Style = { gap: 0.14, radius: 0.16, plates: true };
const PLATE_RADIUS = 0.22;
const STYLES: Record<string, Style> = {
  // square-1's net splits each sticker into a few polygons, and its pieces are irregular: drawn
  // flat, each polygon overlapping its neighbours a little so no seams show, as one shape per layer
  square1: { gap: -0.03, radius: 0.015, plates: false },
};

/** the transforms from `el` up to (not including) `stop`, as one matrix */
function chain(el: Element, stop: Element | null): Matrix {
  let m = IDENTITY;
  for (let e: Element | null = el; e && e !== stop; e = e.parentElement) m = multiply(parseTransform(e.getAttribute('transform')), m);
  return m;
}

function shapePoints(el: Element): Point[] | null {
  switch (el.localName) {
    case 'polygon':
      return parsePoints(el.getAttribute('points'));
    case 'rect': {
      const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((a) => Number(el.getAttribute(a) ?? 0));
      return [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
    }
    case 'path':
      return pathPoints(el.getAttribute('d') ?? '');
    default:
      return null;
  }
}

/** a sticker's corners in the net's coordinates (stickers may be <use>s of a shared shape) */
function stickerPoints(el: Element, root: Element): Point[] | null {
  if (el.localName !== 'use') {
    const pts = shapePoints(el);
    return pts && pts.map((p) => transformPoint(chain(el, root), p));
  }
  const href = el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '';
  const target = el.ownerDocument.getElementById(href.replace(/^#/, ''));
  const shape = target && (shapePoints(target) ? target : target.querySelector('rect, polygon, path'));
  const pts = shape && shapePoints(shape);
  if (!target || !shape || !pts) return null;
  const at: Matrix = [1, 0, 0, 1, Number(el.getAttribute('x') ?? 0), Number(el.getAttribute('y') ?? 0)];
  const m = multiply(chain(el, root), multiply(at, chain(shape, target.parentElement)));
  return pts.map((p) => transformPoint(m, p));
}

async function buildNet(puzzle: string): Promise<Net> {
  const { puzzles } = await import('cubing/puzzles');
  const loader = puzzles[puzzle];
  if (!loader) throw new Error(`no 2D net for ${puzzle}`);
  const [svg, kpuzzle] = await Promise.all([loader.svg(), loader.kpuzzle()]);
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  const cells: { id: string; points: Point[] }[] = [];
  const solved = new Map<string, string>();
  const drawn = new Set<string>();
  for (const { orbitName, numPieces, numOrientations } of kpuzzle.definition.orbits) {
    for (let piece = 0; piece < numPieces; piece++) {
      for (let o = 0; o < numOrientations; o++) {
        const id = stickerId(orbitName, piece, o);
        const el = doc.getElementById(id);
        const points = el && stickerPoints(el, root);
        if (!el || !points || points.length < 3) continue;
        solved.set(id, (/fill:\s*([^;]+)/.exec(el.getAttribute('style') ?? '')?.[1] ?? el.getAttribute('fill') ?? '#888').trim());
        // centres come once per orientation, stacked in one place: one tile is enough
        const at = points.map((p) => p.map((v) => v.toFixed(2)).join(',')).join(' ');
        if (drawn.has(at)) continue;
        drawn.add(at);
        cells.push({ id, points });
      }
    }
  }
  if (!cells.length) throw new Error(`no stickers in the ${puzzle} net`);
  const lines = [...doc.querySelectorAll('line')].map((el) => {
    const m = chain(el, root);
    const [x1, y1] = transformPoint(m, [Number(el.getAttribute('x1') ?? 0), Number(el.getAttribute('y1') ?? 0)]);
    const [x2, y2] = transformPoint(m, [Number(el.getAttribute('x2') ?? 0), Number(el.getAttribute('y2') ?? 0)]);
    const width = Number(el.closest('[stroke-width]')?.getAttribute('stroke-width') ?? 1) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    return { x1, y1, x2, y2, width };
  });
  // gaps and corners scale with the stickers, so a 7x7 looks like a 3x3
  const sizes = cells.map((c) => Math.sqrt(Math.abs(signedArea(c.points)))).sort((a, b) => a - b);
  const size = sizes[Math.floor(sizes.length / 2)];
  const all = [...cells.flatMap((c) => c.points), ...lines.flatMap((l): Point[] => [[l.x1, l.y1], [l.x2, l.y2]])];
  const [x0, y0] = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))];
  const [x1, y1] = [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
  const style = STYLES[puzzle] ?? STYLE;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const draw = (t: Tile) => ({ points: t.points.map((p) => `${r(p[0])},${r(p[1])}`).join(' '), stroke: r(t.stroke) });
  return {
    puzzle,
    kpuzzle,
    viewBox: [x0, y0, x1 - x0, y1 - y0].map(r).join(' '),
    plates: style.plates
      ? touchingGroups(
          cells.map((c) => c.points),
          size * 0.02,
        ).map((face) => draw(tile(convexHull(face.flatMap((i) => cells[i].points)), 0, PLATE_RADIUS * size)))
      : [],
    stickers: cells.map(({ id, points }) => ({ id, ...draw(tile(points, style.gap * size, style.radius * size)) })),
    lines: lines.map((l) => ({ x1: r(l.x1), y1: r(l.y1), x2: r(l.x2), y2: r(l.y2), width: r(l.width) })),
    solved,
  };
}

const nets = new Map<string, Promise<Net>>();
function netFor(puzzle: string): Promise<Net> {
  let net = nets.get(puzzle);
  if (!net) {
    net = buildNet(puzzle);
    nets.set(puzzle, net);
    net.catch(() => nets.delete(puzzle));
  }
  return net;
}

interface Props {
  /** cubing.js puzzle id, e.g. "3x3x3", "megaminx" */
  puzzle: string;
  scramble: string;
  height: number;
  /** the puzzle has no net that can be drawn this way */
  onError: () => void;
}

/** The scrambled puzzle as a flat net of rounded stickers (see lib/scrambleNet). */
export function ScrambleNet({ puzzle, scramble, height, onError }: Props) {
  const [net, setNet] = useState<Net | null>(null);

  useEffect(() => {
    let live = true;
    netFor(puzzle).then(
      (n) => live && setNet(n),
      () => live && onError(),
    );
    return () => {
      live = false;
    };
  }, [puzzle, onError]);

  const fills = useMemo(() => {
    if (!net || net.puzzle !== puzzle) return null;
    try {
      const sources = stickerSources(net.kpuzzle.definition.orbits, net.kpuzzle.defaultPattern().applyAlg(scramble).patternData);
      return new Map(net.stickers.map((s) => [s.id, stickerColour(net.solved.get(sources.get(s.id) ?? s.id) ?? '#888')]));
    } catch {
      // not a scramble for this puzzle (e.g. a hand-typed one): show nothing rather than a wrong state
      return null;
    }
  }, [net, puzzle, scramble]);

  return (
    <div className="twisty-host" style={{ minHeight: height }}>
      {net && fills && (
        <svg className="scramble-net" viewBox={net.viewBox} style={{ height }} aria-hidden="true">
          {net.plates.map((p, i) => (
            <polygon key={i} className="plate" points={p.points} strokeWidth={p.stroke || undefined} strokeLinejoin="round" />
          ))}
          {net.stickers.map((s) => {
            const fill = fills.get(s.id);
            return <polygon key={s.id} points={s.points} fill={fill} stroke={s.stroke ? fill : undefined} strokeWidth={s.stroke || undefined} strokeLinejoin="round" />;
          })}
          {net.lines.map((l, i) => (
            <line key={i} className="guide" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} strokeWidth={l.width} />
          ))}
        </svg>
      )}
    </div>
  );
}
