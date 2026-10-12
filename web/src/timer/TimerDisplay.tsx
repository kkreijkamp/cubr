import { useEffect, useRef } from 'react';
import { formatTime, type Precision } from '@cubetype/cubestats';
import type { TimerState } from './useTimerEngine';
import { INSPECTION_MS } from './useTimerEngine';
import './timer.css';

interface Props {
  state: TimerState;
  precision: Precision;
  /** font size in rem */
  sizeRem?: number;
  className?: string;
}

function inspectionText(elapsed: number): string {
  if (elapsed >= INSPECTION_MS + 2000) return 'DNF';
  if (elapsed >= INSPECTION_MS) return '+2';
  return String(Math.ceil((INSPECTION_MS - elapsed) / 1000));
}

/**
 * The big timer number. While running/inspecting it updates its own text node every animation
 * frame (no React re-render per frame).
 */
export function TimerDisplay({ state, precision, sizeRem = 7, className }: Props) {
  const textRef = useRef<HTMLSpanElement>(null);
  const { phase, inInspection, startedAt, inspectionStartedAt, result } = state;
  const showInspection = phase === 'inspecting' || (inInspection && (phase === 'holding' || phase === 'ready'));

  useEffect(() => {
    if (phase !== 'running' && !showInspection) return;
    let raf = 0;
    const tick = () => {
      const el = textRef.current;
      if (el) {
        if (phase === 'running' && startedAt !== null) el.textContent = formatTime(performance.now() - startedAt, precision);
        else if (inspectionStartedAt !== null) el.textContent = inspectionText(performance.now() - inspectionStartedAt);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [phase, showInspection, startedAt, inspectionStartedAt, precision]);

  const zero = precision === 3 ? '0.000' : '0.00';
  let text: string;
  let penaltyMark = '';
  let cls: string = phase;
  if (phase === 'running') {
    text = formatTime(startedAt !== null ? performance.now() - startedAt : 0, precision);
  } else if (showInspection) {
    text = inspectionStartedAt !== null ? inspectionText(performance.now() - inspectionStartedAt) : '15';
    if (phase === 'inspecting') cls = 'inspecting';
  } else if (phase === 'ready') {
    text = zero;
  } else if (result) {
    if (result.penalty === 'DNF') {
      text = 'DNF';
      cls = phase === 'holding' ? 'holding' : 'dnf';
    } else {
      text = formatTime(result.penalty === '+2' ? result.timeMs + 2000 : result.timeMs, precision);
      if (result.penalty === '+2') penaltyMark = '+';
    }
  } else {
    text = zero;
  }

  return (
    <div className={`timer-display ${cls} ${className ?? ''}`} style={{ ['--timer-size' as string]: `${sizeRem}rem` }} aria-live="off">
      <span ref={textRef}>{text}</span>
      {penaltyMark && <span className="penalty">{penaltyMark}</span>}
    </div>
  );
}
