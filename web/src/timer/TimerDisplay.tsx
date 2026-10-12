import { useEffect, useRef } from 'react';
import { formatTime, type Precision } from '@cubetype/cubestats';
import type { TimerState } from './useTimerEngine';
import './timer.css';

interface Props {
  state: TimerState;
  precision: Precision;
  /** font size in rem */
  sizeRem?: number;
  className?: string;
}

/**
 * The big timer number. While running it updates its own text node every animation frame (no
 * React re-render per frame).
 */
export function TimerDisplay({ state, precision, sizeRem = 7, className }: Props) {
  const textRef = useRef<HTMLSpanElement>(null);
  const { phase, startedAt, result } = state;

  useEffect(() => {
    if (phase !== 'running') return;
    let raf = 0;
    const tick = () => {
      const el = textRef.current;
      if (el && startedAt !== null) el.textContent = formatTime(performance.now() - startedAt, precision);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [phase, startedAt, precision]);

  const zero = precision === 3 ? '0.000' : '0.00';
  let text: string;
  if (phase === 'running') {
    text = formatTime(startedAt !== null ? performance.now() - startedAt : 0, precision);
  } else if (phase === 'ready') {
    text = zero;
  } else if (result) {
    text = formatTime(result.timeMs, precision);
  } else {
    text = zero;
  }

  return (
    <div className={`timer-display ${phase} ${className ?? ''}`} style={{ ['--timer-size' as string]: `${sizeRem}rem` }} aria-live="off">
      <span ref={textRef}>{text}</span>
    </div>
  );
}
