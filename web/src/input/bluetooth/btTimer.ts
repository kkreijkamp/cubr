// What the page's timer does with a bluetooth timer: csTimer's timer/bttimer.js. The timer times the
// solve; the page follows it, adds inspection (space, or the GAN timer's reset button while it
// reads zero) and records the time the timer stopped at.
import type { Penalty } from '@cubetype/cubestats';
import { TimerEvent, type TimerEventData } from './timers';

export type BtTimerPhase = 'idle' | 'inspect-ready' | 'inspecting' | 'running';

export class BtTimerState {
  phase: BtTimerPhase = 'idle';
  hardTime: number | null = null;
  startTime = 0;
  /** hands on (red) / ready (green) */
  light: 'none' | 'red' | 'green' = 'none';
  inspection = false;
  connected = false;
  private penalty: Penalty = 'OK';
  private lastStop: { time: number; at: number } | null = null;

  /** an event from the timer; returns a finished solve */
  handle(e: TimerEventData, now: number): { timeMs: number; penalty: Penalty } | null {
    switch (e.state) {
      case TimerEvent.HANDS_ON:
        this.light = 'red';
        return null;
      case TimerEvent.HANDS_OFF:
        this.light = 'none';
        return null;
      case TimerEvent.GET_SET:
        this.light = 'green';
        return null;
      case TimerEvent.GAN_RESET:
      case TimerEvent.IDLE:
        this.light = 'none';
        this.penalty = 'OK';
        if ((this.hardTime ?? 0) > 0 || this.phase !== 'idle') {
          // reset button: back to zero, inspection cancelled
          this.hardTime = 0;
          this.phase = 'idle';
        } else if (this.inspection && e.state === TimerEvent.GAN_RESET) {
          this.phase = 'inspecting';
          this.startTime = now;
        }
        return null;
      case TimerEvent.RUNNING: {
        this.light = 'none';
        this.penalty = 'OK';
        if (this.phase === 'inspecting' && this.inspection) {
          const used = now - this.startTime;
          this.penalty = used > 17000 ? 'DNF' : used > 15000 ? '+2' : 'OK';
        }
        this.startTime = now - (e.solveTime ?? 0);
        this.phase = 'running';
        return null;
      }
      case TimerEvent.STOPPED: {
        this.light = 'none';
        const wasRunning = this.phase === 'running';
        this.hardTime = e.solveTime ?? 0;
        this.phase = 'idle';
        const t = this.hardTime;
        // a timer that repeats its stop (or sends both of its stop messages) is one solve
        const repeat = !wasRunning && this.lastStop !== null && this.lastStop.time === t && now - this.lastStop.at < 3000;
        if (t <= 0 || repeat) return null;
        this.lastStop = { time: t, at: now };
        const solve = { timeMs: t, penalty: this.penalty };
        this.penalty = 'OK';
        return solve;
      }
      case TimerEvent.DISCONNECT:
        this.hardTime = null;
        this.phase = 'idle';
        this.light = 'none';
        this.connected = false;
        return null;
      default:
        return null;
    }
  }

  spaceDown(now: number): boolean {
    if (this.phase === 'idle' && this.inspection && this.connected && !this.hardTime) {
      this.phase = 'inspect-ready';
      this.startTime = now;
      return true;
    }
    return false;
  }

  spaceUp(now: number): boolean {
    if (this.phase === 'inspect-ready' && this.inspection && this.connected && !this.hardTime) {
      this.phase = 'inspecting';
      this.startTime = now;
      return true;
    }
    return false;
  }

  escape(): boolean {
    if (this.phase === 'inspecting' || this.phase === 'inspect-ready') {
      this.phase = 'idle';
      return true;
    }
    return false;
  }
}
