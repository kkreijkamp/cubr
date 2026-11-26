// 3D previews for the scrambles cubing.js can't read as they're written. Some of csTimer's other
// puzzles have no cubing.js puzzle of their own, but cubing.js's puzzle geometry builds them from a
// shape and its cuts (a description string, <twisty-player experimental-puzzle-description>); and
// some scramble types of cubing.js's own puzzles are written in csTimer's notation. Here each such
// scramble is rewritten move by move in cubing.js's notation, for the same puzzle in the same
// colours. Every translation is checked against csTimer's own drawings of real scrambles
// (__tests__/cubing3d.test.ts). In 2D these keep csTimer's drawing (lib/drawnNet).
import { defaultScrambleType, getScrambleType } from '@cubr/cubestats';

/** what cubing.js shows: one of its own puzzles, or a puzzle built from a puzzle geometry description */
export type Puzzle3D = { id: string } | { description: string };

export interface Preview3D {
  puzzle: Puzzle3D;
  /** the scramble in cubing.js's notation */
  alg: string;
}

/**
 * cubing.js's descriptions of the puzzles it builds from their geometry, as its puzzle-geometry
 * names them (getPuzzleDescriptionString): its own cube shapes, helicopter, curvy copter, dino,
 * pyraminx crystal, skewb diamond (csTimer's "diamond"), icosamate and master pyraminx (with tips).
 */
export const DESCRIPTIONS = {
  '8x8x8': 'c f 0.75 f 0.5 f 0.25 f 0',
  '9x9x9': 'c f 0.777777777777778 f 0.555555555555556 f 0.333333333333333 f 0.111111111111111',
  '10x10x10': 'c f 0.8 f 0.6 f 0.4 f 0.2 f 0',
  '11x11x11': 'c f 0.818181818181818 f 0.636363636363636 f 0.454545454545455 f 0.272727272727273 f 0.0909090909090909',
  helicopter: 'c e 0.707106781186547',
  'curvy copter': 'c e 0.83',
  dino: 'c v 0.577350269189626',
  'pyraminx crystal': 'd f 0.447213595499989',
  'skewb diamond': 'o f 0',
  icosamate: 'i v 0',
  'master pyraminx': 't v 0 v 1 v 2',
} as const;

/** one move in csTimer's notation as cubing.js writes it, '' for none, null if it isn't one */
type Translate = (move: string) => string | null;

const same =
  (re: RegExp): Translate =>
  (m) =>
    re.test(m) ? m : null;
const prime = (p: string | undefined) => (p ? "'" : '');

