// Client-side random-move scramblers, used only when the scramble service is unreachable.
// They are not random-state (like WCA's TNoodle / cubing.js), so the UI marks them as
// "offline scramble". Notation matches cubing.js / WCA so the preview and the solve list work.
// (cubing/scramble is deliberately NOT imported in the browser: it breaks the Vite build.)

type Rng = () => number;
const pick = <T>(xs: readonly T[], rng: Rng): T => xs[Math.floor(rng() * xs.length) % xs.length];
const randInt = (lo: number, hi: number, rng: Rng) => lo + (Math.floor(rng() * (hi - lo + 1)) % (hi - lo + 1));

interface CubeMove {
  /** 0 = U/D, 1 = R/L, 2 = F/B */
  axis: number;
  /** distinct layer group on that axis (e.g. "R", "Rw", "3Rw" are different layers) */
  layer: string;
  text: string;
}

const FACES: { face: string; axis: number }[] = [
  { face: 'U', axis: 0 },
  { face: 'D', axis: 0 },
  { face: 'R', axis: 1 },
  { face: 'L', axis: 1 },
  { face: 'F', axis: 2 },
  { face: 'B', axis: 2 },
];
const SUFFIX = ['', "'", '2'];

function cubeMoves(size: number): CubeMove[] {
  const out: CubeMove[] = [];
  const faces = size === 2 ? FACES.filter((f) => f.face === 'U' || f.face === 'R' || f.face === 'F') : FACES;
  for (const { face, axis } of faces) {
    out.push({ axis, layer: face, text: face });
    if (size === 4 && (face === 'U' || face === 'R' || face === 'F')) out.push({ axis, layer: `${face}w`, text: `${face}w` });
    if (size >= 5) out.push({ axis, layer: `${face}w`, text: `${face}w` });
    if (size === 6 && (face === 'U' || face === 'R' || face === 'F')) out.push({ axis, layer: `3${face}w`, text: `3${face}w` });
    if (size === 7) out.push({ axis, layer: `3${face}w`, text: `3${face}w` });
  }
  return out;
}

/**
 * Random moves without redundancy: never the same layer twice in a row on one axis, and at most
 * two consecutive moves on the same axis (so "R L R" style cancellations can't appear).
 */
export function cubeScramble(size: number, length: number, rng: Rng = Math.random): string {
  const moves = cubeMoves(size);
  const seq: string[] = [];
  let axis = -1;
  let layersOnAxis = new Set<string>();
  let run = 0;
  while (seq.length < length) {
    const m = pick(moves, rng);
    if (m.axis === axis) {
      if (layersOnAxis.has(m.layer) || run >= 2) continue;
      layersOnAxis.add(m.layer);
      run++;
    } else {
      axis = m.axis;
      layersOnAxis = new Set([m.layer]);
      run = 1;
    }
    seq.push(m.text + pick(SUFFIX, rng));
  }
  return seq.join(' ');
}

export function pyraminxScramble(rng: Rng = Math.random): string {
  const seq: string[] = [];
  const len = randInt(8, 10, rng);
  let last = '';
  while (seq.length < len) {
    const f = pick(['U', 'L', 'R', 'B'], rng);
    if (f === last) continue;
    last = f;
    seq.push(f + pick(['', "'"], rng));
  }
  for (const tip of ['u', 'l', 'r', 'b']) {
    const r = Math.floor(rng() * 3) % 3;
    if (r === 1) seq.push(tip);
    else if (r === 2) seq.push(`${tip}'`);
  }
  return seq.join(' ');
}

export function skewbScramble(rng: Rng = Math.random): string {
  const seq: string[] = [];
  let last = '';
  while (seq.length < 9) {
    const f = pick(['R', 'U', 'L', 'B'], rng);
    if (f === last) continue;
    last = f;
    seq.push(f + pick(['', "'"], rng));
  }
  return seq.join(' ');
}

