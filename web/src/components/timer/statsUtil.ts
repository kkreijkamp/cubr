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

/**
 * Manual time entry (csTimer typing mode): "12.34", "1:02.34", "1234" (= 12.34), "12.34+" (+2
 * included in the typed time), "dnf(12.34)" and a bare "dnf". Returns null when unparseable.
 */
export function parseManualEntry(input: string, parse: (s: string) => number | null): { timeMs: number; penalty: 'OK' | '+2' | 'DNF' } | null {
  let s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (s === 'dnf') return { timeMs: 1, penalty: 'DNF' };
  let penalty: 'OK' | '+2' | 'DNF' = 'OK';
  const dnf = /^dnf\((.+)\)$/.exec(s);
  if (dnf) {
    s = dnf[1];
    penalty = 'DNF';
  } else if (s.endsWith('+')) {
    s = s.slice(0, -1);
    penalty = '+2';
  }
  const ms = parse(s);
  if (ms === null || !Number.isFinite(ms)) return null;
  const timeMs = penalty === '+2' ? ms - 2000 : ms;
  if (timeMs < 1 || timeMs > 86_400_000) return null;
  return { timeMs, penalty };
}
