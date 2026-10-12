// The speedcubing timer state machine (keyboard), modelled on csTimer.
//
//   idle ──press──▶ holding ──(holdMs)──▶ ready ──release──▶ running ──any key──▶ stopped ──release──▶ idle
//                      └──release early──▶ idle
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Penalty } from '@cubetype/cubestats';

export type TimerPhase = 'idle' | 'holding' | 'ready' | 'running' | 'stopped';

export interface TimerResult {
  timeMs: number;
  penalty: Penalty;
}

export interface TimerState {
  phase: TimerPhase;
  /** performance.now() timestamp the solve started */
  startedAt: number | null;
  /** last completed solve */
  result: TimerResult | null;
}

export interface TimerEngineOptions {
  /** disable when a modal is open, the page is inactive, … */
  enabled: boolean;
  holdMs: number;
  onSolve: (r: TimerResult) => void;
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab']);
/** stop events this soon after the start are ignored (accidental double press), like csTimer */
const MIN_RUN_MS = 150;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

const now = (e?: { timeStamp: number }) => (e && e.timeStamp > 0 ? e.timeStamp : performance.now());

/**
 * Timer engine hook. Attaches window keyboard listeners (space starts/stops, any key stops).
 * State only changes on transitions; the display component animates elapsed time itself with
 * requestAnimationFrame.
 */
export function useTimerEngine(opts: TimerEngineOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [state, setState] = useState<TimerState>({
    phase: 'idle',
    startedAt: null,
    result: null,
  });
  const st = useRef(state);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keysDown = useRef(new Set<string>());

  const publish = useCallback((patch: Partial<TimerState>) => {
    st.current = { ...st.current, ...patch };
    setState(st.current);
  }, []);

  const clearHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  /** press = space keydown */
  const press = useCallback(
    (t: number) => {
      const s = st.current;
      if (s.phase === 'running') return; // handled by stop()
      if (s.phase === 'stopped') return;
      if (s.phase === 'idle') {
        const hold = optsRef.current.holdMs;
        if (hold <= 0) {
          publish({ phase: 'ready' });
        } else {
          publish({ phase: 'holding' });
          clearHold();
          holdTimer.current = setTimeout(() => {
            if (st.current.phase === 'holding') publish({ phase: 'ready' });
          }, hold);
        }
      }
    },
    [publish],
  );

  /** release = space keyup */
  const release = useCallback(
    (t: number) => {
      const s = st.current;
      clearHold();
      if (s.phase === 'stopped') {
        if (keysDown.current.size === 0) publish({ phase: 'idle' });
        return;
      }
      if (s.phase === 'holding') {
        publish({ phase: 'idle' });
        return;
      }
      if (s.phase === 'ready') {
        // solve starts now
        document.activeElement instanceof HTMLElement && document.activeElement.blur();
        publish({ phase: 'running', startedAt: t });
      }
    },
    [publish],
  );

  const stop = useCallback(
    (t: number) => {
      const s = st.current;
      if (s.phase !== 'running' || s.startedAt === null) return;
      if (t - s.startedAt < MIN_RUN_MS) return;
      const timeMs = Math.max(1, Math.round(t - s.startedAt));
      const result: TimerResult = { timeMs, penalty: 'OK' };
      publish({ phase: 'stopped', result });
      optsRef.current.onSolve(result);
    },
    [publish],
  );

  const cancel = useCallback(() => {
    clearHold();
    const s = st.current;
    if (s.phase === 'running') return;
    if (s.phase !== 'idle') {
      publish({ phase: 'idle', startedAt: null });
    }
  }, [publish]);

  const gateOpen = () => optsRef.current.enabled;

  // keyboard ------------------------------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!gateOpen()) return;
      if (isTypingTarget(e.target)) return;
      const s = st.current;
      if (s.phase === 'running') {
        if (MODIFIERS.has(e.key) && e.key !== 'Tab') return;
        e.preventDefault();
        keysDown.current.add(e.code);
        stop(now(e));
        return;
      }
      if (e.code !== 'Space') return;
      e.preventDefault();
      if (e.repeat) return;
      keysDown.current.add(e.code);
      press(now(e));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysDown.current.delete(e.code);
      if (!gateOpen()) return;
      const s = st.current;
      if (s.phase === 'stopped') {
        if (keysDown.current.size === 0) publish({ phase: 'idle' });
        return;
      }
      if (e.code !== 'Space') return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      release(now(e));
    };
    const onBlur = () => {
      keysDown.current.clear();
      if (st.current.phase === 'holding' || st.current.phase === 'ready') {
        clearHold();
        publish({ phase: 'idle' });
      }
      if (st.current.phase === 'stopped') publish({ phase: 'idle' });
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [press, release, stop, publish]);

  // cleanup timers on unmount; cancel if disabled mid-way
  useEffect(() => () => {
    clearHold();
  }, []);
  useEffect(() => {
    if (!opts.enabled && st.current.phase !== 'running') cancel();
  }, [opts.enabled, cancel]);

  return { state, cancel };
}
