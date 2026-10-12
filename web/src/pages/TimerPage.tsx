import { useCallback, useMemo } from 'react';
import { effectiveMs, rollingAverage, sessionStats, type Precision } from '@cubetype/cubestats';
import { TimerDisplay } from '../timer/TimerDisplay';
import { useTimerEngine, type TimerResult, type TimerState } from '../timer/useTimerEngine';
import { StatsPanel } from '../components/timer/StatsPanel';
import { SolveList } from '../components/timer/SolveList';
import { fmtAvg } from '../components/timer/statsUtil';
import '../components/timer/timer-page.css';
import { addSolve, useSolveState } from '../lib/solves';

const HOLD_MS = 300;
const PRECISION: Precision = 2;
const TIMER_SIZE = 7;
/** averages in the stats panel: mo3, ao5, ao12, ao100 */
const STATS_NS = [3, 5, 12, 100];

export default function TimerPage() {
  const st = useSolveState();

  // ---------------------------------------------------------------- derived stats (memoised per solve change)
  const solves = st.solves;
  const last = solves.length ? solves[solves.length - 1] : null;
  const stats = useMemo(() => sessionStats(solves, STATS_NS), [solves]);
  const times = useMemo(() => solves.map(effectiveMs), [solves]);
  const ao5 = useMemo(() => rollingAverage(times, 5), [times]);
  const ao12 = useMemo(() => rollingAverage(times, 12), [times]);

  // ---------------------------------------------------------------- recording solves
  const onSolve = useCallback((r: TimerResult) => {
    void addSolve({ timeMs: r.timeMs, penalty: r.penalty, scramble: '' });
  }, []);

  const engine = useTimerEngine({ enabled: true, holdMs: HOLD_MS, onSolve });

  // ---------------------------------------------------------------- display
  // idle: show the latest solve of this session, like csTimer
  const displayState: TimerState = useMemo(() => {
    const s = engine.state;
    if (s.phase === 'idle' || s.phase === 'holding') {
      return { ...s, result: last ? { timeMs: last.timeMs, penalty: last.penalty } : null };
    }
    return s;
  }, [engine.state, last]);

  return (
    <div className="timer-page">
      <div className="tp-timer-area">
        <TimerDisplay state={displayState} precision={PRECISION} sizeRem={TIMER_SIZE} />
      </div>

      <div className="tp-under">
        {solves.length === 0 && st.ready ? (
          <div className="tp-hint">
            hold <kbd>space</kbd> until the time turns green, release to start
          </div>
        ) : (
          <div className="tp-avgline">
            <span>
              ao5<b>{fmtAvg(stats.averages.ao5?.current, PRECISION)}</b>
            </span>
            <span>
              ao12<b>{fmtAvg(stats.averages.ao12?.current, PRECISION)}</b>
            </span>
          </div>
        )}
      </div>

      <div className="tp-bottom cols-2">
        <StatsPanel stats={stats} ns={STATS_NS} solves={solves} precision={PRECISION} />
        <SolveList solves={solves} ao5={ao5} ao12={ao12} bestIndex={stats.bestIndex} precision={PRECISION} />
      </div>
    </div>
  );
}
