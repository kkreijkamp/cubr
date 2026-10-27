// The polyhedral virtual puzzles: NxN cubes, pyraminx, skewb and megaminx. Each is a PolyPuzzle
// with the WCA notation (as cubing.js reads it, so a scramble here matches the scramble preview)
// and csTimer's virtual-cube keyboard layout.
import { unit, type Vec } from './geometry';
import { PolyPuzzle, type Axis, type Move } from './polyPuzzle';

/** what a key does on a puzzle: a move, a change of how deep the outer moves go (big cubes), or nothing */
export type KeyResult = { move: Move } | { depth: true } | null;

export interface PolyTwisty {
  kind: 'poly';
  id: string;
  /** the sticker colour scheme (lib/scrambleNet SCHEMES) */
  scheme: 'cube' | 'skewb' | 'pyraminx' | 'megaminx';
  puzzle: PolyPuzzle;
  /** a scramble or alg; null when a move isn't understood */
  parse(alg: string): Move[] | null;
  /** turns the whole puzzle (allowed during inspection without starting the timer) */
  isRotation(m: Move): boolean;
  /** a key (KeyboardEvent.code) pressed while solving */
  key(code: string): KeyResult;
  /** forget the layer depth set by the depth keys */
  resetDepth(): void;
  /** the depth markers for big cubes: [left, right] outer-move depth */
  depth(): [number, number];
  /** csTimer's touch gestures: a swipe from one cell of a 3x3 grid over the puzzle to another ("63": 6 to 3) */
  touch(): Record<string, Move>;
  name(m: Move): string;
  /** camera: turn about the vertical axis, then tilt, both in radians; size of the puzzle in view */
  view: { yaw: number; pitch: number; radius: number };
}

const amountOf = (digits: string, prime: string) => (digits === '' ? 1 : Number(digits)) * (prime ? -1 : 1);

/** csTimer's "gesture:move" lists; moves the puzzle doesn't have are left out, as csTimer does */
function gestures(list: string, parse: (t: string) => Move | null): Record<string, Move> {
  const out: Record<string, Move> = {};
  for (const item of list.split(' ')) {
    const [g, move] = item.split(':');
    const m = parse(move);
    if (m) out[g] = m;
  }
  return out;
}
const tokens = (alg: string) => alg.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------- NxN cubes
const CUBE_FACES = ['U', 'R', 'F', 'D', 'L', 'B'] as const;
const CUBE_NORMALS: Vec[] = [
  [0, 1, 0],
  [1, 0, 0],
  [0, 0, 1],
  [0, -1, 0],
  [-1, 0, 0],
  [0, 0, -1],
];
// scheme face of each: top, right, front, bottom, left, back (lib/scrambleNet CUBE_FACES order: U F R B L D)
const CUBE_COLORS = [0, 2, 1, 5, 4, 3];

const cubeCache = new Map<number, PolyPuzzle>();

export function cubePuzzle(n: number): PolyPuzzle {
  let p = cubeCache.get(n);
  if (!p) {
    const cuts: number[] = [];
    for (let k = 1; k < n; k++) cuts.push(n - 2 * k);
    p = new PolyPuzzle({
      faces: CUBE_NORMALS.map((v, i) => ({ plane: { n: v, d: n }, color: CUBE_COLORS[i] })),
      axes: CUBE_FACES.map((name, i) => ({ name, n: CUBE_NORMALS[i], order: 4, cuts })),
      gap: 0.09 + 0.01 * Math.min(n, 7),
    });
    cubeCache.set(n, p);
  }
  return p;
}

