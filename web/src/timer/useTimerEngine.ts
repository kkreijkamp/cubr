// The speedcubing timer state machine (keyboard + touch), modelled on csTimer with WCA rules.
//   Esc: cancels holding/ready/inspection; while running it stops the solve as a DNF.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Penalty } from '@cubetype/cubestats';

export type TimerPhase = 'idle' | 'holding' | 'ready' | 'inspecting' | 'running' | 'stopped';

export interface TimerResult {
  timeMs: number;
  penalty: Penalty;
}

export interface TimerState {
  phase: TimerPhase;
  /** true while holding/ready happen during an inspection countdown */
  inInspection: boolean;
  /** performance.now() timestamp the solve started */
  startedAt: number | null;
  /** performance.now() timestamp inspection started */
  inspectionStartedAt: number | null;
  /** last completed solve */
  result: TimerResult | null;
}

export interface TimerEngineOptions {
  /** disable when a modal is open, the page is inactive, a race round isn't running, ... */
  enabled: boolean;
  inspection: boolean;
  holdMs: number;
  alerts: 'off' | 'beep' | 'voice';
  onSolve: (r: TimerResult) => void;
  onStart?: () => void;
  onInspectionStart?: () => void;
  onCancel?: () => void;
}

export const INSPECTION_MS = 15_000;
const PLUS2_AT = 15_000;
const DNF_AT = 17_000;
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab']);
/** stop events this soon after the start are ignored (accidental double press / double tap), like csTimer */
const MIN_RUN_MS = 150;

export function inspectionPenalty(elapsedMs: number): Penalty {
  if (elapsedMs >= DNF_AT) return 'DNF';
  if (elapsedMs >= PLUS2_AT) return '+2';
  return 'OK';
}

