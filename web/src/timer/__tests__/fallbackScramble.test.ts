import { describe, expect, it } from 'vitest';
import { EVENT_IDS } from '@cubr/cubestats';
import {
  offlineScramble,
  clockScramble,
  cubeScramble,
  fallbackScramble,
  megaminxScramble,
  pyraminxScramble,
  skewbScramble,
  square1Scramble,
} from '../fallbackScramble';

function seeded(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const AXIS: Record<string, number> = { U: 0, D: 0, R: 1, L: 1, F: 2, B: 2 };
const layerOf = (m: string) => m.replace(/['2]$/, '');
const axisOf = (m: string) => AXIS[m.replace(/^\d/, '')[0]];

describe('fallback scrambles', () => {
  it('produces a non-empty scramble for every WCA event', () => {
    for (const ev of EVENT_IDS) expect(fallbackScramble(ev, seeded(1)).trim().length).toBeGreaterThan(5);
  });

  it.each([2, 3, 4, 5, 6, 7])('%sx%s: right length, no redundant consecutive moves', (n) => {
    const rng = seeded(n * 7);
    for (let k = 0; k < 50; k++) {
      const moves = cubeScramble(n, 30, rng).split(' ');
      expect(moves).toHaveLength(30);
      for (let i = 1; i < moves.length; i++) {
        if (axisOf(moves[i]) === axisOf(moves[i - 1])) expect(layerOf(moves[i])).not.toBe(layerOf(moves[i - 1]));
        if (i >= 2) {
          const same = axisOf(moves[i]) === axisOf(moves[i - 1]) && axisOf(moves[i - 1]) === axisOf(moves[i - 2]);
          expect(same).toBe(false);
        }
      }
      if (n === 2) for (const m of moves) expect('URF').toContain(m[0]);
      if (n === 3) for (const m of moves) expect(m).toMatch(/^[UDRLFB]['2]?$/);
    }
  });

  it('pyraminx, skewb, megaminx and clock use WCA notation', () => {
    expect(pyraminxScramble(seeded(3))).toMatch(/^([ULRB]'? ){7,9}[ULRB]'?( [ulrb]'?)*$/);
    expect(skewbScramble(seeded(3))).toMatch(/^([RULB]'? ){8}[RULB]'?$/);
    const minx = megaminxScramble(seeded(4)).split('\n');
    expect(minx).toHaveLength(7);
    for (const line of minx) expect(line).toMatch(/^(R(\+\+|--) D(\+\+|--) ){5}U'?$/);
    const clock = clockScramble(seeded(5)).split(' ');
    expect(clock).toHaveLength(15);
    expect(clock[9]).toBe('y2');
    for (const t of clock.filter((x) => x !== 'y2')) expect(t).toMatch(/^(UR|DR|DL|UL|U|R|D|L|ALL)[0-6][+-]$/);
  });

  it('square-1 twists are always legal (no corner straddles the slice)', () => {
    const rng = seeded(11);
    for (let k = 0; k < 200; k++) {
      const scr = square1Scramble(12, rng);
      expect(scr).toMatch(/^(\(-?\d, -?\d\) \/ ?)+$/);
      // independent re-simulation: corners occupy two 30-degree slots
      const p = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
      const twists = Array.from(scr.matchAll(/\((-?\d+), (-?\d+)\)/g)).map((m) => [Number(m[1]), Number(m[2])]);
      expect(twists).toHaveLength(12);
      for (const [x, y] of twists) {
        expect(x).toBeGreaterThanOrEqual(-5);
        expect(x).toBeLessThanOrEqual(6);
        const top = p.slice(0, 12);
        const bot = p.slice(12);
        for (let i = 0; i < 12; i++) {
          p[i] = top[(12 + i - x) % 12];
          p[12 + i] = bot[(12 + i - y) % 12];
        }
        // slice legal: no corner starts in slot 5 or 11 of either layer
        expect(p[5] || p[11] || p[17] || p[23]).toBe(0);
        for (let i = 0; i < 6; i++) [p[i + 6], p[i + 12]] = [p[i + 12], p[i + 6]];
      }
    }
  });

  it('blind and fewest-moves variants carry their extras', () => {
    expect(fallbackScramble('333fm', seeded(2))).toMatch(/^R' U' F .* R' U' F$/);
    expect(fallbackScramble('444bf', seeded(2))).toMatch(/ [xy]['2]?$/);
  });
});

describe('offline scrambles for the other events and the practice types', () => {
  it('builds relays from each puzzle, labelled one per line', () => {
    const lines = fallbackScramble('r234').split('\n');
    expect(lines.map((l) => l.split(':')[0])).toEqual(['2x2', '3x3', '4x4']);
    // ten puzzles, each labelled once (megaminx's part runs over several lines)
    expect(fallbackScramble('rmngf').match(/^(2x2|3x3|4x4|5x5|3x3 oh|pyra|skewb|sq-1|clock|mega): /gm)).toHaveLength(10);
  });

  it("uses csTimer's random moves where it has them, and nothing where only the service can scramble", () => {
    expect(fallbackScramble('888').split(' ')).toHaveLength(120);
    expect(fallbackScramble('fto').split(' ')).toHaveLength(30);
    expect(fallbackScramble('335')).toMatch(/ \/ /);
    expect(fallbackScramble('15p')).toBe('');
    expect(fallbackScramble('redi')).toBe('');
  });

  it('makes random-move practice types offline, and not the ones that need a solver', () => {
    expect(offlineScramble('333', '2gen').split(' ')).toHaveLength(25);
    expect(offlineScramble('333', 'pll')).toBe('');
    expect(offlineScramble('333')).not.toBe('');
  });
});
