// A 3x3 cube as corners and edges (permutation and orientation): csTimer's mathlib.CubieCube, which
// every smart cube driver talks in. A corner is perm | twist << 3, an edge perm << 1 | flip. Facelets
// are the usual 54-letter URFDLB string (each face read row by row as the standard net shows it).

export const SOLVED_FACELET = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

/** the facelets of each corner (URF UFL ULB UBR DFR DLF DBL DRB) and edge (UR UF UL UB DR DF DL DB FR FL BL BR) */
export const C_FACELET = [
  [8, 9, 20],
  [6, 18, 38],
  [0, 36, 47],
  [2, 45, 11],
  [29, 26, 15],
  [27, 44, 24],
  [33, 53, 42],
  [35, 17, 51],
];
export const E_FACELET = [
  [5, 10],
  [7, 19],
  [3, 37],
  [1, 46],
  [32, 16],
  [28, 25],
  [30, 43],
  [34, 52],
  [23, 12],
  [21, 41],
  [50, 39],
  [48, 14],
];

export class CubieCube {
  ca = [0, 1, 2, 3, 4, 5, 6, 7];
  ea = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

  static mult(a: CubieCube, b: CubieCube, prod: CubieCube): CubieCube {
    for (let c = 0; c < 8; c++) {
      const ori = ((a.ca[b.ca[c] & 7] >> 3) + (b.ca[c] >> 3)) % 3;
      prod.ca[c] = (a.ca[b.ca[c] & 7] & 7) | (ori << 3);
    }
    for (let e = 0; e < 12; e++) prod.ea[e] = a.ea[b.ea[e] >> 1] ^ (b.ea[e] & 1);
    return prod;
  }

  init(ca: number[], ea: number[]): this {
    this.ca = ca.slice();
    this.ea = ea.slice();
    return this;
  }

  clone(): CubieCube {
    return new CubieCube().init(this.ca, this.ea);
  }

  isEqual(c: CubieCube): boolean {
    return this.ca.every((v, i) => v === c.ca[i]) && this.ea.every((v, i) => v === c.ea[i]);
  }

  /** the same corners (a 2x2 has no edges) */
  cornersEqual(c: CubieCube): boolean {
    return this.ca.every((v, i) => v === c.ca[i]);
  }

  toFaceCube(cFacelet = C_FACELET, eFacelet = E_FACELET): string {
    const f: number[] = Array.from({ length: 54 }, (_, i) => i);
    for (let c = 0; c < 8; c++) {
      const j = this.ca[c] & 7;
      const ori = this.ca[c] >> 3;
      for (let n = 0; n < 3; n++) f[cFacelet[c][(n + ori) % 3]] = cFacelet[j][n];
    }
    for (let e = 0; e < 12; e++) {
      const j = this.ea[e] >> 1;
      const ori = this.ea[e] & 1;
      for (let n = 0; n < 2; n++) f[eFacelet[e][(n + ori) % 2]] = eFacelet[j][n];
    }
    return f.map((x) => 'URFDLB'[Math.floor(x / 9)]).join('');
  }

