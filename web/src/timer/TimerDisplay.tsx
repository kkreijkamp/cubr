import { useEffect, useLayoutEffect, useRef } from 'react';
import { formatTime, type Precision } from '@cubr/cubestats';
import type { TimerState } from './useTimerEngine';
import { INSPECTION_MS } from './useTimerEngine';
import type { TimerUpdate } from '../lib/settings';
import { AFTER_SOLVE_MS, useWakeLock } from '../lib/wakeLock';
import './timer.css';

interface Props {
  state: TimerState;
  precision: Precision;
  timerUpdate: TimerUpdate;
  /** font size in rem */
  sizeRem?: number;
  /** highlight the result as a new PB */
  pb?: boolean;
  className?: string;
}

function inspectionText(elapsed: number): string {
  if (elapsed >= INSPECTION_MS + 2000) return 'DNF';
  if (elapsed >= INSPECTION_MS) return '+2';
  return String(Math.ceil((INSPECTION_MS - elapsed) / 1000));
}

function runningText(elapsed: number, mode: TimerUpdate, precision: Precision): string {
  switch (mode) {
    case 'hidden':
      return 'solve';
    case 'seconds':
      return String(Math.floor(elapsed / 1000));
    case 'tenths': {
      const s = formatTime(elapsed, 2);
      return s.slice(0, -1);
    }
    default:
      return formatTime(elapsed, precision);
  }
}

/**
 * Writes the time one character per cell. Digits get a fixed width (timer.css), so the number keeps
 * still while it runs even in a font without tabular figures (Comfortaa, Georgia).
 */
function setTimerText(el: HTMLElement, text: string): void {
  if (el.dataset.text === text) return;
  el.dataset.text = text;
  while (el.childElementCount > text.length) el.lastElementChild!.remove();
  while (el.childElementCount < text.length) el.append(document.createElement('span'));
  for (let i = 0; i < text.length; i++) {
    const cell = el.children[i] as HTMLElement;
    if (cell.textContent !== text[i]) cell.textContent = text[i];
    cell.className = text[i] >= '0' && text[i] <= '9' ? 'digit' : '';
  }
}

/**
 * The big timer number. While running/inspecting it updates its own cells every animation
 * frame (no React re-render per frame).
 */
export function TimerDisplay({ state, precision, timerUpdate, sizeRem = 7, pb, className }: Props) {
  const textRef = useRef<HTMLSpanElement>(null);
  const { phase, inInspection, startedAt, inspectionStartedAt, result } = state;
  const showInspection = phase === 'inspecting' || (inInspection && (phase === 'holding' || phase === 'ready'));
  // the screen stays on from the press (or inspection) until the solve stops, and a while after
  useWakeLock(phase === 'holding' || phase === 'ready' || phase === 'inspecting' || phase === 'running', AFTER_SOLVE_MS);

  useEffect(() => {
    if (phase !== 'running' && !showInspection) return;
    let raf = 0;
    const tick = () => {
      const el = textRef.current;
      if (el) {
        if (phase === 'running' && startedAt !== null) setTimerText(el, runningText(performance.now() - startedAt, timerUpdate, precision));
        else if (inspectionStartedAt !== null) setTimerText(el, inspectionText(performance.now() - inspectionStartedAt));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [phase, showInspection, startedAt, inspectionStartedAt, timerUpdate, precision]);

  const zero = precision === 3 ? '0.000' : '0.00';
  let text: string;
  let penaltyMark = '';
  let cls: string = phase;
  if (phase === 'running') {
    text = runningText(startedAt !== null ? performance.now() - startedAt : 0, timerUpdate, precision);
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
  if (pb && (phase === 'idle' || phase === 'stopped')) cls += ' pb';

  // every render, not just when `text` changes: the frame loop may have written something else since
  useLayoutEffect(() => {
    if (textRef.current) setTimerText(textRef.current, text);
  });

  // read out once when a solve ends (and nothing while it runs: the display itself is aria-live off); it
  // empties when the next one starts, and a time already there when the page opens isn't read
  const spoken =
    result && (phase === 'idle' || phase === 'stopped')
      ? `${result.penalty === 'DNF' ? 'DNF' : `${text}${penaltyMark ? ', plus 2' : ''}`}${pb ? ', a personal best' : ''}`
      : '';

  return (
    <>
      <div className={`timer-display ${cls} ${className ?? ''}`} style={{ ['--timer-size' as string]: `${sizeRem}rem` }} aria-live="off">
        <span ref={textRef} />
        {penaltyMark && <span className="penalty">{penaltyMark}</span>}
      </div>
      <span className="sr-only" role="status">
        {spoken}
      </span>
    </>
  );
}
