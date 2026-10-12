import { useCallback, useMemo, useState } from 'react';
import { formatTime, sessionStats, type Precision } from '@cubetype/cubestats';
import { TimerDisplay } from '../timer/TimerDisplay';
import { useTimerEngine, type TimerResult } from '../timer/useTimerEngine';
import '../components/timer/timer-page.css';

const HOLD_MS = 300;
const PRECISION: Precision = 2;
const TIMER_SIZE = 7;

export default function TimerPage() {
  // the times of this visit
  const [results, setResults] = useState<TimerResult[]>([]);
  const onSolve = useCallback((r: TimerResult) => setResults((list) => [...list, r]), []);
  const engine = useTimerEngine({ enabled: true, holdMs: HOLD_MS, onSolve });
  const stats = useMemo(() => sessionStats(results, [5, 12]), [results]);

  return (
    <div className="timer-page">
      <div className="tp-timer-area">
        <TimerDisplay state={engine.state} precision={PRECISION} sizeRem={TIMER_SIZE} />
      </div>

      <div className="tp-under">
        {results.length === 0 ? (
          <div className="tp-hint">
            hold <kbd>space</kbd> until the time turns green, release to start
          </div>
        ) : (
          <div className="tp-avgline">
            <span>
              ao5<b>{formatTime(stats.averages.ao5?.current, PRECISION)}</b>
            </span>
            <span>
              ao12<b>{formatTime(stats.averages.ao12?.current, PRECISION)}</b>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