export function cubeTwisty(n: number): PolyTwisty {
  const puzzle = cubePuzzle(n);
  const axis = (f: string) => CUBE_FACES.indexOf(f.toUpperCase() as (typeof CUBE_FACES)[number]);
  const mv = (from: number, to: number, face: string, amount: number): Move => ({ axis: axis(face), from: Math.max(1, from), to: Math.min(n, Math.max(from, to)), amount });
  let left = 1;
  let right = 1;

  const parseToken = (t: string): Move | null => {
    let m = /^([xyz])(\d*)('?)$/.exec(t);
    if (m) return mv(1, n, 'RUF'['xyz'.indexOf(m[1])], amountOf(m[2], m[3]));
    // M, E and S: the middle layer (as cubing.js reads them; even cubes have none)
    m = /^([MES])(\d*)('?)$/.exec(t);
    if (m) return n % 2 === 0 ? null : mv((n + 1) / 2, (n + 1) / 2, 'LDF'['MES'.indexOf(m[1])], amountOf(m[2], m[3]));
    // 2-3Rw / 2-3R: layers 2 to 3; 3Rw: the outer 3; 3R: the third layer alone; Rw / r: the outer 2
    m = /^(?:(\d+)-(\d+))?(\d+)?([URFDLB])(w?)(\d*)('?)$/.exec(t);
    if (m) {
      const amount = amountOf(m[6], m[7]);
      if (m[1]) return mv(Number(m[1]), Number(m[2]), m[4], amount);
      const k = m[3] ? Number(m[3]) : 0;
      if (m[5]) return mv(1, k || 2, m[4], amount);
      return k ? mv(k, k, m[4], amount) : mv(1, 1, m[4], amount);
    }
    m = /^(\d+)?([urfdlb])(\d*)('?)$/.exec(t);
    if (m) return mv(1, m[1] ? Number(m[1]) : 2, m[2], amountOf(m[3], m[4]));
    return null;
  };

  // csTimer's layout (twisty/twistynnn.js), by key position
  const keys = (): Record<string, [number, number, string, number]> => ({
    KeyI: [1, right, 'R', 1],
    KeyK: [1, right, 'R', -1],
    KeyW: [1, 1, 'B', 1],
    KeyO: [1, 1, 'B', -1],
    KeyS: [1, 1, 'D', 1],
    KeyL: [1, 1, 'D', -1],
    KeyD: [1, left, 'L', 1],
    KeyE: [1, left, 'L', -1],
    KeyJ: [1, 1, 'U', 1],
    KeyF: [1, 1, 'U', -1],
    KeyH: [1, 1, 'F', 1],
    KeyG: [1, 1, 'F', -1],
    Semicolon: [1, n, 'U', 1],
    KeyA: [1, n, 'U', -1],
    KeyU: [1, right + 1, 'R', 1],
    KeyR: [1, left + 1, 'L', -1],
    KeyM: [1, right + 1, 'R', -1],
    KeyV: [1, left + 1, 'L', 1],
    KeyT: [1, n, 'L', -1],
    KeyY: [1, n, 'R', 1],
    KeyN: [1, n, 'R', -1],
    KeyB: [1, n, 'L', 1],
    Period: [right + 1, right + 1, 'R', 1],
    KeyX: [left + 1, left + 1, 'L', -1],
    Digit5: [left + 1, left + 1, 'L', 1],
    Digit6: [right + 1, right + 1, 'R', -1],
    Digit1: [2, n - 1, 'F', -1],
    Digit2: [2, n - 1, 'U', -1],
    Digit9: [2, n - 1, 'U', 1],
    Digit0: [2, n - 1, 'F', 1],
    KeyP: [1, n, 'F', 1],
    KeyQ: [1, n, 'F', -1],
    KeyZ: [1, 2, 'D', 1],
    KeyC: [1, 2, 'U', -1],
    Comma: [1, 2, 'U', 1],
    Slash: [1, 2, 'D', -1],
  });

  // csTimer: twisty/twistynnn.js getTouchMoves
  const touchMap = (): Record<string, [number, number, string, number]> => ({
    61: [1, 2, 'U', 2], 62: [1, 1, 'B', 1], 63: [1, right, 'R', 1], 64: [1, n, 'U', 2], 65: [1, n, 'U', 1], 67: [1, 1, 'F', 2], 68: [right + 1, right + 1, 'R', -1], 69: [1, 1, 'F', 1],
    41: [1, left, 'L', -1], 42: [1, 1, 'B', -1], 43: [1, 2, 'U', -2], 45: [1, n, 'U', -1], 46: [1, n, 'U', -2], 47: [1, 1, 'F', -1], 48: [left + 1, left + 1, 'L', 1], 49: [1, 1, 'F', -2],
    31: [1, 1, 'U', 2], 32: [1, 1, 'U', 1], 34: [1, 2, 'U', 2], 35: [1, 2, 'U', 1], 36: [1, right, 'R', -1], 37: [1, n, 'F', -1], 38: [right + 1, right + 1, 'R', -2], 39: [1, right, 'R', -2],
    12: [1, 1, 'U', -1], 13: [1, 1, 'U', -2], 14: [1, left, 'L', 1], 15: [1, 2, 'U', -1], 16: [1, 2, 'U', -2], 17: [1, left, 'L', 2], 18: [left + 1, left + 1, 'L', 2], 19: [1, n, 'F', 1],
    91: [1, n, 'F', -1], 92: [1, 1, 'B', 2], 93: [1, right, 'R', 2], 94: [1, 1, 'F', -2], 95: [1, right + 1, 'R', 1], 96: [1, 1, 'F', -1], 97: [1, 1, 'D', -2], 98: [1, 1, 'D', -1],
    73: [1, n, 'F', 1], 72: [1, 1, 'B', -2], 71: [1, left, 'L', -2], 76: [1, 1, 'F', 2], 75: [1, left + 1, 'L', -1], 74: [1, 1, 'F', 1], 79: [1, 1, 'D', 2], 78: [1, 1, 'D', 1],
    21: [1, 1, 'U', 1], 23: [1, 1, 'U', -1], 24: [1, 1, 'B', 1], 25: [1, n, 'R', -1], 26: [1, 1, 'B', -1], 27: [1, 1, 'B', 2], 28: [1, n, 'R', -2], 29: [1, 1, 'B', -2],
    51: [1, 2, 'U', 1], 52: [1, n, 'R', 1], 53: [1, 2, 'U', -1], 54: [1, n, 'U', 1], 56: [1, n, 'U', -1], 57: [1, left + 1, 'L', 1], 58: [1, n, 'R', -1], 59: [1, right + 1, 'R', -1],
    81: [left + 1, left + 1, 'L', -2], 82: [1, n, 'R', 2], 83: [right + 1, right + 1, 'R', 2], 84: [left + 1, left + 1, 'L', -1], 85: [1, n, 'R', 1], 86: [right + 1, right + 1, 'R', 1], 87: [1, 1, 'D', -1], 89: [1, 1, 'D', 1],
  });

  return {
    kind: 'poly',
    id: `cube${n}`,
    scheme: 'cube',
    puzzle,
    parse(alg) {
      const out: Move[] = [];
      for (const t of tokens(alg)) {
        const m = parseToken(t);
        if (!m) return null;
        out.push(m);
      }
      return out;
    },
    isRotation: (m) => m.from <= 1 && m.to >= n,
    key(code) {
      if (code === 'Digit3' || code === 'Digit4' || code === 'Digit7' || code === 'Digit8') {
        if (code === 'Digit3') left = Math.max(1, left - 1);
        else if (code === 'Digit4') left = Math.min(left + 1, n - 1);
        else if (code === 'Digit7') right = Math.min(right + 1, n - 1);
        else right = Math.max(1, right - 1);
        return { depth: true };
      }
      const k = keys()[code];
      if (!k) return null;
      // inner slices (M, S, E) need a middle layer
      if (k[0] > n || (k[0] >= 2 && k[1] < k[0])) return null;
      return { move: mv(k[0], k[1], k[2], k[3]) };
    },
    resetDepth() {
      left = right = 1;
    },
    depth: () => [left, right],
    touch() {
      const out: Record<string, Move> = {};
      for (const [g, k] of Object.entries(touchMap())) {
        if (k[0] > n || (k[0] >= 2 && n < 3)) continue;
        out[g] = mv(k[0], k[1], k[2], k[3]);
      }
      return out;
    },
    name(m) {
      const face = CUBE_FACES[m.axis];
      const amt = Math.abs(m.amount) === 1 ? '' : String(Math.abs(m.amount));
      const prime = m.amount < 0 ? "'" : '';
      if (m.from <= 1 && m.to >= n) {
        const rot = { R: 'x', U: 'y', F: 'z', L: 'x', D: 'y', B: 'z' }[face]!;
        const flip = face === 'L' || face === 'D' || face === 'B';
        return rot + amt + ((m.amount < 0) !== flip ? "'" : '');
      }
      if (m.from === 1) return (m.to > 2 ? m.to : '') + face + (m.to >= 2 ? 'w' : '') + amt + prime;
      return (m.from === m.to ? `${m.from}` : `${m.from}-${m.to}`) + face + (m.from === m.to ? '' : 'w') + amt + prime;
    },
    view: { yaw: 0, pitch: Math.PI / 4, radius: Math.sqrt(3) * n },
  };
}

// ---------------------------------------------------------------- pyraminx
// csTimer's tetrahedron (lib/poly3dlib.js): faces at distance 1, corners at 3
const S6 = Math.sqrt(6) / 3;
const S2 = Math.sqrt(2) / 3;
const PYRA_NORMALS: Vec[] = [
  [0, 1 / 3, Math.sqrt(8) / 3], // F
  [-S6, 1 / 3, -S2], // L (back left)
  [S6, 1 / 3, -S2], // R (back right)
  [0, -1, 0], // D
];
// a corner points away from the face opposite it
const PYRA_CORNERS: Record<string, Vec> = {
  U: [0, 1, 0],
  L: [-PYRA_NORMALS[2][0], -PYRA_NORMALS[2][1], -PYRA_NORMALS[2][2]],
  R: [-PYRA_NORMALS[1][0], -PYRA_NORMALS[1][1], -PYRA_NORMALS[1][2]],
  B: [-PYRA_NORMALS[0][0], -PYRA_NORMALS[0][1], -PYRA_NORMALS[0][2]],
};

let pyraCache: PolyPuzzle | null = null;

export function pyraminxTwisty(): PolyTwisty {
  pyraCache ??= new PolyPuzzle({
    // scheme pyraminx: front, left, right, bottom
    faces: PYRA_NORMALS.map((v, i) => ({ plane: { n: unit(v), d: 1 }, color: i })),
    axes: Object.entries(PYRA_CORNERS).map(([name, v]) => ({ name, n: unit(v), order: 3, cuts: [5 / 3, 1 / 3] })),
    gap: 0.11,
  });
  const puzzle = pyraCache;
  const corner = (c: string) => 'ULRB'.indexOf(c.toUpperCase());
  // layer 1 = tip, 1-2 = tip and middle (the WCA capital letters), 1-3 = the whole puzzle
  const mv = (c: string, to: number, amount: number): Move => ({ axis: corner(c), from: 1, to, amount });
  const parseToken = (t: string): Move | null => {
    let m = /^\[([urlb])\](\d*)('?)$/.exec(t) ?? /^\[([urlb])(\d*)('?)\]$/.exec(t);
    if (m) return mv(m[1], 3, amountOf(m[2], m[3]));
    m = /^([URLB])(w?)(\d*)('?)$/.exec(t);
    if (m) return mv(m[1], m[2] ? 3 : 2, amountOf(m[3], m[4]));
    m = /^([urlb])(\d*)('?)$/.exec(t);
    if (m) return mv(m[1], 1, amountOf(m[2], m[3]));
    return null;
  };
  // csTimer: twisty/twistypoly.js "pyr"
  const KEYS: Record<string, string> = {
    KeyI: 'R',
    KeyK: "R'",
    KeyW: 'B',
    KeyO: "B'",
    KeyS: 'b',
    KeyL: "b'",
    KeyD: 'L',
    KeyE: "L'",
    KeyJ: 'U',
    KeyF: "U'",
    KeyH: 'u',
    KeyG: "u'",
    Semicolon: '[u]',
    KeyA: "[u']",
    KeyU: 'r',
    KeyM: "r'",
    KeyR: "l'",
    KeyV: 'l',
    KeyT: "[l']",
    KeyY: '[r]',
    KeyN: "[r']",
    KeyB: '[l]',
    KeyP: "[b']",
    KeyQ: '[b]',
  };
  const TOUCH = gestures(
    "61:u2 62:B 63:R 64:[u2] 65:[u] 67:F2 69:F 41:L' 42:B' 43:u2' 45:[u'] 46:[u2'] 47:F' 49:F2' 31:U2 32:U 34:u2 35:u 36:R' 37:[f'] 39:R2' 12:U' 13:U2' 14:L 15:u' 16:u2' 17:L2 19:[f] 91:[f'] 92:B2 93:R2 94:F2' 95:r 96:F' 97:D2' 98:D' 73:[f] 72:B2' 71:L2' 76:F2 75:l' 74:F 79:D2 78:D 21:U 23:U' 24:B 25:[r'] 26:B' 27:B2 28:[r2'] 29:B2' 51:u 52:[r] 53:u' 54:[u] 56:[u'] 57:l 58:[r'] 59:r' 82:[r2] 85:[r] 87:D' 89:D",
    parseToken,
  );
  return {
    kind: 'poly',
    id: 'pyraminx',
    scheme: 'pyraminx',
    puzzle,
    parse(alg) {
      const out: Move[] = [];
      for (const t of tokens(alg)) {
        const m = parseToken(t);
        if (!m) return null;
        out.push(m);
      }
      return out;
    },
    isRotation: (m) => m.to >= 3,
    key(code) {
      const s = KEYS[code];
      return s ? { move: parseToken(s)! } : null;
    },
    resetDepth() {},
    depth: () => [1, 1],
    touch: () => TOUCH,
    name(m) {
      const c = 'ULRB'[m.axis];
      const p = m.amount < 0 ? "'" : '';
      return m.to >= 3 ? `[${c.toLowerCase()}${p}]` : m.to === 2 ? c + p : c.toLowerCase() + p;
    },
    view: { yaw: 0, pitch: 0.42, radius: 3 },
  };
}

// ---------------------------------------------------------------- skewb
const SK_CORNERS: Record<string, Vec> = {
  URF: [1, 1, 1],
  UFL: [-1, 1, 1],
  ULB: [-1, 1, -1],
  UBR: [1, 1, -1],
  DFR: [1, -1, 1],
  DLF: [-1, -1, 1],
  DBL: [-1, -1, -1],
  DRB: [1, -1, -1],
};

let skewbCache: PolyPuzzle | null = null;

export function skewbTwisty(): PolyTwisty {
  if (!skewbCache) {
    const axes: Axis[] = Object.entries(SK_CORNERS).map(([name, v]) => ({ name, n: unit(v), order: 3, cuts: [0] }));
    // x, y, z: the whole puzzle about the R, U and F faces
    axes.push({ name: 'x', n: [1, 0, 0], order: 4, cuts: [] }, { name: 'y', n: [0, 1, 0], order: 4, cuts: [] }, { name: 'z', n: [0, 0, 1], order: 4, cuts: [] });
    skewbCache = new PolyPuzzle({ faces: CUBE_NORMALS.map((v, i) => ({ plane: { n: v, d: 1 }, color: CUBE_COLORS[i] })), axes, gap: 0.075 });
  }
  const puzzle = skewbCache;
  const ax = (name: string) => puzzle.axisIndex(name);
  // WCA: the four corners turned in a scramble (the up-back-left one and three on the bottom)
  const WCA: Record<string, string> = { U: 'ULB', R: 'DRB', L: 'DLF', B: 'DBL' };
  const parseToken = (t: string): Move | null => {
    let m = /^([xyz])(\d*)('?)$/.exec(t);
    if (m) return { axis: ax(m[1]), from: 1, to: 1, amount: amountOf(m[2], m[3]) };
    m = /^([URLB])(\d*)('?)$/.exec(t);
    if (m) return { axis: ax(WCA[m[1]]), from: 1, to: 1, amount: amountOf(m[2], m[3]) };
    return null;
  };
  const corner = (name: string, amount: number): KeyResult => ({ move: { axis: ax(name), from: 1, to: 1, amount } });
  const rot = (name: string, amount: number): KeyResult => ({ move: { axis: ax(name), from: 1, to: 1, amount } });
  // csTimer: twisty/twistyskb.js, the corners as they sit on its 45-degree view
  const KEYS: Record<string, () => KeyResult> = {
    KeyI: () => corner('UBR', 1),
    KeyK: () => corner('UBR', -1),
    KeyD: () => corner('UFL', 1),
    KeyE: () => corner('UFL', -1),
    KeyJ: () => corner('ULB', 1),
    KeyF: () => corner('ULB', -1),
    KeyW: () => corner('DBL', 1),
    KeyO: () => corner('DBL', -1),
    KeyH: () => corner('URF', 1),
    KeyG: () => corner('URF', -1),
    KeyS: () => corner('DFR', 1),
    KeyL: () => corner('DFR', -1),
    Semicolon: () => rot('y', 1),
    KeyA: () => rot('y', -1),
    KeyT: () => rot('x', 1),
    KeyY: () => rot('x', 1),
    KeyN: () => rot('x', -1),
    KeyB: () => rot('x', -1),
    KeyP: () => rot('z', 1),
    KeyQ: () => rot('z', -1),
  };
  return {
    kind: 'poly',
    id: 'skewb',
    scheme: 'skewb',
    puzzle,
    parse(alg) {
      const out: Move[] = [];
      for (const t of tokens(alg)) {
        const m = parseToken(t);
        if (!m) return null;
        out.push(m);
      }
      return out;
    },
    isRotation: (m) => puzzle.axes[m.axis].cuts.length === 0,
    key: (code) => KEYS[code]?.() ?? null,
    resetDepth() {},
    depth: () => [1, 1],
    touch: () => ({}),
    name(m) {
      const a = puzzle.axes[m.axis].name;
      const wca = Object.entries(WCA).find(([, c]) => c === a)?.[0];
      return (wca ?? (a.length === 1 ? a : `[${a}]`)) + (Math.abs(m.amount) > 1 ? Math.abs(m.amount) : '') + (m.amount < 0 ? "'" : '');
    },
    // turned so the front-right edge faces you, like csTimer's skewb
    view: { yaw: -Math.PI / 4, pitch: 0.55, radius: Math.sqrt(3) },
  };
}

// ---------------------------------------------------------------- megaminx
// faces as cubing.js names them: U, then F R BR BL L around it, their opposites below
const MEGA_RING = ['F', 'R', 'BR', 'BL', 'L'];
const MEGA_OPPOSITE: Record<string, string> = { U: 'D', F: 'B', R: 'DL', BR: 'FL', BL: 'FR', L: 'DR' };
// scheme megaminx colours (cubing.js's): white, dark green, red, purple, yellow, dark blue, grey, beige, light blue, orange, light green, pink
const MEGA_COLORS: Record<string, number> = { U: 0, F: 1, R: 2, L: 3, BL: 4, BR: 5, D: 6, FR: 7, FL: 8, DL: 9, B: 10, DR: 11 };
const MEGA_CUT = 0.72;

let megaCache: PolyPuzzle | null = null;

export function megaminxTwisty(): PolyTwisty {
  if (!megaCache) {
    const normals: Record<string, Vec> = { U: [0, 1, 0] };
    MEGA_RING.forEach((f, i) => {
      normals[f] = unit([2 * Math.sin(0.4 * i * Math.PI), 1, 2 * Math.cos(0.4 * i * Math.PI)]);
    });
    for (const [a, b] of Object.entries(MEGA_OPPOSITE)) normals[b] = [-normals[a][0], -normals[a][1], -normals[a][2]];
    const names = Object.keys(MEGA_COLORS);
    megaCache = new PolyPuzzle({
      faces: names.map((f) => ({ plane: { n: normals[f], d: 1 }, color: MEGA_COLORS[f] })),
      axes: names.map((f) => ({ name: f, n: normals[f], order: 5, cuts: [MEGA_CUT, -MEGA_CUT] })),
      gap: 0.035,
    });
  }
  const puzzle = megaCache;
  const ax = (name: string) => puzzle.axisIndex(name);
  const parseToken = (t: string): Move | null => {
    // Pochmann (WCA scrambles): R++ turns everything but the L face layer, D++ everything but U
    let m = /^([RD])(\+\+|--)$/.exec(t);
    if (m) return { axis: ax(m[1] === 'R' ? 'L' : 'U'), from: 2, to: 3, amount: m[2] === '++' ? -2 : 2 };
    m = /^\[([urlf])\](\d*)('?)$/.exec(t) ?? /^\[([urlf])(\d*)('?)\]$/.exec(t);
    if (m) return { axis: ax(m[1].toUpperCase()), from: 1, to: 3, amount: amountOf(m[2], m[3]) };
    m = /^(U|F|R|L|BR|BL|FR|FL|DR|DL|B|D)(\d*)('?)$/.exec(t);
    if (m) return { axis: ax(m[1]), from: 1, to: 1, amount: amountOf(m[2], m[3]) };
    m = /^y(\d*)('?)$/.exec(t);
    if (m) return { axis: ax('U'), from: 1, to: 3, amount: amountOf(m[1], m[2]) };
    return null;
  };
  // csTimer's megaminx keys (twisty/twistypoly.js): its "DR" and "DL" are the two lower faces at the front
  const KEYS: Record<string, string> = {
    KeyI: 'R',
    KeyK: "R'",
    KeyW: 'BR',
    KeyO: "BR'",
    KeyS: 'FR',
    KeyL: "FR'",
    KeyC: 'FL',
    Comma: "FL'",
    KeyD: 'L',
    KeyE: "L'",
    KeyJ: 'U',
    KeyF: "U'",
    KeyH: 'F',
    KeyG: "F'",
    Semicolon: '[u]',
    KeyA: "[u']",
    KeyT: "[l']",
    KeyY: '[r]',
    KeyN: "[r']",
    KeyB: '[l]',
    KeyP: '[f]',
    KeyQ: "[f']",
  };
  const TOUCH = gestures(
    "62:BR 63:R 64:[u2] 65:[u] 67:F2 69:F 41:L' 42:BR' 45:[u'] 46:[u2'] 47:F' 49:F2' 31:U2 32:U 36:R' 37:[f'] 39:R2' 12:U' 13:U2' 14:L 17:L2 19:[f] 91:[f'] 92:BR2 93:R2 94:F2' 96:F' 97:FR2' 98:FR' 73:[f] 72:BR2' 71:L2' 76:F2 74:F 79:FR2 78:FR 21:U 23:U' 24:BR 25:[r'] 26:BR' 27:BR2 28:[r2'] 29:BR2' 52:[r] 54:[u] 56:[u'] 58:[r'] 82:[r2] 85:[r] 87:FR' 89:FR",
    parseToken,
  );
  return {
    kind: 'poly',
    id: 'megaminx',
    scheme: 'megaminx',
    puzzle,
    parse(alg) {
      const out: Move[] = [];
      for (const t of tokens(alg)) {
        const m = parseToken(t);
        if (!m) return null;
        out.push(m);
      }
      return out;
    },
    isRotation: (m) => m.from <= 1 && m.to >= 3,
    key(code) {
      const s = KEYS[code];
      return s ? { move: parseToken(s)! } : null;
    },
    resetDepth() {},
    depth: () => [1, 1],
    touch: () => TOUCH,
    name(m) {
      const a = puzzle.axes[m.axis].name;
      const amt = Math.abs(m.amount) > 1 ? String(Math.abs(m.amount)) : '';
      const p = m.amount < 0 ? "'" : '';
      if (m.from === 2 && m.to === 3 && (a === 'L' || a === 'U') && Math.abs(m.amount) === 2) return (a === 'L' ? 'R' : 'D') + (m.amount < 0 ? '++' : '--');
      if (m.to >= 3) return `[${a.toLowerCase()}${amt}${p}]`;
      return a + amt + p;
    },
    view: { yaw: 0, pitch: 0.5, radius: 1.45 },
  };
}
