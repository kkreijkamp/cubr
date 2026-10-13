// Timer wiring for the daily challenge: the shared engine + display, gated by the page (a daily
// attempt must be left).
import { useRef } from 'react';
import { useTimerEngine, type TimerPhase, type TimerResult } from '../../timer/useTimerEngine';
import { TimerDisplay } from '../../timer/TimerDisplay';
import { useSettings } from '../../lib/settings';

export interface LiveTimerOptions {
  /** may a new solve start right now? (an in-progress solve always finishes) */
  canStart: boolean;
  inspection: boolean;
  onSolve: (r: TimerResult) => void;
}

export type LiveTimerEngine = ReturnType<typeof useTimerEngine>;

export function useLiveTimer(o: LiveTimerOptions): LiveTimerEngine {
  const settings = useSettings();
  const phaseRef = useRef<TimerPhase>('idle');
  const engine = useTimerEngine({
    // keep the engine alive while a solve is in progress even if the gate closes
    enabled: o.canStart || phaseRef.current !== 'idle',
    inspection: o.inspection,
    holdMs: settings.holdMs,
    alerts: settings.inspectionAlerts,
    onSolve: o.onSolve,
  });
  phaseRef.current = engine.state.phase;

  return engine;
}

interface TimerAreaProps {
  engine: LiveTimerEngine;
  /** dims the display when no solve can start */
  idleDim?: boolean;
}

/** Big timer display. */
export function TimerArea({ engine, idleDim }: TimerAreaProps) {
  const settings = useSettings();
  return (
    <div className={`live-timer${idleDim && engine.state.phase === 'idle' ? ' dim' : ''}`}>
      <TimerDisplay state={engine.state} precision={settings.precision} timerUpdate={settings.timerUpdate} sizeRem={settings.timerSize} />
    </div>
  );
}
