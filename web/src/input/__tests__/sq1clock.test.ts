import { describe, expect, it } from 'vitest';
import { puzzles } from 'cubing/puzzles';
import { applyClock, clockIsSolved, clockKey, clockSolved, parseClock } from '../virtual/clock';
import { applySq1, canSlash, parseSq1, sq1IsSolved, sq1Key, sq1Solved, type Sq1State } from '../virtual/square1';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const run = (alg: string): Sq1State => {
  let s = sq1Solved();
  for (const m of parseSq1(alg)!) s = applySq1(s, m);
  return s;
};

/** a random legal square-1 scramble: turns that leave the cut clear, then a slash */
function sq1Scramble(r: () => number, slashes: number): string {
  let s = sq1Solved();
  const parts: string[] = [];
  for (let i = 0; i < slashes; i++) {
    for (let tries = 0; tries < 500; tries++) {
      const top = Math.floor(r() * 12) - 5;
      const bottom = Math.floor(r() * 12) - 5;
      const t = applySq1(s, { kind: 'turn', top, bottom });
      if (canSlash(t) && (top || bottom || i === 0)) {
        parts.push(`(${top}, ${bottom})`);
        s = applySq1(t, { kind: 'slash' });
        break;
      }
    }
  }
  return parts.join(' / ') + ' /';
}

describe('square-1', () => {
  it('matches cubing.js wedge for wedge', async () => {
    const kp = await puzzles.square1.kpuzzle();
    const r = rng(5);
    for (let i = 0; i < 20; i++) {
      const alg = sq1Scramble(r, 12);
      const ours = run(alg).wedges;
      const theirs = kp.defaultPattern().applyAlg(alg).patternData.WEDGES.pieces;
      expect(ours, alg).toEqual(theirs);
    }
    // the scramble service's format, spaces and all
    const alg = '(0, 5) / (3, 0) / (-2, 4) / (3, 0) / (-3, 0) / (0, 3) / (3, 0) / (5, 0) / (3, 0) / (3, 2) / (2, 0) / (1, 0) / (-2, 3)';
    expect(run(alg).wedges).toEqual(kp.defaultPattern().applyAlg(alg).patternData.WEDGES.pieces);
  });

  it('only slashes when no corner is across the cut', () => {
    expect(canSlash(sq1Solved())).toBe(true);
    // from the cube shape, (1,0) and (0,-1) keep the cut clear; the other way a corner sits across it
    expect(canSlash(run('(1,0)'))).toBe(true);
    expect(canSlash(run('(-1,0)'))).toBe(false);
    expect(canSlash(run('(0,1)'))).toBe(false);
    expect(canSlash(run('(0,-1)'))).toBe(true);
    expect(canSlash(run('(3,0)'))).toBe(true);
    expect(canSlash(run('(1,1)'))).toBe(false);
  });

  it('knows when it is solved, in any orientation', () => {
    expect(sq1IsSolved(sq1Solved())).toBe(true);
    expect(sq1IsSolved(run('/'))).toBe(false);
    expect(sq1IsSolved(run('/ /'))).toBe(true);
    expect(sq1IsSolved(run('(3,0)'))).toBe(false);
    expect(sq1IsSolved(run('(3,0) (-3,0)'))).toBe(true);
    expect(sq1IsSolved(run('(1,0) / (-1,0) / (1,0) / (-1,0)'))).toBe(false);
    // whole-puzzle half turns (inspection) keep it solved
    for (const k of ['Semicolon', 'KeyT', 'KeyP']) {
      const s = applySq1(sq1Solved(), sq1Key(k)!);
      expect(sq1IsSolved(s), k).toBe(true);
    }
    // a slash after turning the puzzle over is a slash of the other half: undoing it solves it again
    let s = applySq1(sq1Solved(), sq1Key('Semicolon')!);
    s = applySq1(s, { kind: 'slash' });
    expect(sq1IsSolved(s)).toBe(false);
    s = applySq1(s, { kind: 'slash' });
    expect(sq1IsSolved(s)).toBe(true);
  });
});

describe('clock', () => {
  const ours = (alg: string) => {
    let s = clockSolved();
    for (const m of parseClock(alg)!) s = applyClock(s, m);
    return s;
  };
  /**
   * cubing.js's dial readings, by dial, numbered as csTimer does: csTimer turns the clock over before a
   * scramble, so its dials 0-8 are the face cubing.js (and the WCA) calls the back
   */
  const theirs = async (alg: string) => {
    const kp = await puzzles.clock.kpuzzle();
    const d = kp.defaultPattern().applyAlg(alg).patternData.DIALS;
    const out: number[] = [];
    d.pieces.forEach((piece: number, at: number) => (out[(piece + 9) % 18] = d.orientation[at]));
    return out;
  };

  it('matches cubing.js dial for dial', async () => {
    const r = rng(9);
    const groups = ['UR', 'DR', 'DL', 'UL', 'U', 'R', 'D', 'L', 'ALL'];
    for (let i = 0; i < 20; i++) {
      const turn = (g: string) => `${g}${Math.floor(r() * 7)}${r() < 0.5 ? '+' : '-'}`;
      const alg = [...groups.map(turn), 'y2', ...['U', 'R', 'D', 'L', 'ALL'].map(turn)].join(' ');
      expect(ours(alg).dials, alg).toEqual(await theirs(alg));
    }
    const wca = 'U5- R4- D6+ L4+ ALL5+ UR4- DR3- DL1+ UL1+ y2 U2- R2- D3+ L3+ ALL3-';
    expect(ours(wca).dials).toEqual(await theirs(wca));
    expect(ours(wca).flipped).toBe(false);
  });

  it('reads pins at the end of a scramble and rejects junk', () => {
    expect(ours('UR1+ y2 ALL2- UR DL').pins.filter((p) => p === 0)).toHaveLength(2);
    expect(parseClock('UR1+ banana')).toBeNull();
  });

  it('is solved when every dial is at twelve', () => {
    expect(clockIsSolved(clockSolved())).toBe(true);
    expect(clockIsSolved(ours('UR1+'))).toBe(false);
    expect(clockIsSolved(ours('UR1+ UR1-'))).toBe(true);
    // csTimer's keys: O turns the UR wheel one hour on, I one hour back
    let s = clockSolved();
    s = applyClock(s, clockKey('KeyO')!);
    expect(clockIsSolved(s)).toBe(false);
    s = applyClock(s, clockKey('KeyI')!);
    expect(clockIsSolved(s)).toBe(true);
  });
});
