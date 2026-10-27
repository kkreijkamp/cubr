import { describe, expect, it } from 'vitest';
import { modelFor, type PolyModel } from '../virtual/models';
import { drawPoly, insetOnScreen, type Camera, type Palette } from '../virtual/render3d';

/** a canvas that only remembers what it filled, in order */
function recorder() {
  const fills: { color: string; pts: [number, number][] }[] = [];
  let pts: [number, number][] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'round',
    beginPath: () => (pts = []),
    moveTo: (x: number, y: number) => pts.push([x, y]),
    lineTo: (x: number, y: number) => pts.push([x, y]),
    closePath: () => {},
    fill() {
      fills.push({ color: ctx.fillStyle, pts });
    },
    stroke: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills };
}

const cube = modelFor('333') as PolyModel;
const palette: Palette = { faces: ['#ffffff', '#00ff00', '#ff0000', '#0000ff', '#ff8000', '#ffff00'], body: '#000000' };
// the corner view: the top, front and right faces in sight
const cam: Camera = { yaw: Math.PI / 6, pitch: (5 * Math.PI) / 24, distance: 4.2, radius: Math.sqrt(3) * 3 };
/** a sticker's width on screen, on average */
const width = (fills: { pts: [number, number][] }[]) => fills.reduce((sum, f) => sum + Math.max(...f.pts.map((p) => p[0])) - Math.min(...f.pts.map((p) => p[0])), 0) / fills.length;

describe('floating stickers (csTimer’s hollow cube)', () => {
  it('solid: the three faces in sight, each sticker on its plate', () => {
    const { ctx, fills } = recorder();
    drawPoly(ctx, 400, 400, cube.twisty.puzzle, cube.solved(), cam, palette, []);
    expect(fills.length).toBe(27 * 2);
    expect(fills.filter((f) => f.color === '#000000').length).toBe(27);
  });

  it('floating: every sticker in its own colour, the far side first', () => {
    const solid = recorder();
    drawPoly(solid.ctx, 400, 400, cube.twisty.puzzle, cube.solved(), cam, palette, []);
    const near = new Set(solid.fills.map((f) => f.color).filter((c) => c !== '#000000'));
    expect(near.size).toBe(3);
    const { ctx, fills } = recorder();
    drawPoly(ctx, 400, 400, cube.twisty.puzzle, cube.solved(), cam, palette, [], { float: 0.3, outline: 0 });
    expect(fills.length).toBe(54);
    expect(fills.every((f) => palette.faces.includes(f.color))).toBe(true);
    // the 27 far stickers, then the 27 in sight
    expect(fills.slice(0, 27).every((f) => !near.has(f.color))).toBe(true);
    expect(fills.slice(27).every((f) => near.has(f.color))).toBe(true);
  });

  it('outlines each sticker with a plate of its own (none at 0)', () => {
    const at = (float: number, outline: number) => {
      const { ctx, fills } = recorder();
      drawPoly(ctx, 400, 400, cube.twisty.puzzle, cube.solved(), cam, palette, [], { float, outline });
      return { plates: fills.filter((f) => f.color === '#000000'), stickers: fills.filter((f) => f.color !== '#000000') };
    };
    // floating: a plate under every sticker, near and far
    const floating = at(0.3, 1);
    expect(floating.plates.length).toBe(54);
    expect(floating.stickers.length).toBe(54);
    // the thicker the outline, the smaller the sticker on its plate
    for (const float of [0, 0.3]) {
      const thin = at(float, 0.5);
      const thick = at(float, 2);
      expect(width(thick.plates)).toBeCloseTo(width(thin.plates), 6);
      expect(width(thick.stickers)).toBeLessThan(width(thin.stickers));
      expect(width(at(float, 0).stickers)).toBeGreaterThan(width(thin.stickers));
    }
  });

  it('keeps the outline as wide all round, however a sticker is turned on screen', () => {
    const near = (a: [number, number][] | null, b: [number, number][]) => {
      expect(a).not.toBeNull();
      a!.forEach((p, i) => {
        expect(p[0]).toBeCloseTo(b[i][0], 9);
        expect(p[1]).toBeCloseTo(b[i][1], 9);
      });
    };
    const square: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    near(insetOnScreen(square, 2), [
      [2, 2],
      [8, 2],
      [8, 8],
      [2, 8],
    ]);
    // the other way round, the same
    near(insetOnScreen([...square].reverse(), 2), [
      [2, 8],
      [8, 8],
      [8, 2],
      [2, 2],
    ]);
    // a plate seen at a slant: every edge of the sticker 1.5 px in from its plate's
    const slanted: [number, number][] = [
      [0, 0],
      [40, 8],
      [44, 30],
      [3, 20],
    ];
    const pts = insetOnScreen(slanted, 1.5)!;
    pts.forEach((p, i) => {
      const [a, b] = [slanted[i], slanted[(i + 1) % 4]];
      const q = pts[(i + 1) % 4];
      const dist = (v: [number, number]) => Math.abs((b[0] - a[0]) * (a[1] - v[1]) - (a[0] - v[0]) * (b[1] - a[1])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
      expect(dist(p)).toBeCloseTo(1.5, 9);
      expect(dist(q)).toBeCloseTo(1.5, 9);
    });
    // seen edge on: nothing left inside the outline
    expect(
      insetOnScreen(
        [
          [0, 0],
          [30, 0],
          [30, 2],
          [0, 2],
        ],
        1.5,
      ),
    ).toBeNull();
  });

  it('floats further apart the further it goes, still inside the view', () => {
    const at = (float: number) => {
      const { ctx, fills } = recorder();
      drawPoly(ctx, 400, 400, cube.twisty.puzzle, cube.solved(), cam, palette, [], { float });
      return fills;
    };
    for (const f of [0.1, 0.5, 1]) {
      const fills = at(f);
      expect(fills.every((x) => x.pts.every(([px, py]) => px >= 0 && px <= 400 && py >= 0 && py <= 400))).toBe(true);
    }
    // the stickers get smaller as they float apart
    expect(width(at(1))).toBeLessThan(width(at(0.5)));
    expect(width(at(0.5))).toBeLessThan(width(at(0.1)));
  });

  it('turns a layer of a floating cube', () => {
    const { ctx, fills } = recorder();
    const mv = cube.parse('R')![0];
    drawPoly(ctx, 400, 400, cube.twisty.puzzle, cube.solved(), cam, palette, [{ move: mv, angle: cube.twisty.puzzle.angle(mv) / 2 }], { float: 0.3 });
    // a plate turned edge on is all outline
    expect(fills.filter((f) => f.color === '#000000').length).toBe(54);
    expect(fills.length).toBeGreaterThan(54 + 45);
  });
});
