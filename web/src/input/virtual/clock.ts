// Clock for the virtual puzzle: csTimer's model (twisty/twistyclk.js), whose dial numbering is the
// same as cubing.js's. 18 dials (front 0-8 row by row, back 9-17), four pins and which side faces you.
// Turning a corner wheel turns every dial linked to the pins that are in the same state as that
// corner's pin; a dial on the back turns the other way.

export interface ClockState {
  /** dial readings in hours, 0 = twelve o'clock */
  dials: number[];
  /** pins UR, UL, DR, DL as seen from the front: 0 up, 1 down */
  pins: number[];
  /** the back is facing you */
  flipped: boolean;
}

/**
 * Moves as csTimer has them: a wheel (0-3: UR UL DR DL as you see them) turned by `amount` hours,
 * a pin pressed (4-7), the clock turned over (8), or one face's wheel (10 front, 11 back) for
 * csTimer's reconstructions.
 */
export interface ClockMove {
  axis: number;
  amount: number;
}

export const M_UR = 0;
export const M_PIN = 4;
export const M_FLIP = 8;

const BUTTON_AFFECTS = [
  [1, 2, 4, 5, 9],
  [0, 1, 3, 4, 11],
  [4, 5, 7, 8, 15],
  [3, 4, 6, 7, 17],
];
/** each dial's twin when the clock is seen from the other side */
const FACE_Y_MAP = [11, 10, 9, 14, 13, 12, 17, 16, 15, 2, 1, 0, 5, 4, 3, 8, 7, 6];

export const clockSolved = (): ClockState => ({ dials: Array(18).fill(0), pins: [0, 0, 0, 0], flipped: false });

/** the dials a wheel move turns (csTimer's internalDoMove) */
export function affectedDials(s: ClockState, m: ClockMove): boolean[] {
  let axis = m.axis;
  if (axis === M_FLIP || axis === M_FLIP + 1) return [];
  axis ^= s.flipped ? 1 : 0;
  if (axis >= M_PIN && axis < M_PIN + 4) return [];
  let face = s.pins[axis];
  if (axis >= 10) face = axis & 1;
  let affect: boolean[] = [];
  for (let i = 0; i < 4; i++) {
    if (s.pins[i] !== face) continue;
    for (const d of BUTTON_AFFECTS[i]) affect[d] = true;
  }
  if (face) {
    const tmp: boolean[] = [];
    affect.forEach((on, i) => {
      if (on) tmp[FACE_Y_MAP[i]] = true;
    });
    affect = tmp;
  }
  return Array.from({ length: 18 }, (_, i) => Boolean(affect[i]));
}

export function applyClock(s: ClockState, m: ClockMove): ClockState {
  if (m.axis === M_FLIP || m.axis === M_FLIP + 1) return { ...s, flipped: ((m.amount / 6) % 2 !== 0) !== s.flipped };
  const axis = m.axis ^ (s.flipped ? 1 : 0);
  if (axis >= M_PIN && axis < M_PIN + 4) {
    const pins = s.pins.slice();
    pins[axis - M_PIN] ^= 1;
    return { ...s, pins };
  }
  const affect = affectedDials(s, m);
  const dials = s.dials.map((d, i) => {
    if (!affect[i]) return d;
    const pow = (i < 9) !== s.flipped ? m.amount : -m.amount;
    return (((d + pow) % 12) + 12) % 12;
  });
  return { ...s, dials };
}

export const clockIsSolved = (s: ClockState) => s.dials.every((d) => d % 12 === 0);

/** WCA notation (UR3+ ALL2- y2 ... with or without the final pin states), as csTimer reads it */
export function parseClock(scramble: string): ClockMove[] | null {
  const clkre = /^(([URDL]{1,2}|ALL)(\d+)?([+-])?|y2)$/;
  const moves = scramble.split(/\s+/).filter(Boolean);
  let button = [1, 1, 1, 1];
  const finalButton = [1, 1, 1, 1];
  let isFlip = 1;
  const out: ClockMove[] = [{ axis: M_FLIP, amount: 6 }];
  for (const move of moves) {
    const m = clkre.exec(move);
    if (!m) return null;
    if (!m[3]) {
      if (m[1] === 'y2') {
        out.push({ axis: M_FLIP, amount: 6 });
        button = [1 - button[1], 1 - button[0], 1 - button[3], 1 - button[2]];
        isFlip = 1 - isFlip;
      } else if (['UR', 'UL', 'DR', 'DL'].includes(m[1])) {
        finalButton['URULDRDL'.indexOf(m[1]) >> 1] = 0;
      } else return null;
      continue;
    }
    const pow = Number(m[3]) * (m[4] === '-' ? -1 : 1);
    if (pow === 0) continue;
    const cur = {
      U: [0, 0, 1, 1],
      R: [0, 1, 0, 1],
      D: [1, 1, 0, 0],
      L: [1, 0, 1, 0],
      UR: [0, 1, 1, 1],
      UL: [1, 0, 1, 1],
      DR: [1, 1, 0, 1],
      DL: [1, 1, 1, 0],
      ALL: [0, 0, 0, 0],
    }[m[2]];
    if (!cur) return null;
    let axis = 0;
    for (let j = 0; j < 4; j++) {
      if (button[j] !== cur[j]) {
        out.push({ axis: j + M_PIN, amount: 6 });
        button[j] = cur[j];
      }
      if (!button[j]) axis = j;
    }
    out.push({ axis: axis + M_UR, amount: pow });
  }
  if (isFlip) {
    out.push({ axis: M_FLIP, amount: 6 });
    button = [1 - button[1], 1 - button[0], 1 - button[3], 1 - button[2]];
  }
  for (let j = 0; j < 4; j++) if (button[j] !== finalButton[j]) out.push({ axis: j + M_PIN, amount: 6 });
  return out;
}

export function clockMoveName(m: ClockMove): string {
  if (m.axis === M_FLIP || m.axis === M_FLIP + 1) return 'y2';
  if (m.axis >= M_PIN && m.axis < M_PIN + 4) return `${['UR', 'UL', 'DR', 'DL'][m.axis - M_PIN]} pin`;
  const name = ['UR', 'UL', 'DR', 'DL'][m.axis] ?? 'wheel';
  return `${name}${Math.abs(m.amount)}${m.amount < 0 ? '-' : '+'}`;
}

/** csTimer's clock keys: pins on Y T H G, a wheel per corner (two hours either way), B and N turn it over */
export function clockKey(code: string): ClockMove | null {
  const map: Record<string, [number, number]> = {
    KeyY: [M_PIN + 0, 6],
    KeyT: [M_PIN + 1, 6],
    KeyH: [M_PIN + 2, 6],
    KeyG: [M_PIN + 3, 6],
    KeyU: [0, -2],
    KeyI: [0, -1],
    KeyO: [0, 1],
    KeyP: [0, 2],
    KeyJ: [2, -2],
    KeyK: [2, -1],
    KeyL: [2, 1],
    Semicolon: [2, 2],
    KeyR: [1, 2],
    KeyE: [1, 1],
    KeyW: [1, -1],
    KeyQ: [1, -2],
    KeyF: [3, 2],
    KeyD: [3, 1],
    KeyS: [3, -1],
    KeyA: [3, -2],
    KeyB: [M_FLIP, 6],
    KeyN: [M_FLIP, -6],
  };
  const k = map[code];
  return k ? { axis: k[0], amount: k[1] } : null;
}

/** pins and turning the clock over don't start the timer */
export const clockIsRotation = (m: ClockMove) => m.axis === M_FLIP || (m.axis >= M_PIN && m.axis < M_PIN + 4);
