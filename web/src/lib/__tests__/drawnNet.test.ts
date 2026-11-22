import { describe, expect, it } from 'vitest';
import { buildDrawnNet, drawnColour, drawnKind, hexColour, outline, parseDrawing, redrawable, relayColumns } from '../drawnNet';
import { schemeFor, SCHEMES, signedArea, stickerColour, type Point } from '../scrambleNet';
import dino from './fixtures/cstimer/dino.svg?raw';
import eight from './fixtures/cstimer/8p.svg?raw';
import mrbl from './fixtures/cstimer/mrbl.svg?raw';
import sq2 from './fixtures/cstimer/sq2.svg?raw';
import dmd from './fixtures/cstimer/dmd.svg?raw';

// csTimer's drawings of real scrambles, from the scramble service (cstimer_module 0.1.5)
const DRAWINGS: Record<string, string> = { dino, '8p': eight, mrbl, sq2, dmd };
const fixture = (event: string) => DRAWINGS[event];
const FIXTURES = Object.keys(DRAWINGS);

const square = (x: number, y: number, s = 1): Point[] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];
/** a path's corners, loop by loop ("M1,2L3,4Z") */
const loopsOf = (d: string): Point[][] => d.split('Z').filter(Boolean).map((l) => l.slice(1).split('L').map((p) => p.split(',').map(Number) as Point));

