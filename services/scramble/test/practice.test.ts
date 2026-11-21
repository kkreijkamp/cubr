import { describe, expect, it } from 'vitest';
import { crossMoves, decodeSolveJob, easyCrossMasks, encodeSolveJob, hexMask, jobLabel, parity, practiceJob, PRACTICE_STATE_TYPES, randomState } from '../src/practice.js';

// The practice states csTimer's way: pinned pieces stay put, the rest is a random legal state.
// cubing.js slots: edges UF UR UB UL DF DR DB DL FR FL BR BL; corners UFR UBR UBL UFL DFR DFL DBL DBR.

const U_EDGES = [0, 1, 2, 3];
const D_EDGES = [4, 5, 6, 7];
const E_EDGES = [8, 9, 10, 11];
const U_CORNERS = [0, 1, 2, 3];
const D_CORNERS = [4, 5, 6, 7];

function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const solvedAt = (o: { pieces: number[]; orientation: number[] }, slots: number[]) => slots.every((i) => o.pieces[i] === i && o.orientation[i] === 0);

describe('hexMask', () => {
  it("reads csTimer's masks: digit i from the right is position i, f is free", () => {
    expect(hexMask('0xba987654ffff', 12)).toEqual([-1, -1, -1, -1, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(hexMask('0x00000000', 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(hexMask('0x0', 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('practice states', () => {
  const rng = seeded(7);
  const states = (type: string, n = 40) =>
    Array.from({ length: n }, () => {
      const job = practiceJob(type, rng);
      if (!job) throw new Error(type);
      return job;
    });

  it('are always legal: parities match, flips and twists add up', () => {
    for (const type of PRACTICE_STATE_TYPES) {
      for (const { state } of states(type, 25)) {
        const c = state.CORNERS;
        expect(sum(c.orientation) % 3, type).toBe(0);
        expect([...c.pieces].sort((a, b) => a - b), type).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        if (state.EDGES) {
          const e = state.EDGES;
          expect(sum(e.orientation) % 2, type).toBe(0);
          expect([...e.pieces].sort((a, b) => a - b), type).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
          expect(parity(e.pieces), type).toBe(parity(c.pieces));
        } else {
          // 2x2: DBL never moves, as in csTimer
          expect(c.pieces[6], type).toBe(6);
          expect(c.orientation[6], type).toBe(0);
        }
      }
    }
  });

  it('pll: everything solved but the top layer, which is oriented', () => {
    for (const { state } of states('pll')) {
      expect(solvedAt(state.EDGES!, [...D_EDGES, ...E_EDGES])).toBe(true);
      expect(solvedAt(state.CORNERS, D_CORNERS)).toBe(true);
      for (const i of U_EDGES) expect(state.EDGES!.orientation[i]).toBe(0);
      for (const i of U_CORNERS) expect(state.CORNERS.orientation[i]).toBe(0);
      expect(['', 'U', 'U2', "U'"]).toContain(state.pre ?? '');
    }
  });

  it('zbll and coll: F2L solved and every edge oriented; last layer: F2L solved', () => {
    for (const type of ['zbll', 'coll', 'll', 'oll', 'cll']) {
      for (const { state } of states(type, 20)) {
        expect(solvedAt(state.EDGES!, [...D_EDGES, ...E_EDGES]), type).toBe(true);
        expect(solvedAt(state.CORNERS, D_CORNERS), type).toBe(true);
        if (type === 'zbll' || type === 'coll') expect(state.EDGES!.orientation.every((o) => o === 0), type).toBe(true);
      }
    }
  });

  it('cross solved, eoline, eocross: what each pins', () => {
    for (const { state } of states('f2l')) expect(solvedAt(state.EDGES!, D_EDGES)).toBe(true);
    for (const { state } of states('eoline')) {
      expect(state.EDGES!.orientation.every((o) => o === 0)).toBe(true);
      expect(solvedAt(state.EDGES!, [4, 6])).toBe(true); // DF and DB
    }
    for (const { state } of states('eocross')) {
      expect(state.EDGES!.orientation.every((o) => o === 0)).toBe(true);
      expect(solvedAt(state.EDGES!, D_EDGES)).toBe(true);
    }
  });

  it('edges only and corners only leave the other kind solved', () => {
    for (const { state } of states('edges')) expect(solvedAt(state.CORNERS, [...U_CORNERS, ...D_CORNERS])).toBe(true);
    for (const { state } of states('corners')) expect(solvedAt(state.EDGES!, [...U_EDGES, ...D_EDGES, ...E_EDGES])).toBe(true);
  });

  it('last slot: only the front-right pair and the top layer move', () => {
    for (const { state } of states('lsll2')) {
      expect(solvedAt(state.EDGES!, [...D_EDGES, 9, 10, 11])).toBe(true);
      expect(solvedAt(state.CORNERS, [5, 6, 7])).toBe(true);
    }
  });

  it('roux and mehta: a random turn of the blocks, handed back by a whole-cube turn', () => {
    const turns = { sbrx: ["R L'", 'R2 L2', "R' L"], mt3qb: ['D', 'D2', "D'"] } as const;
    const back = { sbrx: { "R L'": "x'", 'R2 L2': 'x2', "R' L": 'x' }, mt3qb: { D: 'y', D2: 'y2', "D'": "y'" } } as const;
    for (const type of ['sbrx', 'mt3qb'] as const) {
      for (const job of states(type)) {
        const pre = job.state.pre ?? '';
        if (!pre) expect(job.suffix).toBeUndefined();
        else {
          expect(turns[type]).toContain(pre);
          expect(job.suffix).toBe((back[type] as Record<string, string>)[pre]);
        }
      }
    }
  });

  it('2x2: cll, eg-1 and eg-2 keep the bottom layer oriented, solved / one adjacent swap / one diagonal swap', () => {
    const bottom = (type: string) => states(type).map(({ state }) => state.CORNERS);
    for (const c of bottom('222eg0')) expect(solvedAt(c, D_CORNERS)).toBe(true);
    for (const c of bottom('222eg1')) {
      expect(D_CORNERS.every((i) => c.orientation[i] === 0)).toBe(true);
      const wrong = D_CORNERS.filter((i) => c.pieces[i] !== i);
      expect(wrong.length).toBe(2);
      expect([[4, 5], [4, 7]]).toContainEqual(wrong); // DFR with DFL or DBR: next to each other
    }
    for (const c of bottom('222eg2')) expect(D_CORNERS.filter((i) => c.pieces[i] !== i)).toEqual([5, 7]);
    for (const c of bottom('222tc')) {
      expect(D_CORNERS.every((i) => c.pieces[i] === i)).toBe(true);
      expect(D_CORNERS.filter((i) => c.orientation[i] !== 0)).toEqual([4]);
    }
  });

  it('easy cross: the cross takes 1 to 3 moves', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const s = randomState(easyCrossMasks(1, 3, rng), rng);
      const n = crossMoves(s.EDGES!);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(3);
      seen.add(n);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('round-trips the job string the backend gets', () => {
    const job = practiceJob('pll', rng)!;
    const text = encodeSolveJob(job.puzzle, job.state);
    expect(text.startsWith('solve:3x3x3:')).toBe(true);
    expect(decodeSolveJob(text)).toEqual({ puzzle: '3x3x3', state: job.state });
    expect(decodeSolveJob('333')).toBeNull();
    expect(jobLabel(text)).toBe('solve:3x3x3');
    expect(jobLabel('kilominx')).toBe('kilominx');
  });

  it('knows no other types', () => {
    expect(practiceJob('333', rng)).toBeNull();
    expect(practiceJob('wvls', rng)).toBeNull();
  });
});
