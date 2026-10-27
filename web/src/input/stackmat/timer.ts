// What the page's timer does with a stackmat (or MoYu timer): csTimer's timer/stackmat.js. The timer
// itself times the solve; the page follows it, adds WCA inspection (started with space, or by
// putting one hand on the mat while it reads zero) and records the time when the timer stops.
import type { Penalty } from '@cubetype/cubestats';
import type { StackmatState } from './decoder';

export type StackmatPhase = 'idle' | 'inspect-ready' | 'inspecting' | 'running';

export interface StackmatSolve {
  timeMs: number;
  penalty: Penalty;
}

export class StackmatTimer {
  phase: StackmatPhase = 'idle';
  /** the time on the timer (null: no signal) */
  hardTime: number | null = null;
  /** performance.now() at the start of inspection, or (while running) of the solve */
  startTime = 0;
  private inspectionTime = 0;
  last: StackmatState | null = null;
  inspection = false;

  /** a packet from the timer; returns a finished solve when the timer has just stopped */
  update(state: StackmatState, now: number): StackmatSolve | null {
    if (!state.on) {
      this.hardTime = null;
      this.phase = 'idle';
      this.last = state;
      return null;
    }
    this.hardTime = state.time_milli;
    if (state.running) {
      if (this.phase === 'inspecting' || this.phase === 'inspect-ready') this.inspectionTime = now - this.startTime - this.hardTime;
      this.phase = 'running';
      this.startTime = now - this.hardTime;
    } else if (this.phase === 'idle' && this.inspection && this.hardTime === 0 && (state.signalHeader === 'R' || state.signalHeader === 'L')) {
      // one hand on the mat with the timer at zero: inspection starts
      this.phase = 'inspecting';
      this.startTime = now;
    } else if (this.phase !== 'inspecting' && this.phase !== 'inspect-ready') {
      this.phase = 'idle';
    }
    let solve: StackmatSolve | null = null;
    if (this.last?.running && !state.running && state.time_milli !== 0) {
      const ins = this.inspection ? this.inspectionTime : 0;
      solve = { timeMs: this.hardTime, penalty: ins > 17000 ? 'DNF' : ins > 15000 ? '+2' : 'OK' };
      this.inspectionTime = 0;
    }
    this.last = state;
    return solve;
  }

  /** space down: get ready to inspect (only with the timer on and at zero) */
  spaceDown(now: number): boolean {
    if (this.phase === 'idle' && this.inspection && this.last?.on && this.last.time_milli === 0) {
      this.phase = 'inspect-ready';
      this.startTime = now;
      return true;
    }
    return false;
  }

  /** space up: inspection starts */
  spaceUp(now: number): boolean {
    if (this.phase === 'inspect-ready' && this.inspection) {
      this.phase = 'inspecting';
      this.startTime = now;
      return true;
    }
    return false;
  }

  /** esc: stop inspecting */
  escape(): boolean {
    if (this.phase === 'inspecting' || this.phase === 'inspect-ready') {
      this.phase = 'idle';
      return true;
    }
    return false;
  }
}
