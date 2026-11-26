import { describe, expect, it } from 'vitest';
import { CubieCube, scrambleCube, SOLVED_FACELET } from '../cube/cubie';
import { movesBetween } from '../cube/solver';
import { CubeView } from '../bluetooth/cubeView';
import { cubeKey, ScrambleHinter, SmartCubeSession, tsLinearFix, type MoveTs } from '../bluetooth/smartSession';

/** a smart cube in the hand: turns it and reports states the way the drivers do */
class Hand {
  raw = new CubieCube();
  prev: string[] = [];
  constructor(
    readonly s: SmartCubeSession,
    start: CubieCube = new CubieCube(),
  ) {
    this.raw = start.clone();
  }
  /** a turn at local time `loc`; the cube's own clock runs 1% fast and 5 s ahead */
  turn(m: string, loc: number, puzzle: '333' | '222' = '333') {
    const mv = m.length === 1 ? m + ' ' : m;
    this.raw.move(mv);
    this.prev = [mv, ...this.prev].slice(0, 8);
    return this.s.state(this.raw.toFaceCube(), this.prev, [loc * 1.01 + 5000, loc], puzzle, loc);
  }
  /** the state as it connects */
  report() {
    return this.s.state(this.raw.toFaceCube(), [], [null, 0], '333', 0);
  }
  turns(alg: string, from: number, gap: number) {
    return alg.split(' ').map((m, i) => this.turn(m, from + i * gap));
  }
}

describe('smart cube timing (csTimer giiker.js)', () => {
  it('fits the cube clock to ours: times from the first turn', () => {
    const list: MoveTs[] = [0, 1, 2, 3].map((i) => [0, 1000 + i * 1010, 500 + i * 1000]);
    expect(tsLinearFix(list).map((m) => m[1])).toEqual([0, 1000, 2000, 3000]);
    // turns found again from the history have no device time: 50 ms from their neighbours
    const lost: MoveTs[] = [
      [0, 1000, 1000],
      [3, null, null],
      [6, 2000, 2000],
    ];
    expect(tsLinearFix(lost).map((m) => m[1])).toEqual([0, 950, 1000]);
  });

  it('marks it scrambled on the scramble, times from the first turn to the solving one', () => {
    const s = new SmartCubeSession();
    const hand = new Hand(s);
    s.hinter.setScramble("R U R' U'");
    const evs = hand.turns("R U R' U'", 1000, 300);
    expect(evs.slice(0, 3).every((e) => e.markIn === undefined)).toBe(true);
    expect(evs[3].markIn).toBe(0);
    expect(s.markScrambled(s.lastTime)).toBe(true);
    expect(s.phase).toBe('scrambled');
    // the solve: U R U' R' (inverse), first turn starts it
    const first = hand.turn('U', 5000);
    expect(first.started).toBe(true);
    expect(s.phase).toBe('running');
    hand.turn('R', 5400);
    hand.turn("U'", 5800);
    const done = hand.turn("R'", 6234);
    expect(done.solved).toEqual({ timeMs: 1234, penalty: 'OK' });
    expect(s.phase).toBe('idle');
  });

  it('gives +2 and DNF for a long inspection, and DNF on esc', () => {
    for (const [wait, penalty] of [
      [14000, 'OK'],
      [16000, '+2'],
      [18000, 'DNF'],
    ] as const) {
      const s = new SmartCubeSession();
      s.inspection = true;
      const hand = new Hand(s, scrambleCube("R U F'")!);
      hand.report();
      expect(s.markScrambled(1000)).toBe(true);
      hand.turn('F', 1000 + wait);
      hand.turn("U'", 1000 + wait + 200);
      expect(hand.turn("R'", 1000 + wait + 500).solved).toEqual({ timeMs: 500, penalty });
    }
    const s = new SmartCubeSession();
    const hand = new Hand(s, scrambleCube("R U F'")!);
    hand.report();
    s.markScrambled(0);
    hand.turn('F', 100);
    hand.turn('D', 900);
    expect(s.escape()).toEqual({ timeMs: 800, penalty: 'DNF' });
    expect(s.escape()).toBeNull();
  });

  it("doesn't keep a one-turn solve, and won't mark a solved cube scrambled", () => {
    const s = new SmartCubeSession();
    const hand = new Hand(s);
    expect(s.markScrambled(0)).toBe(false);
    hand.turn('R', 100);
    expect(s.markScrambled(100)).toBe(true);
    const r = hand.turn("R'", 500);
    expect(r.started).toBe(true);
    expect(r.solved).toBeUndefined();
    expect(s.phase).toBe('idle');
  });

  it('marks after a pause or after turning one face four times', () => {
    const s = new SmartCubeSession();
    const hand = new Hand(s);
    s.mark = '3';
    expect(hand.turn('R', 0).markIn).toBe(3000);
    s.mark = 'never';
    s.turnMark = 'x4';
    hand.turns('U U U', 100, 100);
    expect(hand.turn('U', 400).markIn).toBe(1000);
    s.turnMark = 'xi2';
    hand.turns("F F' F", 500, 100);
    expect(hand.turn("F'", 800).markIn).toBe(1000);
    s.turnMark = 'off';
    expect(hand.turn('D', 900).markIn).toBeUndefined();
  });

  it('reads the cube through its solved reading (a cube put together turned)', () => {
    const s = new SmartCubeSession();
    const off = scrambleCube("L2 D' B")!;
    const hand = new Hand(s, off);
    hand.report();
    expect(s.solved).toBe(false);
    const { reading } = s.markSolved(0);
    expect(reading).toBe(off.toFaceCube());
    expect(s.facelet).toBe(SOLVED_FACELET);
    hand.turn('R', 100);
    expect(s.facelet).toBe(scrambleCube('R')!.toFaceCube());
    // saved and read back on the next connect
    const t = new SmartCubeSession();
    t.setSolvedReading(reading);
    t.state(off.toFaceCube(), [], [null, 0], '333', 0);
    expect(t.solved).toBe(true);
  });

  it('knows a GAN cube by one name (its moves come as "name*")', () => {
    expect(cubeKey('GAN12 ui*')).toBe('GAN12 ui');
    expect(cubeKey('GAN12 ui')).toBe('GAN12 ui');
  });

  it('times a 2x2 by its corners', () => {
    const s = new SmartCubeSession();
    const hand = new Hand(s);
    s.hinter.setScramble("R U' F2");
    const evs = ["R", "U'", 'F2'].map((m, i) => hand.turn(m, i * 100, '222'));
    expect(evs[2].markIn).toBe(0);
    s.markScrambled(300);
    hand.turn('F2', 1000, '222');
    hand.turn('U', 1500, '222');
    expect(hand.turn("R'", 2000, '222').solved?.timeMs).toBe(1000);
  });
});