describe('parseDrawing', () => {
  it("reads the filled shapes and the words, with their groups' transforms", () => {
    const d = parseDrawing(
      '<svg width="100" height="50" xmlns="http://www.w3.org/2000/svg"><g transform="translate(10,0) scale(2)">' +
        '<polygon points="0,0 10,0 10,10" style="fill:#F80;stroke:#000;" />' +
        '<text x="5" y="5" style="paint-order:stroke;font:30px Arial;fill:#000;" text-anchor="middle">1&amp;2</text></g>' +
        '<rect x="1" y="2" width="3" height="4" fill="#00dd00"/><circle cx="1" cy="1" r="1" style="fill:#f00"/>' +
        '<path d="M0 0 C1 1 2 2 3 3Z" style="fill:#f00"/><polygon points="0,0 1,1 1,0" style="fill:none"/></svg>',
    );
    expect(d.shapes).toEqual([
      {
        points: [
          [10, 0],
          [30, 0],
          [30, 20],
        ],
        fill: '#ff8800',
      },
      {
        points: [
          [1, 2],
          [4, 2],
          [4, 6],
          [1, 6],
        ],
        fill: '#00dd00',
      },
    ]);
    expect(d.texts).toEqual([{ x: 20, y: 10, size: 60, text: '1&2' }]);
  });

  it("reads every polygon of csTimer's drawings", () => {
    for (const event of FIXTURES) {
      const svg = fixture(event);
      const d = parseDrawing(svg);
      expect(d.shapes.length, event).toBe(svg.match(/<polygon/g)!.length);
      for (const s of d.shapes) expect(s.fill, event).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(parseDrawing(fixture('8p')).texts.map((t) => t.text).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  });

  it('spells colours one way', () => {
    expect(hexColour(' #F80 ')).toBe('#ff8800');
    expect(hexColour('#AbCdEf')).toBe('#abcdef');
    expect(hexColour('red')).toBe('red');
  });
});

describe('outline', () => {
  it('joins the stickers of a face into its outline', () => {
    const loops = outline([square(0, 0), square(1, 0), square(0, 1), square(1, 1)], 0.01)!;
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
    expect(signedArea(loops[0])).toBeCloseTo(4);
  });

  it('follows a jagged face, splitting a side where a corner lies on it', () => {
    const l = outline([square(0, 0), square(1, 0), square(0, 1)], 0.01)!;
    expect(l).toHaveLength(1);
    expect(l[0]).toHaveLength(6);
    expect(signedArea(l[0])).toBeCloseTo(3);
    // a sticker two wide under two one wide: their corners meet its side halfway
    const wide: Point[] = [
      [0, 0],
      [2, 0],
      [2, 1],
      [0, 1],
    ];
    const t = outline([wide, square(0, 1), square(1, 1)], 0.01)!;
    expect(t).toHaveLength(1);
    expect(t[0]).toHaveLength(4);
    expect(signedArea(t[0])).toBeCloseTo(4);
    // either way round, and corners a hair apart are one corner
    const t2 = outline([[...wide].reverse(), square(0, 1.0004), square(1, 1)], 0.01)!;
    expect(t2).toHaveLength(1);
    expect(signedArea(t2[0])).toBeCloseTo(4, 2);
  });

  it('keeps stickers that only touch at a corner apart, and goes round a hole the other way', () => {
    const apart = outline([square(0, 0), square(1, 1)], 0.01)!;
    expect(apart.map((l) => Math.round(signedArea(l)))).toEqual([1, 1]);
    const ring = [0, 1, 2].flatMap((x) => [0, 1, 2].filter((y) => x !== 1 || y !== 1).map((y) => square(x, y)));
    const loops = outline(ring, 0.01)!;
    expect(loops.map((l) => Math.round(signedArea(l))).sort((a, b) => a - b)).toEqual([-1, 9]);
  });
});

describe('buildDrawnNet', () => {
  it("redraws a puzzle's faces as cubr's nets: a rounded plate behind each, rounded stickers, the faces closer", () => {
    const d = parseDrawing(fixture('dino'));
    const net = buildDrawnNet(d, 'net')!;
    expect(net.plates).toHaveLength(6);
    expect(net.stickers).toHaveLength(24);
    expect(net.texts).toEqual([]);
    for (const p of [...net.plates, ...net.stickers]) {
      expect(p.stroke).toBeGreaterThan(0);
      expect(loopsOf(p.d)).toHaveLength(1);
    }
    // csTimer's faces are 7 apart, cubr's a few
    const [, , w, h] = net.viewBox.split(' ').map(Number);
    expect(w).toBeLessThan(396);
    expect(h).toBeLessThan(296);
    expect(net.stickers.map((s) => s.fill)).toEqual(d.shapes.map((s) => s.fill));
  });

  it("follows a face's outline where its stickers don't make a convex shape (mirror blocks)", () => {
    const net = buildDrawnNet(parseDrawing(fixture('mrbl')), 'net')!;
    expect(net.stickers).toHaveLength(54);
    expect(net.plates.length).toBeGreaterThanOrEqual(6);
    for (const p of net.plates) expect(p.stroke).toBeGreaterThan(0);
    // at least one face is jagged: its plate has more than four corners
    expect(net.plates.some((p) => loopsOf(p.d).some((l) => l.length > 4))).toBe(true);
  });

  it("draws square-1's relatives flat, as cubr's square-1: no plates", () => {
    const net = buildDrawnNet(parseDrawing(fixture('sq2')), 'flat')!;
    expect(net.plates).toEqual([]);
    expect(net.stickers).toHaveLength(52);
  });

  it("draws a sliding puzzle as a board: one plate, the tiles grown to their squares, the space empty, the numbers kept", () => {
    const d = parseDrawing(fixture('8p'));
    const net = buildDrawnNet(d, 'board')!;
    expect(net.plates).toHaveLength(1);
    expect(net.stickers).toHaveLength(8);
    expect(net.stickers.some((s) => s.fill === '#ffffff')).toBe(false);
    expect(net.texts.map((t) => t.text).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    // csTimer's 45 px tiles 5 apart: the board is three 50 px squares a side
    const [, , w, h] = net.viewBox.split(' ').map(Number);
    expect(w).toBeCloseTo(150, 1);
    expect(h).toBeCloseTo(150, 1);
    for (const t of net.texts) expect(t.size).toBeCloseTo(0.46 * 50, 1);
  });

  it('draws nothing from a drawing with no shapes', () => {
    expect(buildDrawnNet({ shapes: [], texts: [] }, 'net')).toBeNull();
  });
});

describe('drawnColour', () => {
  it("draws each puzzle in its scheme's colours, your own where you picked them", () => {
    const cube = schemeFor('3x3x3')!;
    expect(drawnColour('#ffffff', '888')).toBe(stickerColour('white', cube));
    expect(drawnColour('#00dd00', 'mrbl', { cube: [null, '#123456'] })).toBe('#123456');
    expect(drawnColour('#00ff00', 'sq2')).toBe(stickerColour('limegreen', schemeFor('square1')));
    expect(drawnColour('#00ff00', 'sq2', { cube: [null, '#123456'] })).toBe(stickerColour('limegreen', schemeFor('square1')));
    expect(drawnColour('#dd0000', 'prc')).toBe(stickerColour('#ff0000', schemeFor('megaminx')));
    expect(drawnColour('#880088', 'dmd')).toBe(stickerColour('#8800dd', schemeFor('fto')));
    // the icosamate keeps csTimer's twenty colours, and a colour no scheme knows stays as it is
    expect(drawnColour('#553366', 'ctico')).toBe('#553366');
    expect(drawnColour('#123123', 'gear')).toBe('#123123');
    // a sliding puzzle's tiles: by the part of the solve they belong to, in cubr's colours
    expect(new Set(['#ff9999', '#99ff99', '#9999ff'].map((c) => drawnColour(c, '15p'))).size).toBe(3);
    expect(drawnColour('#ff9999', '8p')).toBe(drawnColour('#ff0000', '888'));
  });

  it("maps every colour in csTimer's drawings to one of cubr's", () => {
    for (const event of FIXTURES) {
      for (const s of parseDrawing(fixture(event)).shapes) {
        if (event === '8p' && s.fill === '#ffffff') continue; // the space
        const c = drawnColour(s.fill, event);
        expect(c, `${event} ${s.fill}`).not.toBe(s.fill);
        expect(SCHEMES.some((scheme) => scheme.faces.some((f) => f.colour === c)) || event === '8p', `${event} ${s.fill}`).toBe(true);
      }
    }
  });

  it("colours the scramble types cubing.js can't read in the puzzle's own scheme", () => {
    // csTimer's notation for a gigaminx, a megaminx (carrot) or a master pyraminx: its drawing instead
    expect(drawnColour('#8811ff', 'giga')).toBe(stickerColour('#8800dd', schemeFor('megaminx')));
    expect(drawnColour('#ffcc00', 'minx')).toBe(stickerColour('#f4f400', schemeFor('megaminx')));
    expect(drawnColour('#00ff00', 'mpyr')).toBe(stickerColour('limegreen', schemeFor('pyraminx')));
    expect(drawnColour('#00dd00', 'redi', { cube: [null, '#123456'] })).toBe('#123456');
  });

  it('redraws the sliding puzzles as boards, the square-1s flat, and leaves the clock as csTimer draws it', () => {
    expect(['15p', '8p', 'sq1', 'sq2', 'ssq1', 'bsq', 'mrbl', 'prc', '888'].map(drawnKind)).toEqual(['board', 'board', 'flat', 'flat', 'flat', 'flat', 'net', 'net', 'net']);
    expect(redrawable('clock')).toBe(false);
    expect(redrawable('15p')).toBe(true);
  });
});

describe('relayColumns', () => {
  it('puts as many to a row as makes the nets biggest', () => {
    // the timer's preview box at 1280 px: about 350 x 180
    expect(relayColumns(3, 350, 180, 16)).toBe(3);
    expect(relayColumns(4, 350, 180, 16)).toBe(2);
    expect(relayColumns(5, 350, 180, 16)).toBe(3);
    expect(relayColumns(6, 350, 180, 16)).toBe(3);
    expect(relayColumns(10, 350, 180, 16)).toBe(5);
    // narrow and tall: one above the other
    expect(relayColumns(3, 120, 400, 16)).toBe(1);
    expect(relayColumns(1, 350, 180, 16)).toBe(1);
    // in 3D a puzzle is about square: four in a row beat two rows of two
    expect(relayColumns(4, 350, 180, 16, 1)).toBe(4);
    expect(relayColumns(10, 350, 180, 16, 1)).toBe(5);
  });
});
