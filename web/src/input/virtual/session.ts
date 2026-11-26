// A virtual solve, as csTimer runs one (timer/virtual.js): space scrambles the puzzle, inspection
// (or "ready") until the first move that isn't a rotation, which starts the timer; the move that
// solves it stops the timer at that key press. Esc gives up (a DNF while solving). Moves are applied
// to the state at once and animated after, csTimer's way: 100 ms a turn by default, quicker when
// moves queue up, parallel turns together.
import type { Penalty } from '@cubr/cubestats';
import type { VirtualModel } from './models';

export type VirtualPhase = 'idle' | 'inspecting' | 'ready' | 'running';

export interface Animation {
  move: unknown;
  progress: number;
}

export interface VirtualResult {
  timeMs: number;
  penalty: Penalty;
  moves: number;
}

const INSPECTION = 15_000;

/** a model with its state and move types forgotten: the session only passes them back to it */
interface Ops {
  solved(): unknown;
  apply(s: unknown, m: unknown): unknown;
  allowed(s: unknown, m: unknown): boolean;
  isSolved(s: unknown): boolean;
  isRotation(m: unknown): boolean;
  parse(alg: string): unknown[] | null;
  key(code: string): { move: unknown } | { depth: true } | null;
  parallel(a: unknown, b: unknown): boolean;
  countKey(m: unknown): string | null;
}

const ops = (m: VirtualModel) => m as unknown as Ops;

export class VirtualSession {
  model: VirtualModel;
  /** the state with every move applied */
  target: unknown;
  /** what is drawn: the state before the moves still being animated */
  shown: unknown;
  queue: { move: unknown }[] = [];
  active: Animation[] = [];
  phase: VirtualPhase = 'idle';
  startedAt: number | null = null;
  inspectionStartedAt: number | null = null;
  penalty: Penalty = 'OK';
  moves = 0;
  private lastCount: string | null = null;
  /** ms per turn; 0 = no animation */
  speed: number;
  /** blindfolded events: the colours are hidden while solving */
  blind: boolean;
  inspection: boolean;
  /** what went wrong with the last scramble (one the puzzle couldn't read) */
  error: string | null = null;
  private listeners = new Set<() => void>();

  constructor(model: VirtualModel, opts: { speed: number; blind: boolean; inspection: boolean }) {
    this.model = model;
    this.target = model.solved();
    this.shown = this.target;
    this.speed = opts.speed;
    this.blind = opts.blind;
    this.inspection = opts.inspection;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** start a solve: the puzzle scrambled, inspection (or ready) */
  scramble(alg: string, now: number): boolean {
    const m = ops(this.model);
    const moves = m.parse(alg);
    if (!moves) {
      this.error = "this scramble can't be read by the virtual puzzle";
      this.emit();
      return false;
    }
    let s = m.solved();
    for (const mv of moves) s = m.apply(s, mv);
    this.error = null;
    this.target = s;
    this.shown = s;
    this.queue = [];
    this.active = [];
    this.moves = 0;
    this.lastCount = null;
    if (this.model.kind === 'poly') this.model.twisty.resetDepth();
    this.phase = this.inspection ? 'inspecting' : 'ready';
    this.inspectionStartedAt = this.inspection ? now : null;
    this.startedAt = null;
    this.penalty = 'OK';
    this.emit();
    return true;
  }

  /** back to a solved puzzle, nothing running */
  reset() {
    this.target = ops(this.model).solved();
    this.shown = this.target;
    this.queue = [];
    this.active = [];
    this.phase = 'idle';
    this.startedAt = null;
    this.inspectionStartedAt = null;
    this.emit();
  }

  /** a key while scrambled or solving; returns a finished solve, if this move solved it */
  key(code: string, now: number): { solved?: VirtualResult; used: boolean } {
    if (this.phase === 'idle') return { used: false };
    const r = ops(this.model).key(code);
    if (!r) return { used: false };
    if ('depth' in r) {
      if (this.model.kind === 'poly') this.model.twisty.pressDepth(code);
      this.emit();
      return { used: true };
    }
    return this.move(r.move, now);
  }

  /** a move made on the puzzle (keyboard, touch) */
  move(mv: unknown, now: number): { solved?: VirtualResult; used: boolean } {
    const m = ops(this.model);
    if (this.phase === 'idle' || !m.allowed(this.target, mv)) return { used: false };
    if (this.phase !== 'running' && !m.isRotation(mv)) {
      this.startedAt = now;
      this.penalty = 'OK';
      if (this.inspectionStartedAt !== null) {
        const used = now - this.inspectionStartedAt;
        this.penalty = used > INSPECTION + 2000 ? 'DNF' : used > INSPECTION ? '+2' : 'OK';
      }
      this.phase = 'running';
    }
    this.target = m.apply(this.target, mv);
    const ck = m.countKey(mv);
    if (this.phase === 'running' && ck !== null && ck !== this.lastCount) this.moves++;
    if (ck !== null) this.lastCount = ck;
    if (this.speed <= 0) this.shown = this.target;
    else this.queue.push({ move: mv });
    let solved: VirtualResult | undefined;
    if (this.phase === 'running' && m.isSolved(this.target) && this.startedAt !== null) {
      solved = { timeMs: Math.max(1, Math.round(now - this.startedAt)), penalty: this.penalty, moves: this.moves };
      this.phase = 'idle';
      this.inspectionStartedAt = null;
    }
    this.emit();
    return { used: true, solved };
  }

  /** give up: a DNF if the solve had started */
  escape(now: number): VirtualResult | null {
    if (this.phase === 'idle') return null;
    const running = this.phase === 'running' && this.startedAt !== null;
    const result = running ? { timeMs: Math.max(1, Math.round(now - this.startedAt!)), penalty: 'DNF' as Penalty, moves: this.moves } : null;
    this.reset();
    return result;
  }

  /** advance the animation by dt ms; true while anything is still moving */
  step(dt: number): boolean {
    const m = ops(this.model);
    if (this.speed <= 0) {
      this.queue = [];
      this.active = [];
      this.shown = this.target;
      return false;
    }
    // start the next moves: one at a time, or several parallel ones together
    if (this.active.length === 0 && this.queue.length > 0) this.active.push({ move: this.queue.shift()!.move, progress: 0 });
    while (this.queue.length > 0 && this.active.every((a) => m.parallel(a.move, this.queue[0].move)))
      this.active.push({ move: this.queue.shift()!.move, progress: 0 });
    if (this.active.length === 0) return false;
    // csTimer: quicker the more moves are waiting
    const inc = Math.min(1, Math.max(0.0001, (dt / this.speed) * ((this.queue.length + 2) / 2)));
    for (const a of this.active) a.progress += inc;
    if (this.active[0].progress >= 1) {
      for (const a of this.active) this.shown = m.apply(this.shown, a.move);
      this.active = [];
    }
    return true;
  }

  /** colours are hidden (blindfolded events, while solving) */
  get hidden(): boolean {
    return this.blind && this.phase === 'running';
  }
}
