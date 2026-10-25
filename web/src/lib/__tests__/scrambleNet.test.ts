import { describe, expect, it } from 'vitest';
import { puzzles } from 'cubing/puzzles';
import {
  closeUp,
  convexHull,
  insetConvex,
  parsePoints,
  parseTransform,
  pathPoints,
  polygonDistance,
  signedArea,
  stickerColour,
  stickerSources,
  tile,
  touchingGroups,
  transformPoint,
  type Point,
} from '../scrambleNet';

const close = (got: Point[] | null, want: Point[]) => {
  expect(got).not.toBeNull();
  expect(got!.length).toBe(want.length);
  got!.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(want[i][0], 6);
    expect(p[1]).toBeCloseTo(want[i][1], 6);
  });
};

const square = (x: number, y: number, s = 1): Point[] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];

describe('parseTransform', () => {
  it('composes translate, scale and rotate like SVG (left to right)', () => {
    const m = parseTransform('translate(5,40) scale(40)');
    close([transformPoint(m, [1, 2])], [[45, 120]]);
    // rotate about a point keeps that point fixed
    const r = parseTransform('rotate(90 10 0)');
    close([transformPoint(r, [10, 0]), transformPoint(r, [11, 0])], [
      [10, 0],
      [10, 1],
    ]);
    // square-1's chain: translate, rotate about a point, translate back, translate
    const sq = parseTransform('translate(130.000000, 88.588457) rotate(120.000000) translate(-130.000000, -88.588457) translate(82.000000, 22.588457)');
    const step = parseTransform('rotate(120 130 88.588457)');
    close([transformPoint(sq, [0, 0])], [transformPoint(step, [82, 22.588457])]);
    expect(parseTransform('matrix(1 2 3 4 5 6)')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseTransform(null)).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe('parsePoints / pathPoints', () => {
  it('reads polygon points, exponents included', () => {
    expect(parsePoints('25.723 70.277 40.574 95.999 -2.27373675e-13 96')).toEqual([
      [25.723, 70.277],
      [40.574, 95.999],
      [-2.27373675e-13, 96],
    ]);
  });
  it('reads straight-line paths, relative and absolute', () => {
    close(pathPoints('m 0,1.732050808 1,-1.732050808 1,1.732050808 z'), [
      [0, 1.732050808],
      [1, 0],
      [2, 1.732050808],
    ]);
    close(pathPoints('M0 0 H2 V2 L0 2 Z'), [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ]);
    expect(() => pathPoints('M0 0 C1 1 2 2 3 3')).toThrow();
  });
});

describe('insetConvex', () => {
  it('moves every side in by the same distance, either winding', () => {
    close(insetConvex(square(0, 0, 10), 1), square(1, 1, 8));
    close(insetConvex([...square(0, 0, 10)].reverse(), 1), [...square(1, 1, 8)].reverse());
    // a right triangle: the inset corner sits d from both legs
    const t = insetConvex(
      [
        [0, 0],
        [10, 0],
        [0, 10],
      ],
      1,
    )!;
    expect(t[0]).toEqual([1, 1]);
  });
  it('ignores repeated corners and corners on a straight side', () => {
    close(
      insetConvex(
        [
          [0, 0],
          [5, 0],
          [10, 0],
          [10, 10],
          [10, 10],
          [0, 10],
        ],
        1,
      ),
      [
        [1, 1],
        [9, 1],
        [9, 9],
        [1, 9],
      ],
    );
  });
  it('gives up on concave shapes and on moving in too far', () => {
    const notch: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [5, 4],
      [0, 10],
    ];
    expect(insetConvex(notch, 1)).toBeNull();
    expect(insetConvex(square(0, 0, 10), 5)).toBeNull();
    expect(insetConvex(square(0, 0, 10), 4.9)).not.toBeNull();
  });
});

describe('tile', () => {
  it('rounds stickers with room for it, squares off smaller ones, shrinks the rest', () => {
    const big = tile(square(0, 0, 10), 1, 2);
    close(big.points, square(2.5, 2.5, 5));
    expect(big.stroke).toBe(4);
    const small = tile(square(0, 0, 3), 1, 2);
    close(small.points, square(0.5, 0.5, 2));
    expect(small.stroke).toBe(0);
    const notch = tile(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [5, 4],
        [0, 10],
      ],
      1,
      2,
    );
    expect(notch.stroke).toBe(0);
    expect(Math.abs(signedArea(notch.points))).toBeLessThan(Math.abs(signedArea(square(0, 0, 10))));
  });
});

describe('convexHull / touchingGroups', () => {
  it('hulls a face of stickers', () => {
    const hull = convexHull([...square(0, 0), ...square(1, 0), ...square(0, 1), ...square(1, 1)]);
    expect(Math.abs(signedArea(hull))).toBeCloseTo(4);
    expect(hull).toHaveLength(4);
  });
  it('groups stickers that touch into faces, despite float noise', () => {
    const face = [square(0, 0), square(1, 0), square(0.0000000001, 1), square(1, 1)];
    const other = [square(2.2, 0), square(3.2, 0)];
    const groups = touchingGroups([...face, ...other], 0.02).map((g) => [...g].sort((a, b) => a - b));
    expect(groups).toEqual([
      [0, 1, 2, 3],
      [4, 5],
    ]);
  });
});

describe('polygonDistance / closeUp', () => {
  it('measures the gap between two polygons, side to side or corner to corner', () => {
    expect(polygonDistance(square(0, 0), square(1.5, 0))).toBeCloseTo(0.5);
    expect(polygonDistance(square(0, 0), square(2, 2))).toBeCloseTo(Math.SQRT2);
  });

  it("pulls a cube net's faces together until the closest are `gap` apart, keeping the layout", () => {
    // cubing.js's 3x3 cross: faces 3 wide, 0.2 apart
    const at = [
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [1, 2],
    ];
    const faces = at.map(([c, r]) => square(c * 3.2, r * 3.2, 3));
    const moves = closeUp(faces, 0.05);
    const moved = faces.map((f, i) => f.map(([x, y]): Point => [x + moves[i][0], y + moves[i][1]]));
    const gaps = moved.flatMap((a, i) => moved.slice(i + 1).map((b) => polygonDistance(a, b)));
    expect(Math.min(...gaps)).toBeCloseTo(0.05);
    // every face moves as a whole and neighbours stay neighbours: one step is now 3.05
    moved.forEach((f, i) => {
      expect(f[0][0]).toBeCloseTo(moved[2][0][0] + (at[i][0] - 1) * 3.05);
      expect(f[0][1]).toBeCloseTo(moved[2][0][1] + (at[i][1] - 1) * 3.05);
    });
  });

  it('leaves faces that are already close (or a single face) alone', () => {
    const still = (moves: Point[]) => moves.flat().every((v) => v === 0);
    expect(still(closeUp([square(0, 0, 3), square(3.02, 0, 3)], 0.05))).toBe(true);
    expect(still(closeUp([square(0, 0, 3)], 0.05))).toBe(true);
  });
});

describe('stickerSources (cubing.js puzzles)', () => {
  const ids = (svg: string) => [...svg.matchAll(/id="([A-Z0-9]+-l\d+-o\d+)"[^>]*style="fill: ?([^;"]+)/g)];

  it.each(['2x2x2', '3x3x3', '4x4x4', '7x7x7', 'megaminx', 'pyraminx', 'skewb', 'square1'])('%s: solved shows the solved colours, a scramble moves them around', async (id) => {
    const kpuzzle = await puzzles[id].kpuzzle();
    const { orbits } = kpuzzle.definition;
    const colours = new Map(ids(await puzzles[id].svg()).map(([, sid, fill]) => [sid, fill]));
    // big cubes' same-coloured centres are interchangeable, so solved is "every colour in place"
    const solved = stickerSources(orbits, kpuzzle.defaultPattern().patternData);
    for (const sid of colours.keys()) expect(colours.get(solved.get(sid)!), sid).toBe(colours.get(sid));

    const alg = { '2x2x2': "R U F'", megaminx: 'R++ D-- U', pyraminx: "R U L' b", skewb: "R U L' B", square1: '(1,0) / (3,3) /' }[id] ?? "R U F' Rw";
    const scrambled = stickerSources(orbits, kpuzzle.defaultPattern().applyAlg(alg).patternData);
    expect([...colours.keys()].some((sid) => colours.get(scrambled.get(sid)!) !== colours.get(sid))).toBe(true);
    // the same stickers, moved around: as many of each colour as before
    const count = (pick: (sid: string) => string | undefined) => [...colours.keys()].map(pick).sort().join();
    expect(count((sid) => colours.get(scrambled.get(sid)!))).toBe(count((sid) => colours.get(sid)));
  });

  it("undoing a scramble's moves brings every sticker back", async () => {
    const kpuzzle = await puzzles['3x3x3'].kpuzzle();
    const back = stickerSources(kpuzzle.definition.orbits, kpuzzle.defaultPattern().applyAlg("R U F' F U' R'").patternData);
    for (const [at, from] of back) expect(from).toBe(at);
  });

  it('R on a 3x3 lifts the front right column onto the top', async () => {
    const kpuzzle = await puzzles['3x3x3'].kpuzzle();
    const colours = new Map(ids(await puzzles['3x3x3'].svg()).map(([, sid, fill]) => [sid, fill]));
    const after = stickerSources(kpuzzle.definition.orbits, kpuzzle.defaultPattern().applyAlg('R').patternData);
    // the white (top) stickers on the right turn: UFR corner, UR edge, UBR corner
    const top = [...colours].filter(([sid, c]) => c === 'white' && after.get(sid) !== sid).map(([sid]) => colours.get(after.get(sid)!));
    expect(top).toEqual(['limegreen', 'limegreen', 'limegreen']);
  });
});

describe('stickerColour', () => {
  it('has a cubetype colour for every colour on the sticker nets', async () => {
    for (const id of ['2x2x2', '3x3x3', '4x4x4', '5x5x5', '6x6x6', '7x7x7', 'megaminx', 'pyraminx', 'skewb', 'square1']) {
      const svg = await puzzles[id].svg();
      for (const [, , fill] of svg.matchAll(/id="([A-Z0-9]+-l\d+-o\d+)"[^>]*style="fill: ?([^;"]+)/g)) {
        expect(stickerColour(fill), `${id} ${fill}`).not.toBe(fill);
      }
    }
  });
  it('is case- and space-insensitive and leaves unknown colours alone', () => {
    expect(stickerColour(' #FFFFFF ')).toBe(stickerColour('white'));
    expect(stickerColour('#123456')).toBe('#123456');
  });
});
