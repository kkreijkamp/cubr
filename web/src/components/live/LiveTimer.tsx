// Timer wiring shared by the daily challenge and race pages: the shared engine + display, gated by
// the page (a race round must be running, a daily attempt must be left).
import { useRef, type ReactNode } from 'react';
import { useTimerEngine, type TimerPhase, type TimerResult } from '../../timer/useTimerEngine';
import { TimerDisplay } from '../../timer/TimerDisplay';
import { useSettings } from '../../lib/settings';

export interface LiveTimerOptions {
  /** may a new solve start right now? (an in-progress solve always finishes) */
  canStart: boolean;
  inspection: boolean;
  onSolve: (r: TimerResult) => void;
  onStart?: () => void;
  onInspectionStart?: () => void;
  onCancel?: () => void;
}

export type LiveTimerEngine = ReturnType<typeof useTimerEngine>;

export function useLiveTimer(o: LiveTimerOptions): LiveTimerEngine {
  const settings = useSettings();
  const phaseRef = useRef<TimerPhase>('idle');
  const engine = useTimerEngine({
    // keep the engine alive while a solve is in progress even if the gate closes (e.g. the race
    // socket drops mid-solve): the time is kept and submitted once we're back
    enabled: o.canStart || phaseRef.current !== 'idle',
    inspection: o.inspection,
    holdMs: settings.holdMs,
    alerts: settings.inspectionAlerts,
    onSolve: o.onSolve,
    onStart: o.onStart,
    onInspectionStart: o.onInspectionStart,
    onCancel: o.onCancel,
  });
  phaseRef.current = engine.state.phase;

  return engine;
}

interface TimerAreaProps {
  engine: LiveTimerEngine;
  /** multiplier on the user's timer size setting */
  scale?: number;
  /** dims the display when no solve can start */
  idleDim?: boolean;
  children?: ReactNode;
}

/** Big timer + touch surface (tap / hold on phones). */
export function TimerArea({ engine, scale = 1, idleDim, children }: TimerAreaProps) {
  const settings = useSettings();
  const size = Math.max(3, settings.timerSize * scale);
  return (
    <div className={`live-timer${idleDim && engine.state.phase === 'idle' ? ' dim' : ''}`} {...engine.touchHandlers}>
      <TimerDisplay state={engine.state} precision={settings.precision} timerUpdate={settings.timerUpdate} sizeRem={size} />
      {children}
    </div>
  );
}