describe("the scramble line (csTimer's scrHinter)", () => {
  const hint = (h: ScrambleHinter, c: CubieCube) => h.check(c, false);

  it('follows the cube along the scramble, with what is left of a half-done turn', () => {
    const h = new ScrambleHinter();
    h.setScramble("R U2 F' D");
    expect(hint(h, new CubieCube()).hint).toMatchObject({ done: 0, rest: null, fix: false, pending: false });
    expect(hint(h, scrambleCube('R')!).hint).toMatchObject({ done: 1, rest: null });
    expect(hint(h, scrambleCube('R U')!).hint).toMatchObject({ done: 1, rest: 'U' });
    expect(hint(h, scrambleCube("R U'")!).hint).toMatchObject({ done: 1, rest: "U'" });
    expect(hint(h, scrambleCube("R U2 F")!).hint).toMatchObject({ done: 2, rest: 'F2' });
    expect(hint(h, scrambleCube("R U2 F' D")!).hint).toMatchObject({ done: 4 });
    expect(h.matches(scrambleCube("R U2 F' D")!, false)).toBe(true);
  });

  // movesBetween builds the two-phase solver's tables on first use (seconds; more with the whole suite
  // running), so this test gets the solver tests' allowance
  it('off the scramble, asks once for a way back and then follows it', () => {
    const h = new ScrambleHinter();
    h.setScramble("R U2 F' D");
    const wrong = scrambleCube('R L')!;
    const r = hint(h, wrong);
    expect(r.needFix).toBe(true);
    expect(r.hint?.pending).toBe(true);
    h.asked = wrong.clone();
    expect(hint(h, wrong).needFix).toBe(false);
    const way = movesBetween(wrong, h.target!)!;
    h.setFix(wrong, way);
    const steps = way.split(' ');
    expect(hint(h, wrong).hint).toMatchObject({ fix: true, done: 0, moves: steps });
    const c = wrong.clone();
    c.move(steps[0].length === 1 ? steps[0] + ' ' : steps[0]);
    expect(hint(h, c).hint).toMatchObject({ fix: true, done: 1 });
    for (const m of steps.slice(1)) c.move(m.length === 1 ? m + ' ' : m);
    // back on the scramble: the scramble shows done
    expect(hint(h, c).hint).toMatchObject({ fix: false, done: 4 });
  }, 30_000);

  it("has nothing to say for a scramble with turns a smart cube can't check", () => {
    const h = new ScrambleHinter();
    h.setScramble("Rw U x'");
    expect(hint(h, new CubieCube()).hint).toBeNull();
    expect(h.matches(new CubieCube(), false)).toBe(false);
  });
});

describe('the cube on screen', () => {
  const faces = (v: CubeView, s: Int16Array) => Array.from(s, (x) => v.model.twisty.puzzle.slots[x].face).join('');

  it('animates the latest turns and jumps when it can’t follow', () => {
    const v = new CubeView(3);
    const c = new CubieCube();
    c.move('R ');
    v.update(c.toFaceCube(), ['R ']);
    expect(v.queue.length).toBe(1);
    expect(faces(v, v.target)).toBe(faces(v, v.stateOf(c.toFaceCube())));
    // two turns at once (one found again from the history)
    c.move('U ');
    c.move("F'");
    v.update(c.toFaceCube(), ["F'", 'U ', 'R ']);
    expect(v.queue.length).toBe(3);
    expect(faces(v, v.target)).toBe(faces(v, v.stateOf(c.toFaceCube())));
    while (v.step(50));
    expect(faces(v, v.shown)).toBe(faces(v, v.target));
    // a state it can't get to from the latest turns
    const other = scrambleCube("D2 B L'")!;
    v.update(other.toFaceCube(), ['B ']);
    expect(v.queue.length).toBe(0);
    expect(faces(v, v.shown)).toBe(faces(v, v.stateOf(other.toFaceCube())));
  });

  it('draws a 2x2 from the corner stickers', () => {
    const v = new CubeView(2);
    const c = scrambleCube("R U'")!;
    v.update(c.toFaceCube(), ["U'", 'R ']);
    expect(v.queue.length).toBe(2);
    expect(faces(v, v.target)).toBe(faces(v, v.stateOf(c.toFaceCube())));
  });
});
