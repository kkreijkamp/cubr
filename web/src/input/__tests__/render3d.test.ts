import { describe, expect, it } from 'vitest';
import { modelFor, type PolyModel } from '../virtual/models';
import { drawPoly, type Camera, type Palette } from '../virtual/render3d';

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

  it('floating: every sticker, no plastic, the far side first and in the shade', () => {
    const { ctx, fills } = recorder();
    drawPoly(ctx, 400, 400, cube.twisty.puzzle, cube.solved(), cam, palette, [], { float: 0.3 });
    expect(fills.length).toBe(54);
    expect(fills.some((f) => f.color === '#000000')).toBe(false);
    const own = new Set(palette.faces);
    // the 27 far stickers, shaded, then the 27 near ones in their own colours
    expect(fills.slice(0, 27).every((f) => !own.has(f.color))).toBe(true);
    expect(fills.slice(27).every((f) => own.has(f.color))).toBe(true);
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
    expect(fills.length).toBe(54);
  });
});