// ---- inspection alerts (8 s / 12 s) ------------------------------------------------------------
let audioCtx: AudioContext | null = null;
export function beep(freq: number) {
  try {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.25);
  } catch {
    /* audio not available */
  }
}
/** the judge's "8 seconds" / "12 seconds" call during inspection (every input mode uses it) */
export function alertAt(seconds: 8 | 12, mode: TimerEngineOptions['alerts']) {
  if (mode === 'beep') beep(seconds === 8 ? 660 : 880);
  else if (mode === 'voice' && 'speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(seconds === 8 ? 'eight seconds' : 'twelve seconds');
    u.rate = 1.3;
    window.speechSynthesis.speak(u);
  }
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function blockedByOverlay(): boolean {
  return Boolean(document.querySelector('.modal-backdrop'));
}

const now = (e?: { timeStamp: number }) => (e && e.timeStamp > 0 ? e.timeStamp : performance.now());

/**
 * Timer engine hook. Attaches window keyboard listeners (space starts/stops, any key stops) and
 * returns pointer handlers for touch devices. State only changes on transitions; the display
 * component animates elapsed time itself with requestAnimationFrame.
 */
export function useTimerEngine(opts: TimerEngineOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [state, setState] = useState<TimerState>({
    phase: 'idle',
    inInspection: false,
    startedAt: null,
    inspectionStartedAt: null,
    result: null,
  });
  const st = useRef(state);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alertTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const keysDown = useRef(new Set<string>());

  const publish = useCallback((patch: Partial<TimerState>) => {
    st.current = { ...st.current, ...patch };
    setState(st.current);
  }, []);

  const clearHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  const clearAlerts = () => {
    alertTimers.current.forEach(clearTimeout);
    alertTimers.current = [];
  };

  const startInspection = useCallback(
    (t: number) => {
      publish({ phase: 'inspecting', inInspection: true, inspectionStartedAt: t, startedAt: null });
      const mode = optsRef.current.alerts;
      if (mode !== 'off') {
        alertTimers.current = [setTimeout(() => alertAt(8, mode), 8000), setTimeout(() => alertAt(12, mode), 12000)];
      }
      optsRef.current.onInspectionStart?.();
    },
    [publish],
  );

  /** press = space keydown / touch start */
  const press = useCallback(
    (t: number) => {
      const s = st.current;
      if (s.phase === 'running') return; // handled by stop()
      if (s.phase === 'stopped') return;
      if (s.phase === 'idle' && optsRef.current.inspection) {
        // first press with inspection on: releasing starts the countdown (no hold needed)
        publish({ phase: 'holding', inInspection: false });
        return;
      }
      if (s.phase === 'idle' || s.phase === 'inspecting') {
        const inInspection = s.phase === 'inspecting';
        const hold = optsRef.current.holdMs;
        if (hold <= 0) {
          publish({ phase: 'ready', inInspection });
        } else {
          publish({ phase: 'holding', inInspection });
          clearHold();
          holdTimer.current = setTimeout(() => {
            if (st.current.phase === 'holding') publish({ phase: 'ready' });
          }, hold);
        }
      }
    },
    [publish],
  );

  /** release = space keyup / touch end */
  const release = useCallback(
    (t: number) => {
      const s = st.current;
      clearHold();
      if (s.phase === 'stopped') {
        if (keysDown.current.size === 0) publish({ phase: 'idle', inInspection: false });
        return;
      }
      if (s.phase === 'holding') {
        if (!s.inInspection && optsRef.current.inspection && s.inspectionStartedAt === null) {
          startInspection(t);
        } else {
          publish({ phase: s.inInspection ? 'inspecting' : 'idle' });
        }
        return;
      }
      if (s.phase === 'ready') {
        // solve starts now - the 8/12 s inspection calls must not go off during the solve
        clearAlerts();
        document.activeElement instanceof HTMLElement && document.activeElement.blur();
        publish({ phase: 'running', startedAt: t });
        optsRef.current.onStart?.();
      }
    },
    [publish, startInspection],
  );

  const stop = useCallback(
    (t: number, forceDnf: boolean) => {
      const s = st.current;
      if (s.phase !== 'running' || s.startedAt === null) return;
      if (!forceDnf && t - s.startedAt < MIN_RUN_MS) return;
      clearAlerts();
      const timeMs = Math.max(1, Math.round(t - s.startedAt));
      let penalty: Penalty = 'OK';
      if (s.inspectionStartedAt !== null) penalty = inspectionPenalty(s.startedAt - s.inspectionStartedAt);
      if (forceDnf) penalty = 'DNF';
      const result = { timeMs, penalty };
      publish({ phase: 'stopped', result, inInspection: false, inspectionStartedAt: null });
      optsRef.current.onSolve(result);
    },
    [publish],
  );

  const cancel = useCallback(() => {
    clearHold();
    clearAlerts();
    const s = st.current;
    if (s.phase === 'running') return;
    if (s.phase !== 'idle') {
      publish({ phase: 'idle', inInspection: false, inspectionStartedAt: null, startedAt: null });
      optsRef.current.onCancel?.();
    }
  }, [publish]);

  /** Input is accepted when enabled - and always for a solve in progress, so closing the gate
   *  mid-solve (round ended, modal opened) can never trap a running timer. */
  const gateOpen = () => optsRef.current.enabled || st.current.phase === 'running' || st.current.phase === 'stopped';

  // keyboard ------------------------------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!gateOpen()) return;
      if (isTypingTarget(e.target) || blockedByOverlay()) return;
      const s = st.current;
      if (s.phase === 'running') {
        if (MODIFIERS.has(e.key) && e.key !== 'Tab') return;
        e.preventDefault();
        keysDown.current.add(e.code);
        stop(now(e), e.key === 'Escape');
        return;
      }
      if (e.key === 'Escape') {
        if (s.phase !== 'idle' && s.phase !== 'stopped') {
          e.preventDefault(); // consume so the command palette doesn't open
          cancel();
        }
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
        publish({ phase: st.current.inInspection ? 'inspecting' : 'idle' });
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
  }, [press, release, stop, cancel, publish]);

  // cleanup timers on unmount; cancel if disabled mid-way
  useEffect(() => () => {
    clearHold();
    clearAlerts();
  }, []);
  useEffect(() => {
    if (!opts.enabled && st.current.phase !== 'running') cancel();
  }, [opts.enabled, cancel]);

  // touch (pointer) ---------------------------------------------------------------------------------
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!gateOpen() || e.pointerType === 'mouse') return;
      const s = st.current;
      if (s.phase === 'running') {
        stop(now(e.nativeEvent), false);
        return;
      }
      press(now(e.nativeEvent));
    },
    [press, stop],
  );
  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!gateOpen() || e.pointerType === 'mouse') return;
      if (st.current.phase === 'stopped') {
        publish({ phase: 'idle' });
        return;
      }
      release(now(e.nativeEvent));
    },
    [release, publish],
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      const p = st.current.phase;
      if (p === 'holding' || p === 'ready') {
        clearHold();
        publish({ phase: st.current.inInspection ? 'inspecting' : 'idle' });
      } else if (p === 'stopped') publish({ phase: 'idle' });
    },
    [publish],
  );

  // touch anywhere on the page stops a running solve (and finishes the stop on lift-off), so the
  // finger does not have to land on the timer area again
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || !gateOpen()) return;
      if (st.current.phase === 'running') stop(now(e), false);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      if (st.current.phase === 'stopped' && keysDown.current.size === 0) publish({ phase: 'idle' });
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
    };
  }, [stop, publish]);

  /** forget the last result (e.g. after deleting it) */
  const clearResult = useCallback(() => publish({ result: null }), [publish]);

  return { state, cancel, clearResult, touchHandlers: { onPointerDown, onPointerUp, onPointerCancel } };
}
