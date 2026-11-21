// Random-move scrambles: csTimer's move tables (src/js/scramble/megascramble.js and utilscramble.js,
// GPL-3.0 like cubr, by Chen Shuang) re-implemented here. Pure, so the scramble service makes them
// and the web app can make them itself when the service is unreachable. Random-state scrambles
// (the WCA events, the last-layer and other practice types) come from the scramble service.

type Rng = () => number;
const rn = (n: number, rng: Rng) => Math.floor(rng() * n) % n;
const pick = <T>(xs: readonly T[], rng: Rng): T => xs[rn(xs.length, rng)];

/** an axis: its layers, each a move or a set of alternatives for that layer */
type Turns = readonly (readonly (string | readonly string[])[])[];

const CUBE = ['', '2', "'"];
const MINX = ['', '2', "'", "2'"];

/**
 * csTimer's `mega`: `length` moves, never two turns of the same layer on one axis in a row, and
 * at most one turn of each layer before the axis changes.
 */
export function mega(turns: Turns, suffixes: readonly string[] = [''], length = 0, rng: Rng = Math.random): string {
  const out: string[] = [];
  let done = 0;
  let lastAxis = -1;
  for (let i = 0; i < length; i++) {
    let axis: number;
    let layer: number;
    do {
      axis = rn(turns.length, rng);
      layer = rn(turns[axis].length, rng);
      if (axis !== lastAxis) {
        done = 0;
        lastAxis = axis;
      }
    } while ((done >> layer) & 1);
    done |= 1 << layer;
    const t = turns[axis][layer];
    out.push((typeof t === 'string' ? t : pick(t, rng)) + pick(suffixes, rng));
  }
  return out.join(' ');
}

/** csTimer's `adjScramble`: a face may come back once a face next to it has turned. */
function adjacent(faces: readonly string[], adj: readonly number[], length: number, suffixes: readonly string[], rng: Rng): string {
  let used = 0;
  const out: string[] = [];
  for (let j = 0; j < length; j++) {
    let face: number;
    do face = rn(faces.length, rng);
    while ((used >> face) & 1);
    out.push(faces[face] + pick(suffixes, rng));
    used &= ~adj[face];
    used |= 1 << face;
  }
  return out.join(' ');
}

/** Megaminx-style Pochmann lines ("R++ D-- ... U'"), as csTimer's kilominx and pyraminx crystal. */
function pochmann(perLine: number, lines: number, rng: Rng): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const moves = Array.from({ length: perLine }, (_, j) => (j % 2 === 0 ? 'R' : 'D') + pick(['++', '--'], rng));
    out.push(`${moves.join(' ')} ${moves[moves.length - 1].endsWith('--') ? "U'" : 'U'}`);
  }
  return out.join('\n');
}

/** Megaminx in carrot notation ("++ -+ ... U"). */
function carrot(perLine: number, lines: number, rng: Rng): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const pairs = Array.from({ length: perLine / 2 }, () => pick(['+', '-'], rng) + pick(['+', '-'], rng));
    out.push(`${pairs.join(' ')} ${pairs[pairs.length - 1].endsWith('-') ? "U'" : 'U'}`);
  }
  return out.join('\n');
}

/** Gigaminx Pochmann lines (outer or wide R and D, then a y turn). */
function giga(length: number, rng: Rng): string {
  const out: string[] = [];
  for (let i = 0; i < Math.ceil(length / 10); i++) {
    const moves = Array.from({ length: 10 }, (_, j) => (j % 2 === 0 ? pick(['R', 'r'], rng) : pick(['D', 'd'], rng)) + pick(['+', '++', '-', '--'], rng));
    out.push(`${moves.join(' ')} y${pick(MINX, rng)}`);
  }
  return out.join('\n');
}

const UDcube = [['U', "U'", 'U2'], ['D', "D'", 'D2']];

