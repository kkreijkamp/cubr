import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Penalty, Precision } from '@cubr/cubestats';
import { TimerDisplay } from '../../../timer/TimerDisplay';
import { alertAt, type TimerState } from '../../../timer/useTimerEngine';
import type { TimerUpdate } from '../../../lib/settings';
import { StackmatDecoder, type StackmatState } from '../../../input/stackmat/decoder';
import { listMicrophones, MicrophoneError, openMicrophone, type Microphone } from '../../../input/stackmat/audio';
import { StackmatTimer } from '../../../input/stackmat/timer';
import { updateInput, useInputState } from '../../../input/inputMode';
import { noFocus } from '../ConfigBar';

interface Props {
  kind: 'stackmat' | 'moyu';
  enabled: boolean;
  inspection: boolean;
  alerts: 'off' | 'beep' | 'voice';
  useStatus: boolean;
  last: { timeMs: number; penalty: Penalty } | null;
  precision: Precision;
  timerUpdate: TimerUpdate;
  sizeRem: number;
  pb: boolean;
  onState: (s: TimerState) => void;
  onSolve: (r: { timeMs: number; penalty: Penalty }) => void;
}

type Conn = { status: 'connecting' } | { status: 'listening' } | { status: 'needs-click' } | { status: 'error'; message: string };

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** A stackmat or MoYu timer on the microphone input (csTimer's stackmat / MoYu timer inputs). */
export function StackmatInput(p: Props) {
  const device = useInputState();
  const [conn, setConn] = useState<Conn>({ status: 'connecting' });
  const [signal, setSignal] = useState<StackmatState | null>(null);
  const [tick, setTick] = useState(0);
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const timer = useMemo(() => new StackmatTimer(), []);
  const mic = useRef<Microphone | null>(null);
  const props = useRef(p);
  props.current = p;
  const alertTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** when the signal came on (the gain takes a few seconds to settle; noise before that means nothing) */
  const signalSince = useRef<number | null>(null);
  timer.inspection = p.inspection;

  const clearAlerts = () => {
    alertTimers.current.forEach(clearTimeout);
    alertTimers.current = [];
  };
  const startAlerts = () => {
    clearAlerts();
    const mode = props.current.alerts;
    if (mode !== 'off') alertTimers.current = [setTimeout(() => alertAt(8, mode), 8000), setTimeout(() => alertAt(12, mode), 12000)];
  };

  const connect = useCallback(
    async (fromClick: boolean) => {
      mic.current?.stop();
      mic.current = null;
      setConn({ status: 'connecting' });
      try {
        let decoder: StackmatDecoder | null = null;
        const m = await openMicrophone(device.stackmatDevice, (samples) => decoder?.process(samples), { requireRunning: !fromClick });
        decoder = new StackmatDecoder(m.sampleRate, props.current.kind, (state) => {
          decoder!.useStatus = props.current.useStatus;
          const before = timer.phase;
          const solve = timer.update(state, performance.now());
          if (before !== 'running' && timer.phase === 'running') clearAlerts();
          if (before === 'idle' && timer.phase === 'inspecting') startAlerts();
          if (!state.on) signalSince.current = null;
          else signalSince.current ??= performance.now();
          setSignal(state);
          setTick((t) => t + 1);
          if (solve) props.current.onSolve(solve);
        });
        decoder.useStatus = props.current.useStatus;
        mic.current = m;
        setConn({ status: 'listening' });
        setMics(await listMicrophones());
      } catch (e) {
        if (e instanceof MicrophoneError && e.kind === 'suspended') setConn({ status: 'needs-click' });
        else setConn({ status: 'error', message: (e as Error).message || "couldn't open the microphone" });
      }
    },
    [device.stackmatDevice, timer], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    void connect(false);
    return () => {
      mic.current?.stop();
      mic.current = null;
      clearAlerts();
    };
  }, [connect, p.kind]);

  // space starts inspection (with the timer at zero), esc stops it
  useEffect(() => {
    if (!p.enabled) return;
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector('.modal-backdrop') || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat && timer.spaceDown(performance.now())) setTick((t) => t + 1);
      } else if (e.key === 'Escape' && timer.escape()) {
        e.preventDefault();
        e.stopPropagation();
        clearAlerts();
        setTick((t) => t + 1);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTyping(e.target)) return;
      e.preventDefault();
      if (timer.spaceUp(performance.now())) {
        startAlerts();
        setTick((t) => t + 1);
      }
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [p.enabled, timer]);

  // the timer page's view of it (by value: `last` is a fresh object each render)
  const lastMs = p.last?.timeMs;
  const lastPenalty = p.last?.penalty;
  const state: TimerState = useMemo(() => {
    void tick;
    const s = signal;
    const hard = timer.hardTime;
    const shown = hard !== null && s?.on ? { timeMs: hard, penalty: (lastMs === hard ? lastPenalty : 'OK') ?? 'OK' } : lastMs !== undefined ? { timeMs: lastMs, penalty: lastPenalty ?? 'OK' } : null;
    const hands = s?.on && s.leftHand && s.rightHand;
    if (timer.phase === 'running') return { phase: 'running', inInspection: false, startedAt: timer.startTime, inspectionStartedAt: null, result: null };
    if (timer.phase === 'inspecting') {
      const phase = s?.greenLight ? 'ready' : hands ? 'holding' : 'inspecting';
      return { phase, inInspection: true, startedAt: null, inspectionStartedAt: timer.startTime, result: null };
    }
    if (timer.phase === 'inspect-ready') return { phase: 'holding', inInspection: false, startedAt: null, inspectionStartedAt: null, result: shown };
    if (s?.on && s.greenLight) return { phase: 'ready', inInspection: false, startedAt: null, inspectionStartedAt: null, result: null };
    if (hands) return { phase: 'holding', inInspection: false, startedAt: null, inspectionStartedAt: null, result: shown };
    return { phase: 'idle', inInspection: false, startedAt: null, inspectionStartedAt: null, result: shown };
  }, [tick, signal, timer, lastMs, lastPenalty]);
  const { onState } = p;
  useEffect(() => onState(state), [state, onState]);

  const name = p.kind === 'moyu' ? 'moyu timer' : 'stackmat';
  let status: React.ReactNode;
  if (conn.status === 'connecting') status = <span className="sub">opening the microphone...</span>;
  else if (conn.status === 'needs-click')
    status = (
      <button className="btn-text active" onClick={() => void connect(true)} {...noFocus}>
        connect the {name}
      </button>
    );
  else if (conn.status === 'error')
    status = (
      <>
        <span className="error">{conn.message}</span>
        <button className="btn-text" onClick={() => void connect(true)} {...noFocus}>
          try again
        </button>
      </>
    );
  else if (!signal?.on) status = <span className="sub">listening - no {name} signal yet: is it on, and plugged into this input?</span>;
  else {
    const settled = signalSince.current !== null && performance.now() - signalSince.current > 5000;
    status = (
      <span className="sub">
        {name} connected
        {settled && signal.noise > 0.5 ? ` - the signal is noisy (${Math.round(signal.noise * 100)}%): check the cable and the input volume` : ''}
      </span>
    );
  }

  return (
    <div className="tp-hardware">
      <TimerDisplay state={state} precision={p.precision} timerUpdate={p.timerUpdate} sizeRem={p.sizeRem} pb={p.pb && state.phase === 'idle'} />
      <div className="tp-hardware-bar">
        {status}
        {conn.status === 'listening' && mics.length > 1 && (
          <select className="tp-hardware-select" value={device.stackmatDevice} onChange={(e) => updateInput({ stackmatDevice: e.target.value })} aria-label="microphone input">
            <option value="">default input</option>
            {mics.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
