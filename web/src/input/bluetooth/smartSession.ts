// A smart cube on the timer page: csTimer's tools/bluetoothutil.js (calibration, move times, the
// scramble hints) and timer/giiker.js (when a solve starts and stops). The cube counts as scrambled
// when it matches the scramble (or after a pause, a few turns of one face, or space); inspection
// runs from then; the first turn starts the timer and the turn that solves it stops it. The time is
// the cube's own timestamps of those two turns, fitted to the local clock.
import type { Penalty } from '@cubetype/cubestats';
import { CubieCube, isFaceletSolved, moveIndex, moveName, MOVE_CUBE, SOLVED_FACELET } from '../cube/cubie';

export type SmartPhase = 'idle' | 'scrambled' | 'running';
export type SmartPuzzle = '333' | '222';
/** csTimer giiSD: when the cube matches the scramble, after that many seconds without a turn, or only by key */
export type MarkMode = 'scramble' | '2' | '3' | '4' | '5' | 'never';
/** csTimer giiSM: one face turned four times the same way, or back and forth */
export type TurnMark = 'off' | 'x4' | 'xi2';

/** [move 0..17, device time, local time] */
export type MoveTs = [number, number | null, number | null];

/** a straight-line fit of local time against device time: [slope, intercept] (csTimer tsLinearFit) */
export function tsLinearFit(list: MoveTs[]): [number, number] {
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let n = 0;
  for (const [, x, y] of list) {
    if (x === null || y === null) continue;
    n++;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const varX = n * sumXX - sumX * sumX;
  const covXY = n * sumXY - sumX * sumY;
  const slope = varX < 1e-3 ? 1 : covXY / varX;
  const intercept = n < 1 ? 0 : sumY / n - (slope * sumX) / n;
  return [slope, intercept];
}

/** turns that came back from a cube's history have no device time: put them 50 ms from their neighbours */
function tsApplyFixes(list: MoveTs[]): MoveTs[] {
  if (list.length >= 2) {
    for (let i = list.length - 1; i > 0; i--) if (list[i][1] !== null && list[i - 1][1] === null) list[i - 1][1] = list[i][1]! - 50;
    for (let i = 0; i < list.length - 1; i++) if (list[i][1] !== null && list[i + 1][1] === null) list[i + 1][1] = list[i][1]! + 50;
  }
  return list;
}

/** each turn's time from the first turn, on the local clock (csTimer tsLinearFix) */
export function tsLinearFix(input: MoveTs[]): MoveTs[] {
  if (input.length === 0) return input;
  const list = tsApplyFixes(input.map((m) => [...m] as MoveTs));
  const [slope, intercept] = tsLinearFit(list);
  const first = Math.round(slope * list[0][1]! + intercept);
  return list.map((m) => [m[0], Math.round(slope * m[1]! + intercept) - first, m[2]]);
}

/** face turns of a scramble as 0..17; null if it has wide or slice turns the cube can't be checked against */
export function parseFaceTurns(scramble: string): number[] | null {
  const out: number[] = [];
  for (const t of scramble.split(/\s+/).filter(Boolean)) {
    const m = /^([URFDLB])(2|')?$/.exec(t);
    if (!m) return null;
    out.push(moveIndex(m[1] + (m[2] ?? ' ')));
  }
  return out;
}

const same = (a: CubieCube, b: CubieCube, corners: boolean) => (corners ? a.cornersEqual(b) : a.isEqual(b));
const turn = (c: CubieCube, m: number) => CubieCube.mult(c, MOVE_CUBE[m], new CubieCube());

/**
 * How far along `seq` (started from `from`) the cube is: the number of turns done, and the part of
 * the next one already done (U of a U2); null when it's off the sequence (csTimer checkInSeq).
 */
export function progressIn(state: CubieCube, from: CubieCube | null, seq: number[], corners: boolean): { done: number; partial: number | null } | null {
  let c = from ? from.clone() : new CubieCube();
  let next = -1;
  let partial: number | null = null;
  if (same(c, state, corners)) next = 0;
  for (let i = 0; i < seq.length; i++) {
    const face = Math.floor(seq[i] / 3) * 3;
    for (let pow = 0; pow < 3; pow++) {
      if (same(turn(c, face + pow), state, corners)) {
        if (face + pow === seq[i]) next = i + 1;
        else {
          next = i;
          partial = pow;
        }
        break;
      }
    }
    if (next === i) break;
    c = turn(c, seq[i]);
  }
  if (next < 0) return null;
  return { done: next, partial: next < seq.length ? partial : null };
}

/** what the scramble line shows with a smart cube: the turns, how many are done, and what's left of the current one */
export interface ScrambleHint {
  moves: string[];
  done: number;
  /** what's left to do of turn `done` when it's half done (U where the scramble said U2) */
  rest: string | null;
  /** the cube went off the scramble: these turns lead back onto it */
  fix: boolean;
  /** off the scramble, the way back is still being worked out */
  pending: boolean;
}

const text = (m: number) => moveName(m).trim();

/** the turn still to do when `donePow` of turn `m` is done */
function restOf(m: number, donePow: number): string {
  const need = (m % 3) + 1;
  const rest = (need - (donePow + 1) + 4) % 4;
  return text(Math.floor(m / 3) * 3 + rest - 1);
}

/** csTimer's scrHinter: follows the cube along the scramble, and along a way back when it goes off it */
export class ScrambleHinter {
  private seq: number[] | null = null;
  /** the scrambled state (face turns of the scramble applied to a solved cube) */
  target: CubieCube | null = null;
  private fixFrom: CubieCube | null = null;
  private fixSeq: number[] | null = null;
  /** the state a way back was asked for, so it's asked once */
  asked: CubieCube | null = null;

  setScramble(scramble: string | null) {
    this.seq = scramble ? parseFaceTurns(scramble) : null;
    this.target = null;
    if (this.seq) {
      let c = new CubieCube();
      for (const m of this.seq) c = turn(c, m);
      this.target = c;
    }
    this.fixFrom = this.fixSeq = this.asked = null;
  }

  matches(cube: CubieCube, corners: boolean): boolean {
    return this.target !== null && same(this.target, cube, corners);
  }

  /** a way back onto the scramble worked out from `from` */
  setFix(from: CubieCube, moves: string) {
    const seq = parseFaceTurns(moves);
    if (!seq) return;
    this.fixFrom = from.clone();
    this.fixSeq = seq;
    this.asked = null;
  }

  /** the hint for this state; `needFix` when the cube is off the scramble and there's no way back yet */
  check(cube: CubieCube, corners: boolean): { hint: ScrambleHint | null; needFix: boolean } {
    if (!this.seq || !this.target) return { hint: null, needFix: false };
    if (this.fixFrom && this.fixSeq) {
      const p = progressIn(cube, this.fixFrom, this.fixSeq, corners);
      if (p && p.done < this.fixSeq.length) return { hint: this.hint(this.fixSeq, p, true), needFix: false };
      this.fixFrom = this.fixSeq = null;
    }
    const p = progressIn(cube, null, this.seq, corners);
    if (p) return { hint: this.hint(this.seq, p, false), needFix: false };
    const needFix = !(this.asked && same(this.asked, cube, corners));
    return { hint: { moves: this.seq.map(text), done: 0, rest: null, fix: false, pending: true }, needFix };
  }

  private hint(seq: number[], p: { done: number; partial: number | null }, fix: boolean): ScrambleHint {
    return { moves: seq.map(text), done: p.done, rest: p.partial !== null ? restOf(seq[p.done], p.partial) : null, fix, pending: false };
  }
}

/** which cube a state is from: GAN gen2+ report their moves as "name*" (csTimer's mark of the newer protocols) */
export const cubeKey = (name: string) => name.replace(/\*$/, '');

export interface SmartSolve {
  timeMs: number;
  penalty: Penalty;
}

export interface SmartEvent {
  /** the solve started (the first turn after being scrambled) */
  started?: boolean;
  /** the solve finished, or was given up (esc, a DNF) */
  solved?: SmartSolve;
  /** mark the cube scrambled after this many ms without another turn (0: now) */
  markIn?: number;
}

export class SmartCubeSession {
  /** the cube's own reading (it may differ from ours when the cube was put together turned) */
  raw = new CubieCube();
  /** the inverse of the raw reading marked solved */
  private solvedInv = new CubieCube();
  /** the cube as we read it: solvedInv * raw */
  cube = new CubieCube();
  facelet = SOLVED_FACELET;
  puzzle: SmartPuzzle = '333';
  phase: SmartPhase = 'idle';
  /** local time of being marked scrambled (inspection starts), then of the first turn */
  startTime = 0;
  inspection = false;
  mark: MarkMode = 'scramble';
  turnMark: TurnMark = 'off';
  readonly hinter = new ScrambleHinter();
  /** the local time of the latest state */
  lastTime = 0;
  private penalty: Penalty = 'OK';
  private solveMoves: MoveTs[] = [];

  /** calibrate from a saved solved reading */
  setSolvedReading(facelet: string | null) {
    const c = facelet ? new CubieCube().fromFacelet(facelet) : null;
    this.solvedInv = c ? new CubieCube().invFrom(c) : new CubieCube();
    this.update();
  }

  /** mark the cube solved as it is now (csTimer markSolved); returns the raw reading to save */
  markSolved(now: number): { reading: string; event: SmartEvent } {
    this.solvedInv = new CubieCube().invFrom(this.raw);
    this.update();
    return { reading: this.raw.toFaceCube(), event: this.step([], [null, now], now) };
  }

  private update() {
    CubieCube.mult(this.solvedInv, this.raw, this.cube);
    this.facelet = this.cube.toFaceCube();
  }

  get solved(): boolean {
    return isFaceletSolved(this.facelet, this.puzzle === '222');
  }

  /** the cube matches the scramble shown */
  matchesScramble(): boolean {
    return this.hinter.matches(this.cube, this.puzzle === '222');
  }

  /** a state from the cube: raw facelets, its latest turns (newest first), [device, local] time of the newest */
  state(facelet: string, prevMoves: string[], ts: [number | null, number | null], puzzle: SmartPuzzle, now: number): SmartEvent {
    this.puzzle = puzzle;
    if (!this.raw.fromFacelet(facelet)) return {};
    this.update();
    return this.step(prevMoves, ts, now);
  }

  private step(prevMoves: string[], ts: [number | null, number | null], now: number): SmartEvent {
    const loc = ts[1] ?? now;
    this.lastTime = loc;
    const out: SmartEvent = {};
    if (this.phase === 'idle') {
      if (!this.solved) {
        if (this.mark === 'scramble') {
          if (this.matchesScramble()) out.markIn = 0;
        } else if (this.mark !== 'never') out.markIn = Number(this.mark) * 1000;
        const recent = prevMoves.join('');
        const re = this.turnMark === 'x4' ? /^([URFDLB][ '])\1\1\1/ : this.turnMark === 'xi2' ? /^([URFDLB])( \1'\1 \1'|'\1 \1'\1 )/ : null;
        if (re?.test(recent)) out.markIn = Math.min(out.markIn ?? 1000, 1000);
      }
      return out;
    }
    if (this.phase === 'scrambled') {
      const used = this.inspection ? loc - this.startTime : 0;
      this.penalty = used > 17000 ? 'DNF' : used > 15000 ? '+2' : 'OK';
      this.startTime = loc;
      this.phase = 'running';
      this.solveMoves = [];
      out.started = true;
    }
    if (prevMoves.length > 0) this.solveMoves.push([moveIndex(prevMoves[0]), ts[0], ts[1]]);
    if (this.solved) {
      this.phase = 'idle';
      // a solve of one turn has no time between turns and isn't kept (as csTimer)
      if (loc - this.startTime !== 0) out.solved = { timeMs: this.fittedTime(), penalty: this.penalty };
    }
    return out;
  }

  /** the time from the first turn to the last, from the cube's clock fitted to ours */
  private fittedTime(): number {
    const fixed = tsLinearFix(this.solveMoves);
    return Math.max(1, fixed.length ? fixed[fixed.length - 1][1]! : 0);
  }

  /** the cube is scrambled: inspection (or ready) until the first turn */
  markScrambled(now: number): boolean {
    if (this.phase !== 'idle' || this.solved) return false;
    this.phase = 'scrambled';
    this.startTime = now;
    return true;
  }

  /** esc: a DNF while solving (timed to the last turn), otherwise back to waiting for a scramble */
  escape(): SmartSolve | null {
    if (this.phase === 'idle') return null;
    const running = this.phase === 'running';
    this.phase = 'idle';
    return running ? { timeMs: this.fittedTime(), penalty: 'DNF' } : null;
  }
}
