import { describe, expect, it } from 'vitest';
import { modelFor } from '../virtual/models';
import { VirtualSession } from '../virtual/session';

const session = (event: string, inspection = false) => new VirtualSession(modelFor(event)!, { speed: 100, blind: false, inspection });

describe('a virtual solve (csTimer virtual.js)', () => {
  it('space scrambles; the first turn starts the timer and the solving turn stops it, at that key press', () => {
    const s = session('333');
    expect(s.phase).toBe('idle');
    // keys do nothing until it is scrambled
    expect(s.key('KeyI', 0).used).toBe(false);
    expect(s.scramble('R U', 1000)).toBe(true);
    expect(s.phase).toBe('ready');
    expect(s.key('KeyF', 1500).used).toBe(true); // U'
    expect(s.phase).toBe('running');
    expect(s.startedAt).toBe(1500);
    const done = s.key('KeyK', 2734); // R'
    expect(done.solved).toEqual({ timeMs: 1234, penalty: 'OK', moves: 2 });
    expect(s.phase).toBe('idle');
  });

  it('rotations during inspection do not start it', () => {
    const s = session('333');
    s.scramble("x y'", 0);
    expect(s.key('Semicolon', 10).used).toBe(true); // y
    expect(s.phase).toBe('ready');
    s.key('KeyT', 20); // x
    expect(s.phase).toBe('ready');
    // x y' undone by the y then... x x' brings it back: the puzzle counts as solved in any orientation, but the solve hasn't started
    expect(s.startedAt).toBeNull();
  });

  it('inspection: over 15 seconds is +2, over 17 a DNF', () => {
    for (const [wait, penalty] of [
      [14_000, 'OK'],
      [15_500, '+2'],
      [17_500, 'DNF'],
    ] as const) {
      const s = session('333', true);
      s.scramble('R', 0);
      expect(s.phase).toBe('inspecting');
      const r = s.key('KeyK', wait); // R' solves it at once
      expect(r.solved?.penalty, String(wait)).toBe(penalty);
    }
  });

  it('esc while solving is a DNF; while inspecting it just stops', () => {
    const s = session('333');
    s.scramble("R U F'", 0);
    expect(s.escape(100)).toBeNull();
    expect(s.phase).toBe('idle');
    s.scramble("R U F'", 0);
    s.key('KeyI', 1000);
    expect(s.escape(3000)).toEqual({ timeMs: 2000, penalty: 'DNF', moves: 1 });
  });

  it('counts turns like csTimer: one layer turned twice in a row is one move', () => {
    const s = session('333');
    s.scramble('R2 U', 0);
    s.key('KeyF', 10); // U'
    s.key('KeyK', 20); // R'
    const r = s.key('KeyK', 30); // R' again: R2 undone
    expect(r.solved?.moves).toBe(2);
  });

  it('square-1 will not slash with a corner across the cut', () => {
    const s = session('sq1');
    s.scramble('(1,0)', 0);
    // (1,0) leaves the cut clear; one more top turn puts a corner across it
    expect(s.key('KeyJ', 10).used).toBe(true);
    expect(s.key('KeyI', 20).used).toBe(false);
    expect(s.key('KeyF', 30).used).toBe(true);
    expect(s.key('KeyI', 40).used).toBe(true);
  });

  it('animates queued moves, together when they are parallel', () => {
    const s = session('333');
    s.scramble('R L', 0);
    s.key('KeyK', 10); // R'
    s.key('KeyE', 20); // L'
    s.step(16);
    // R and L are on one axis: both turn at once
    expect(s.active).toHaveLength(2);
    for (let i = 0; i < 20; i++) s.step(16);
    expect(s.active).toHaveLength(0);
    expect(s.shown).toEqual(s.target);
  });

  it("every event's scramble format starts a solve", () => {
    const scrambles: Record<string, string> = {
      '333': "F' B' D' B2 R F' U L D' B' L U' L2 F2",
      '222': "U2 R' F2 U' R U F'",
      '444': "Rw2 U' R2 Fw2 Uw2 R L U' R' D L' D Fw' U2",
      '777': "3Bw2 Uw 3Fw2 Bw Rw2 3Bw2 D' 3Dw' R B2 3Rw'",
      '333bf': 'F L U D L2 B R F2 Dw',
      '444bf': "L F D2 R F D Rw2 Uw2 z'",
      clock: 'U5- R4- D6+ L4+ ALL5+ UR4- DR3- DL1+ UL1+ y2 U2- R2- D3+ L3+ ALL3-',
      minx: "R-- D++ R-- D++ R++ D-- R-- D-- R++ D-- U'\nR-- D-- R++ D-- R-- D-- R-- D++ R-- D-- U'",
      pyram: "L R L U' R' L' U R' U' r l'",
      skewb: "U L' U B' U' L' R L R' U B'",
      sq1: '(0, 5) / (3, 0) / (-2, 4) / (3, 0) / (-3, 0) / (0, 3)',
    };
    for (const [event, scr] of Object.entries(scrambles)) {
      const s = session(event);
      expect(s.scramble(scr, 0), event).toBe(true);
      expect(s.error, event).toBeNull();
      expect(s.model.isSolved(s.target as never), event).toBe(false);
    }
  });
});