  /** from facelets (any centre letters); null if they aren't a cube */
  fromFacelet(facelet: string, cFacelet = C_FACELET, eFacelet = E_FACELET): this | null {
    const centers = facelet[4] + facelet[13] + facelet[22] + facelet[31] + facelet[40] + facelet[49];
    const f: number[] = [];
    let count = 0;
    for (let i = 0; i < 54; i++) {
      f[i] = centers.indexOf(facelet[i]);
      if (f[i] === -1) return null;
      count += 1 << (f[i] << 2);
    }
    if (count !== 0x999999) return null;
    for (let i = 0; i < 8; i++) {
      let ori = 0;
      for (; ori < 3; ori++) if (f[cFacelet[i][ori]] === 0 || f[cFacelet[i][ori]] === 3) break;
      const col1 = f[cFacelet[i][(ori + 1) % 3]];
      const col2 = f[cFacelet[i][(ori + 2) % 3]];
      for (let j = 0; j < 8; j++) {
        if (col1 === Math.floor(cFacelet[j][1] / 9) && col2 === Math.floor(cFacelet[j][2] / 9)) {
          this.ca[i] = j | ((ori % 3) << 3);
          break;
        }
      }
    }
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        if (f[eFacelet[i][0]] === Math.floor(eFacelet[j][0] / 9) && f[eFacelet[i][1]] === Math.floor(eFacelet[j][1] / 9)) {
          this.ea[i] = j << 1;
          break;
        }
        if (f[eFacelet[i][0]] === Math.floor(eFacelet[j][1] / 9) && f[eFacelet[i][1]] === Math.floor(eFacelet[j][0] / 9)) {
          this.ea[i] = (j << 1) | 1;
          break;
        }
      }
    }
    return this;
  }

  invFrom(cc: CubieCube): this {
    for (let e = 0; e < 12; e++) this.ea[cc.ea[e] >> 1] = (e << 1) | (cc.ea[e] & 1);
    for (let c = 0; c < 8; c++) this.ca[cc.ca[c] & 7] = c | ((0x20 >> (cc.ca[c] >> 3)) & 0x18);
    return this;
  }

  /** a real cube: every piece once, twists and flips that add up, matching permutation parities */
  verify(): boolean {
    let mask = 0;
    let sum = 0;
    for (let e = 0; e < 12; e++) {
      mask |= (1 << 8) << (this.ea[e] >> 1);
      sum ^= this.ea[e] & 1;
    }
    for (let c = 0; c < 8; c++) {
      mask |= 1 << (this.ca[c] & 7);
      sum += (this.ca[c] >> 3) << 1;
    }
    if (mask !== 0xfffff || sum % 6 !== 0) return false;
    return parity(this.ea.map((e) => e >> 1)) === parity(this.ca.map((c) => c & 7));
  }

  /** a face turn ("R", "U2", "F'"; "R " as the drivers write a quarter turn) */
  move(m: string): this {
    const idx = moveIndex(m);
    if (idx < 0) return this;
    const out = new CubieCube();
    CubieCube.mult(this, MOVE_CUBE[idx], out);
    return this.init(out.ca, out.ea);
  }
}

function parity(p: number[]): number {
  let n = 0;
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (p[i] > p[j]) n++;
  return n & 1;
}

/** 0..17: face (URFDLB) * 3 + (quarter, half, counter-quarter) */
export function moveIndex(m: string): number {
  const face = 'URFDLB'.indexOf(m[0]);
  if (face < 0) return -1;
  const pow = " 2'".indexOf(m[1] ?? ' ');
  return face * 3 + (pow < 0 ? 0 : pow);
}

export const moveName = (i: number) => 'URFDLB'[Math.floor(i / 3)] + " 2'"[i % 3];

export const MOVE_CUBE: CubieCube[] = (() => {
  const m = Array.from({ length: 18 }, () => new CubieCube());
  m[0].init([3, 0, 1, 2, 4, 5, 6, 7], [6, 0, 2, 4, 8, 10, 12, 14, 16, 18, 20, 22]);
  m[3].init([20, 1, 2, 8, 15, 5, 6, 19], [16, 2, 4, 6, 22, 10, 12, 14, 8, 18, 20, 0]);
  m[6].init([9, 21, 2, 3, 16, 12, 6, 7], [0, 19, 4, 6, 8, 17, 12, 14, 3, 11, 20, 22]);
  m[9].init([0, 1, 2, 3, 5, 6, 7, 4], [0, 2, 4, 6, 10, 12, 14, 8, 16, 18, 20, 22]);
  m[12].init([0, 10, 22, 3, 4, 17, 13, 7], [0, 2, 20, 6, 8, 10, 18, 14, 16, 4, 12, 22]);
  m[15].init([0, 1, 11, 23, 4, 5, 18, 14], [0, 2, 4, 23, 8, 10, 12, 21, 16, 18, 7, 15]);
  for (let a = 0; a < 18; a += 3) for (let p = 0; p < 2; p++) CubieCube.mult(m[a + p], m[a], m[a + p + 1]);
  return m;
})();

/** the facelets solved, a 2x2 (corners only: every corner sticker in place) or a 3x3 */
export function isFaceletSolved(facelet: string, is222: boolean): boolean {
  if (!is222) return facelet === SOLVED_FACELET;
  const c = new CubieCube().fromFacelet(facelet);
  return c !== null && c.cornersEqual(new CubieCube());
}

/** a scramble (face turns only) applied to a solved cube; null when it has other moves (wide, slices) */
export function scrambleCube(scramble: string): CubieCube | null {
  const c = new CubieCube();
  for (const t of scramble.split(/\s+/).filter(Boolean)) {
    const m = /^([URFDLB])(2|')?$/.exec(t);
    if (!m) return null;
    c.move(m[1] + (m[2] === '2' ? '2' : m[2] === "'" ? "'" : ' '));
  }
  return c;
}
