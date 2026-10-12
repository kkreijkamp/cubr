// Small pure helpers for the timer page's stats panel and solve list.
import { formatSolve, formatTime, type Precision } from '@cubetype/cubestats';
import type { Solve } from '../../lib/types';

/** "mo3" → 3, "ao12" → 12, anything else → null */
export function parseAvgKey(key: string): number | null {
  const m = /^(ao|mo)(\d{1,5})$/.exec(key);
  if (!m) return null;
  const n = Number(m[2]);
  if (m[1] === 'mo' && n !== 3) return null;
  if (m[1] === 'ao' && n < 5) return null;
  return n;
}

export const AVG_CHOICES = ['mo3', 'ao5', 'ao12', 'ao25', 'ao50', 'ao100', 'ao200', 'ao500', 'ao1000'];

/** Sorted, de-duplicated window sizes for the given stat keys. */
export function statNs(keys: string[]): number[] {
  const ns = new Set<number>();
  for (const k of keys) {
    const n = parseAvgKey(k);
    if (n) ns.add(n);
  }
  return Array.from(ns).sort((a, b) => a - b);
}

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