/** SiGN: lower case turns that many layers from the face (r = two, 3r = three); cubing.js reads it alike */
const bigCube = same(/^\d*[URFDLBurfdlb](2|')?$/);
/** a helicopter's edges, half turns, named as cubing.js names them */
const helicopter = same(/^(UF|UR|UB|UL|DF|DR|DB|DL|FR|FL|BR|BL)$/);

/** csTimer's dino corners (as its redi cube's: upper case the top four), by cubing.js's names */
const DINO: Readonly<Record<string, string>> = { F: 'UFR', L: 'ULF', B: 'UBL', R: 'URB', f: 'DRF', l: 'DFL', b: 'DLB', r: 'DBR' };
const dino: Translate = (m) => {
  const t = /^([FLBRflbr])(')?$/.exec(m);
  return t ? DINO[t[1]] + prime(t[2]) : null;
};

/** Pochmann megaminx notation (R++, D--, U'), which cubing.js reads on any megaminx-like puzzle */
const pochmann = same(/^([RD](\+\+|--)|U'?)$/);
/** carrot notation: each pair is an R and a D (csTimer's carrot2poch) */
const carrot: Translate = (m) => {
  const t = /^([+-])([+-])$/.exec(m);
  if (t) return `R${t[1]}${t[1]} D${t[2]}${t[2]}`;
  return /^U'?$/.test(m) ? m : null;
};

/** csTimer's dodecahedron faces by cubing.js's megaminx names: csTimer's lower ring runs DL DR DBR B DBL */
const MINX_FACES: Readonly<Record<string, string>> = {
  U: 'U',
  F: 'F',
  R: 'R',
  L: 'L',
  BL: 'BL',
  BR: 'BR',
  D: 'D',
  B: 'B',
  DR: 'FR',
  DL: 'FL',
  DBR: 'DR',
  DBL: 'DL',
};
/** face turns of a megaminx-like puzzle, by csTimer's names */
const minxFaces: Translate = (m) => {
  const t = /^(DBR|DBL|BR|BL|DR|DL|U|F|R|L|D|B)(2)?(')?$/.exec(m);
  return t ? MINX_FACES[t[1]] + (t[2] ?? '') + prime(t[3]) : null;
};

/** csTimer's octahedron faces are cubing.js's (Bl and Br in its own spelling) */
const diamond: Translate = (m) => {
  const t = /^(U|R|L|F|D|B|BL|BR|Bl|Br)(')?$/.exec(m);
  return t ? t[1].toUpperCase() + prime(t[2]) : null;
};

/**
 * Gigaminx Pochmann: R and D turn all but the opposite face's outer layer (L, U), r and d all but
 * its outer two, by a fifth for each + or -; y turns the whole puzzle about U.
 */
const gigaminx: Translate = (m) => {
  const t = /^([RrDd])(\+\+?|--?)$/.exec(m);
  if (t) {
    const layers = `${t[1] === t[1].toUpperCase() ? 2 : 3}-5${t[1].toUpperCase() === 'R' ? 'L' : 'U'}`;
    // R++ turns two fifths clockwise seen from the face opposite L: anticlockwise seen from L
    return `${layers}${t[2].length === 2 ? '2' : ''}${t[2][0] === '+' ? "'" : ''}`;
  }
  const y = /^y(2)?(')?$/.exec(m);
  return y ? `Uv${y[1] ?? ''}${prime(y[2])}` : null;
};

/** master pyraminx: u (a tip), U (two layers), Uw (three); cubing.js's U is the tip alone */
const masterPyraminx: Translate = (m) => {
  const t = /^([ULRBulrb])(w)?(')?$/.exec(m);
  if (!t) return null;
  const axis = t[1].toUpperCase();
  return `${t[2] ? '1-3' : t[1] === axis ? '1-2' : ''}${axis}${prime(t[3])}`;
};

/** csTimer's icosamate turns, named by two faces at the corner, by cubing.js's corners (its five faces); csTimer turns the other way */
const ICOSAMATE: Readonly<Record<string, string>> = { UL: 'FREGU', UR: 'FUQPL', UrUl: 'UGJMQ', FlFr: 'FLACR', LBl: 'JGEIS', RBr: 'MKOPQ' };
const icosamate: Translate = (m) => {
  const t = /^(UL|UR|UrUl|FlFr|LBl|RBr)(2)?(')?$/.exec(m);
  return t ? ICOSAMATE[t[1]] + (t[2] ?? '') + (t[3] ? '' : "'") : null;
};

const pg = (name: keyof typeof DESCRIPTIONS): Puzzle3D => ({ description: DESCRIPTIONS[name] });

/** scramble types (cubestats scrambleTypes) cubing.js shows in 3D only once translated */
const TYPES: Readonly<Record<string, { puzzle: Puzzle3D; move: Translate }>> = {
  '888': { puzzle: pg('8x8x8'), move: bigCube },
  '999': { puzzle: pg('9x9x9'), move: bigCube },
  '101010': { puzzle: pg('10x10x10'), move: bigCube },
  '111111': { puzzle: pg('11x11x11'), move: bigCube },
  heli: { puzzle: pg('helicopter'), move: helicopter },
  helicv: { puzzle: pg('curvy copter'), move: helicopter },
  dinoso: { puzzle: pg('dino'), move: dino },
  dinoo: { puzzle: pg('dino'), move: dino },
  prcp: { puzzle: pg('pyraminx crystal'), move: pochmann },
  prco: { puzzle: pg('pyraminx crystal'), move: minxFaces },
  dmdso: { puzzle: pg('skewb diamond'), move: diamond },
  ctico: { puzzle: pg('icosamate'), move: icosamate },
  mpyr: { puzzle: pg('master pyraminx'), move: masterPyraminx },
  mpyrso: { puzzle: pg('master pyraminx'), move: masterPyraminx },
  klmso: { puzzle: { id: 'kilominx' }, move: minxFaces },
  giga: { puzzle: { id: 'gigaminx' }, move: gigaminx },
  mgmc: { puzzle: { id: 'megaminx' }, move: carrot },
  mgmo: { puzzle: { id: 'megaminx' }, move: minxFaces },
  mgmso: { puzzle: { id: 'megaminx' }, move: minxFaces },
};

/** the scramble types translated here (for the tests) */
export const PREVIEW_3D_TYPES: readonly string[] = Object.keys(TYPES);

/** csTimer's notation, on a puzzle with no translation here: csTimer's redi cube (cubing.js has no 3D model of it) */
const CSTIMER_ONLY: ReadonlySet<string> = new Set(['rediso', 'redim', 'redi']);

/**
 * Whether a scramble of `event`'s `type` (the default when absent) is in csTimer's notation for a
 * puzzle cubing.js names differently. cubing.js must never read one as it is: most fail (csTimer's
 * DBR and DBL, Uw, f'), but some only use names both have, and cubing.js would turn other faces (its
 * DR and DL are csTimer's DBR and DBL). In 2D they're csTimer's own drawing; in 3D, translated.
 */
export function inCsTimerNotation(event: string, type: string | undefined): boolean {
  const id = type ?? defaultScrambleType(event)?.id;
  return id !== undefined && getScrambleType(event, id) !== undefined && (id in TYPES || CSTIMER_ONLY.has(id));
}

/**
 * The 3D preview of a scramble of `event` (its `type`, the default when absent) that cubing.js can
 * only show translated: the puzzle to load and the scramble in cubing.js's notation. Null for the
 * scrambles cubing.js reads as they are, the puzzles it has no model of, and a scramble with a
 * move that isn't the type's.
 */
export function preview3D(event: string, type: string | undefined, scramble: string): Preview3D | null {
  const id = type ?? defaultScrambleType(event)?.id;
  const t = id !== undefined && getScrambleType(event, id) ? TYPES[id] : undefined;
  if (!t) return null;
  const out: string[] = [];
  for (const m of scramble.split(/\s+/)) {
    if (!m) continue;
    const c = t.move(m);
    if (c === null) return null;
    out.push(c);
  }
  return out.length ? { puzzle: t.puzzle, alg: out.join(' ') } : null;
}