/** WCA (Pochmann) megaminx notation: 7 lines of 10 R/D moves followed by U or U'. */
export function megaminxScramble(rng: Rng = Math.random): string {
  const lines: string[] = [];
  for (let l = 0; l < 7; l++) {
    const parts: string[] = [];
    for (let i = 0; i < 10; i++) parts.push(`${i % 2 === 0 ? 'R' : 'D'}${pick(['++', '--'], rng)}`);
    parts.push(pick(['U', "U'"], rng));
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

const CLOCK_AMOUNTS = ['0+', '1+', '2+', '3+', '4+', '5+', '6+', '1-', '2-', '3-', '4-', '5-'];
export function clockScramble(rng: Rng = Math.random): string {
  const front = ['UR', 'DR', 'DL', 'UL', 'U', 'R', 'D', 'L', 'ALL'].map((p) => p + pick(CLOCK_AMOUNTS, rng));
  const back = ['U', 'R', 'D', 'L', 'ALL'].map((p) => p + pick(CLOCK_AMOUNTS, rng));
  return [...front, 'y2', ...back].join(' ');
}

/**
 * Square-1 random-move scramble with shape tracking (same model as csTimer): each layer has 12
 * 30-degree slots; `p[i] = 1` marks the first half of a corner, so a slice through slot i|i+1 is illegal.
 * A twist (x, y) is legal only if, afterwards, both layers can be cut at slots 5|6 and 11|0.
 */
export function square1Scramble(slices = 12, rng: Rng = Math.random): string {
  const p = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const legal = (x: number, y: number) => !(p[(17 - x) % 12] || p[(11 - x) % 12] || p[12 + ((17 - y) % 12)] || p[12 + ((11 - y) % 12)]);
  const turn = (x: number, y: number) => {
    const top = p.slice(0, 12);
    const bot = p.slice(12, 24);
    for (let i = 0; i < 12; i++) {
      p[i] = top[(12 + i - x) % 12];
      p[i + 12] = bot[(12 + i - y) % 12];
    }
  };
  const slash = () => {
    for (let i = 0; i < 6; i++) {
      const t = p[i + 6];
      p[i + 6] = p[i + 12];
      p[i + 12] = t;
    }
  };
  const parts: string[] = [];
  for (let n = 0; n < slices; n++) {
    for (let tries = 0; tries < 200; tries++) {
      const x = randInt(-5, 6, rng);
      const y = randInt(-5, 6, rng);
      if (x === 0 && y === 0 && n > 0) continue;
      if (!legal(x, y)) continue;
      turn(x, y);
      parts.push(`(${x}, ${y})`);
      break;
    }
    slash();
  }
  // same layout as the scramble service (cubing.js): "(1, 0) / (-1, 3) / ... /"
  return `${parts.join(' / ')} /`;
}

function bldSuffix(rng: Rng): string {
  const a = pick(['', 'Rw', 'Rw2', "Rw'", 'Fw', "Fw'"], rng);
  const b = pick(['', 'Uw', 'Uw2', "Uw'"], rng);
  return [a, b].filter(Boolean).join(' ');
}

/** A random-move scramble for any supported WCA event id. */
export function fallbackScramble(event: string, rng: Rng = Math.random): string {
  switch (event) {
    case '222':
      return cubeScramble(2, 11, rng);
    case '444':
      return cubeScramble(4, 40, rng);
    case '444bf':
      return `${cubeScramble(4, 40, rng)} ${pick(['x', "x'", 'x2', 'y', "y'"], rng)}`;
    case '555':
      return cubeScramble(5, 60, rng);
    case '555bf':
      return `${cubeScramble(5, 60, rng)} ${pick(['x', "x'", 'x2', 'y', "y'"], rng)}`;
    case '666':
      return cubeScramble(6, 80, rng);
    case '777':
      return cubeScramble(7, 100, rng);
    case '333bf':
      return `${cubeScramble(3, 21, rng)} ${bldSuffix(rng)}`.trim();
    case '333fm':
      return `R' U' F ${cubeScramble(3, 21, rng)} R' U' F`;
    case 'pyram':
      return pyraminxScramble(rng);
    case 'skewb':
      return skewbScramble(rng);
    case 'minx':
      return megaminxScramble(rng);
    case 'clock':
      return clockScramble(rng);
    case 'sq1':
      return square1Scramble(12, rng);
    default:
      return cubeScramble(3, 21, rng);
  }
}
