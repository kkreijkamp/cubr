// Small pure helpers for the timer page's stats panel and solve list.
import { formatSolve, formatTime, type Precision } from '@cubetype/cubestats';
import type { Solve } from '../../lib/types';

/** Averages are rounded to the display unit (WCA 9f1), singles are truncated (formatTime). */
export function fmtAvg(v: number | null | undefined, precision: Precision): string {
  if (v === null || v === undefined) return '-';
  if (!Number.isFinite(v)) return 'DNF';
  const unit = precision === 3 ? 1 : 10;
  return formatTime(Math.round(v / unit) * unit, precision);
}

/** List/compact form of a solve: "12.34", "14.34+", "DNF". */
export function fmtSolveShort(s: Pick<Solve, 'timeMs' | 'penalty'>, precision: Precision): string {
  if (s.penalty === 'DNF') return 'DNF';
  return formatSolve(s.timeMs, s.penalty, precision);
}

/** Long form: "DNF(12.34)" (plain "DNF" for entries without a real time). */
export function fmtSolveLong(s: Pick<Solve, 'timeMs' | 'penalty'>, precision: Precision): string {
  if (s.penalty === 'DNF' && s.timeMs <= 1) return 'DNF';
  return formatSolve(s.timeMs, s.penalty, precision);
}
