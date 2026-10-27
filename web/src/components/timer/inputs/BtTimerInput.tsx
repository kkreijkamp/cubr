import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Penalty, Precision } from '@cubetype/cubestats';
import { TimerDisplay } from '../../../timer/TimerDisplay';
import { alertAt, type TimerState } from '../../../timer/useTimerEngine';
import type { TimerUpdate } from '../../../lib/settings';
import { bluetoothAvailable } from '../../../input/bluetooth/device';
import { BtTimerState } from '../../../input/bluetooth/btTimer';
import { timerGroup, TimerEvent, type TimerCtx } from '../../../input/bluetooth/timers';
import { noFocus } from '../ConfigBar';
import { useMacAddress } from './macPrompt';

interface Props {
  enabled: boolean;
  inspection: boolean;
  alerts: 'off' | 'beep' | 'voice';
  last: { timeMs: number; penalty: Penalty } | null;
  precision: Precision;
  timerUpdate: TimerUpdate;
  sizeRem: number;
  pb: boolean;
  onState: (s: TimerState) => void;
  onSolve: (r: { timeMs: number; penalty: Penalty }) => void;
}

type Conn = { status: 'off' } | { status: 'connecting' } | { status: 'connected'; name: string } | { status: 'reconnecting'; name: string } | { status: 'error'; message: string };

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** A GAN or QiYi smart timer over bluetooth (csTimer's bluetooth timer input). */
export function BtTimerInput(p: Props) {
  const group = useMemo(timerGroup, []);
  const timer = useMemo(() => new BtTimerState(), []);
  const [conn, setConn] = useState<Conn>({ status: 'off' });
  const [available, setAvailable] = useState<boolean | null>(null);
  const [tick, setTick] = useState(0);
  const props = useRef(p);
  props.current = p;
  const { mac, element: macPrompt } = useMacAddress();
  const alertTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const reconnect = useRef<ReturnType<typeof setTimeout> | null>(null);
  timer.inspection = p.inspection;

  useEffect(() => {
    void bluetoothAvailable().then(setAvailable);
  }, []);

  const clearAlerts = () => {
    alertTimers.current.forEach(clearTimeout);
    alertTimers.current = [];
  };
  const startAlerts = () => {
    clearAlerts();
    const mode = props.current.alerts;
    if (mode !== 'off') alertTimers.current = [setTimeout(() => alertAt(8, mode), 8000), setTimeout(() => alertAt(12, mode), 12000)];
  };

  const ctx: TimerCtx = useMemo(
    () => ({
      event(e) {
        const before = timer.phase;
        const solve = timer.handle(e, performance.now());
        if (timer.phase === 'running' && before !== 'running') clearAlerts();
        if (timer.phase === 'inspecting' && before !== 'inspecting') startAlerts();
        if (e.state === TimerEvent.DISCONNECT) clearAlerts();
        setTick((t) => t + 1);
        if (solve) props.current.onSolve(solve);
      },
      mac: (name, found, suggested) => mac(name, found, suggested),
      log: () => undefined,
    }),
    [timer, mac],
  );

  const afterConnect = useCallback(
    (name: string) => {
      timer.connected = true;
      timer.hardTime = 0;
      timer.phase = 'idle';
      setConn({ status: 'connected', name });
      setTick((t) => t + 1);
    },
    [timer],
  );

  const connect = useCallback(async () => {
    if (reconnect.current) clearTimeout(reconnect.current);
    setConn({ status: 'connecting' });
    try {
      afterConnect(await group.connect(ctx));
    } catch (e) {
      const msg = (e as Error).name === 'NotFoundError' ? 'no timer chosen' : (e as Error).message || "couldn't connect";
      setConn({ status: 'error', message: msg });
    }
  }, [group, ctx, afterConnect]);

  // the timer switched off or went out of range: try again every few seconds, no click needed
  useEffect(() => {
    group.onDisconnect = () => {
      const device = group.lastDevice;
      const name = device?.name ?? 'timer';
      timer.connected = false;
      setConn({ status: 'reconnecting', name });
      setTick((t) => t + 1);
      const retry = () => {
        if (!device) return;
        group.setUp(device, ctx).then(afterConnect, () => {
          reconnect.current = setTimeout(retry, 2500);
        });
      };
      reconnect.current = setTimeout(retry, 2500);
    };
    return () => {
      group.onDisconnect = null;
      if (reconnect.current) clearTimeout(reconnect.current);
      clearAlerts();
      void group.disconnect(false);
    };
  }, [group, ctx, timer, afterConnect]);

  // space: inspection (or, not connected yet, connect); esc stops inspection
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
      if (e.code !== 'Space' || isTyping(e.target) || document.querySelector('.modal-backdrop')) return;
      e.preventDefault();
      if (!group.connected) {
        if (conn.status === 'off' || conn.status === 'error') void connect();
        return;
      }
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
  }, [p.enabled, timer, group, connect, conn.status]);

  const lastMs = p.last?.timeMs;
  const lastPenalty = p.last?.penalty;
  const state: TimerState = useMemo(() => {
    void tick;
    const hard = timer.hardTime;
    const shown = hard ? { timeMs: hard, penalty: (lastMs === hard ? lastPenalty : 'OK') ?? 'OK' } : lastMs !== undefined && hard === null ? { timeMs: lastMs, penalty: lastPenalty ?? 'OK' } : null;
    if (timer.phase === 'running') return { phase: 'running', inInspection: false, startedAt: timer.startTime, inspectionStartedAt: null, result: null };
    if (timer.phase === 'inspecting') {
      const phase = timer.light === 'green' ? 'ready' : timer.light === 'red' ? 'holding' : 'inspecting';
      return { phase, inInspection: true, startedAt: null, inspectionStartedAt: timer.startTime, result: null };
    }
    if (timer.phase === 'inspect-ready') return { phase: 'holding', inInspection: false, startedAt: null, inspectionStartedAt: null, result: shown };
    if (timer.light === 'green') return { phase: 'ready', inInspection: false, startedAt: null, inspectionStartedAt: null, result: null };
    if (timer.light === 'red') return { phase: 'holding', inInspection: false, startedAt: null, inspectionStartedAt: null, result: shown };
    return { phase: 'idle', inInspection: false, startedAt: null, inspectionStartedAt: null, result: shown };
  }, [tick, timer, lastMs, lastPenalty]);
  const { onState } = p;
  useEffect(() => onState(state), [state, onState]);

  let status: React.ReactNode;
  if (available === false) status = <span className="error">this browser has no bluetooth - use Chrome or Edge on a computer or Android, with bluetooth on</span>;
  else if (conn.status === 'off')
    status = (
      <button className="btn-text active" onClick={() => void connect()} {...noFocus}>
        connect a bluetooth timer
      </button>
    );
  else if (conn.status === 'connecting') status = <span className="sub">connecting...</span>;
  else if (conn.status === 'connected')
    status = (
      <>
        <span className="sub">{conn.name} connected</span>
        <button className="btn-text" onClick={() => void group.disconnect(false).then(() => setConn({ status: 'off' }))} {...noFocus}>
          disconnect
        </button>
      </>
    );
  else if (conn.status === 'reconnecting') status = <span className="sub">{conn.name} disconnected - reconnecting...</span>;
  else
    status = (
      <>
        <span className="error">{conn.message}</span>
        <button className="btn-text" onClick={() => void connect()} {...noFocus}>
          try again
        </button>
      </>
    );

  return (
    <div className="tp-hardware">
      <TimerDisplay state={state} precision={p.precision} timerUpdate={p.timerUpdate} sizeRem={p.sizeRem} pb={p.pb && state.phase === 'idle'} />
      <div className="tp-hardware-bar">{status}</div>
      {macPrompt}
    </div>
  );
}