/** type id -> how its scramble is made */
const TABLE: Record<string, (rng: Rng) => string> = {
  '333o': (r) => mega([['U', 'D'], ['R', 'L'], ['F', 'B']], CUBE, 25, r),
  '2223': (r) => mega([['U'], ['R'], ['F']], CUBE, 25, r),
  '334': (r) => mega([[['U', "U'", 'U2'], ['u', "u'", 'u2']], [['R2', 'L2', 'M2']], [['F2', 'B2', 'S2']]], [''], 40, r),
  '336': (r) => mega([[['U', "U'", 'U2'], ['u', "u'", 'u2'], ['3u', '3u2', "3u'"]], [['R2', 'L2', 'M2']], [['F2', 'B2', 'S2']]], [''], 40, r),
  '888': (r) => mega([['U', 'D', 'u', 'd', '3u', '3d', '4u'], ['R', 'L', 'r', 'l', '3r', '3l', '4r'], ['F', 'B', 'f', 'b', '3f', '3b', '4f']], CUBE, 120, r),
  '999': (r) => mega([['U', 'D', 'u', 'd', '3u', '3d', '4u', '4d'], ['R', 'L', 'r', 'l', '3r', '3l', '4r', '4l'], ['F', 'B', 'f', 'b', '3f', '3b', '4f', '4b']], CUBE, 120, r),
  '101010': (r) =>
    mega([['U', 'D', 'u', 'd', '3u', '3d', '4u', '4d', '5u'], ['R', 'L', 'r', 'l', '3r', '3l', '4r', '4l', '5r'], ['F', 'B', 'f', 'b', '3f', '3b', '4f', '4b', '5f']], CUBE, 120, r),
  '111111': (r) =>
    mega([['U', 'D', 'u', 'd', '3u', '3d', '4u', '4d', '5u', '5d'], ['R', 'L', 'r', 'l', '3r', '3l', '4r', '4l', '5r', '5l'], ['F', 'B', 'f', 'b', '3f', '3b', '4f', '4b', '5f', '5b']], CUBE, 120, r),
  '444': (r) => mega([['U', 'D', 'u'], ['R', 'L', 'r'], ['F', 'B', 'f']], CUBE, 40, r),
  '444m': (r) => mega([['U', 'D', 'Uw'], ['R', 'L', 'Rw'], ['F', 'B', 'Fw']], CUBE, 40, r),
  '555': (r) => mega([['U', 'D', 'u', 'd'], ['R', 'L', 'r', 'l'], ['F', 'B', 'f', 'b']], CUBE, 60, r),
  '666si': (r) => mega([['U', 'D', 'u', 'd', '3u'], ['R', 'L', 'r', 'l', '3r'], ['F', 'B', 'f', 'b', '3f']], CUBE, 80, r),
  '666p': (r) => mega([['U', 'D', '2U', '2D', '3U'], ['R', 'L', '2R', '2L', '3R'], ['F', 'B', '2F', '2B', '3F']], CUBE, 80, r),
  '777si': (r) => mega([['U', 'D', 'u', 'd', '3u', '3d'], ['R', 'L', 'r', 'l', '3r', '3l'], ['F', 'B', 'f', 'b', '3f', '3b']], CUBE, 100, r),
  '777p': (r) => mega([['U', 'D', '2U', '2D', '3U', '3D'], ['R', 'L', '2R', '2L', '3R', '3L'], ['F', 'B', '2F', '2B', '3F', '3B']], CUBE, 100, r),
  crz3a: (r) => mega([['U', 'D'], ['R', 'L'], ['F', 'B']], CUBE, 30, r),
  cm3: (r) => mega([[['U<', 'U>', 'U2'], ['E<', 'E>', 'E2'], ['D<', 'D>', 'D2']], [['R^', 'Rv', 'R2'], ['M^', 'Mv', 'M2'], ['L^', 'Lv', 'L2']]], [''], 25, r),
  cm2: (r) => mega([[['U<', 'U>', 'U2'], ['D<', 'D>', 'D2']], [['R^', 'Rv', 'R2'], ['L^', 'Lv', 'L2']]], [''], 25, r),
  '233': (r) => mega([[['U', "U'", 'U2']], ['R2', 'L2'], ['F2', 'B2']], [''], 25, r),
  fto: (r) => mega([['U', 'D'], ['F', 'B'], ['L', 'BR'], ['R', 'BL']], ['', "'"], 30, r),
  gear: (r) => mega([['U'], ['R'], ['F']], ['', '2', '3', '4', '5', '6', "'", "2'", "3'", "4'", "5'"], 10, r),
  sfl: (r) => mega([['R', 'L'], ['U', 'D']], CUBE, 25, r),
  ufo: (r) => mega([['A'], ['B'], ['C'], [['U', "U'", "U2'", 'U2', 'U3']]], [''], 25, r),
  RrUu: (r) => mega([['U', 'u'], ['R', 'r']], CUBE, 40, r),
  minx2g: (r) => mega([['U'], ['R']], MINX, 30, r),
  lsll: (r) => mega([[["R U R'", "R U2 R'", "R U' R'"]], [["F' U F", "F' U2 F", "F' U' F"]], [['U', 'U2', "U'"]]], [''], 15, r),
  prco: (r) => mega([['F', 'B'], ['U', 'D'], ['L', 'DBR'], ['R', 'DBL'], ['BL', 'DR'], ['BR', 'DL']], MINX, 70, r),
  skb: (r) => mega([['R'], ['L'], ['B'], ['U']], ['', "'"], 25, r),
  ivy: (r) => mega([['R'], ['L'], ['D'], ['B']], ['', "'"], 10, r),
  // csTimer makes these move subsets random-state with a subgroup solver; here they're random moves
  '2gen': (r) => mega([['U'], ['R']], CUBE, 25, r),
  '2genl': (r) => mega([['U'], ['L']], CUBE, 25, r),
  roux: (r) => mega([['U'], ['M']], CUBE, 25, r),
  '3gen_F': (r) => mega([['U'], ['R'], ['F']], CUBE, 25, r),
  '3gen_L': (r) => mega([['U'], ['R', 'L']], CUBE, 25, r),
  RrU: (r) => mega([['U'], ['R', 'r']], CUBE, 25, r),
  half: (r) => mega([['U', 'D'], ['R', 'L'], ['F', 'B']], ['2'], 25, r),
  '333drud': (r) => mega([UDcube, ['R2', 'L2'], ['F2', 'B2']], [''], 25, r),
  sia113: (r) => `${mega([['U', 'u'], ['R', 'r']], CUBE, 25, r)} z2 ${mega([['U', 'u'], ['R', 'r']], CUBE, 25, r)}`,
  sia123: (r) => `${mega([['U'], ['R', 'r']], CUBE, 25, r)} z2 ${mega([['U'], ['R', 'r']], CUBE, 25, r)}`,
  sia222: (r) => `${mega([['U'], ['R'], ['F']], CUBE, 25, r)} z2 y ${mega([['U'], ['R'], ['F']], CUBE, 25, r)}`,
  klmp: (r) => pochmann(10, 3, r),
  prcp: (r) => pochmann(10, 7, r),
  mgmc: (r) => carrot(10, 7, r),
  giga: (r) => giga(300, r),
  mgmo: (r) =>
    adjacent(['F', 'B', 'U', 'D', 'L', 'DBR', 'DL', 'BR', 'DR', 'BL', 'R', 'DBL'], [0x554, 0xaa8, 0x691, 0x962, 0xa45, 0x58a, 0x919, 0x626, 0x469, 0x896, 0x1a5, 0x25a], 70, MINX, r),
};

/** The scramble types made from random moves alone (no search). */
export const RANDOM_MOVE_TYPES: ReadonlySet<string> = new Set(Object.keys(TABLE));

/** A random-move scramble of type `id` (csTimer's default length), or null if `id` isn't one. */
export function randomMoveScramble(id: string, rng: Rng = Math.random): string | null {
  const make = TABLE[id];
  return make ? make(rng) : null;
}

/** 3x3x5 and 3x3x7: random turns of the cuboid's own layers, then a 3x3 random-state scramble. */
export function cuboidPrefix(id: '335' | '337', rng: Rng = Math.random): string {
  if (id === '335') return mega([UDcube, ['R2', 'L2'], ['F2', 'B2']], [''], 25, rng);
  const layered = (f: string, w: string) => {
    const one = [f, `${f}'`, `${f}2`];
    const wide = [w, `${w}'`, `${w}2`];
    return [...one, ...wide, ...one.flatMap((a) => wide.map((b) => `${a} ${b}`))];
  };
  return mega([[layered('U', 'u'), layered('D', 'd')], ['R2', 'L2'], ['F2', 'B2']], [''], 40, rng);
}
