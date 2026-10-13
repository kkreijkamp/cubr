// Small pure helpers for the timer page's stats panel, average detail modal and charts.
import { effectiveMs, formatSolve, formatTime, trimFor, type Precision } from '@cubetype/cubestats';
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

/** Axis tick label: 12.5 → "12.5", 75 s → "1:15". */
export function shortTime(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const s = ms / 1000;
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rest = Math.round(s - m * 60);
    return `${m}:${String(rest).padStart(2, '0')}`;
  }
  return Number.isInteger(s) ? String(s) : s.toFixed(s < 10 ? 2 : 1).replace(/0+$/, '').replace(/\.$/, '');
}

export interface AverageWindow {
  n: number;
  /** index (in the session) of the first solve of the window */
  start: number;
  solves: Solve[];
  /** positions within `solves` that are trimmed (best/worst) */
  trimmed: Set<number>;
  value: number;
}

/** The n solves ending at `end` and which of them are trimmed (DNFs count as worst). */
export function averageWindow(all: Solve[], end: number, n: number, value: number): AverageWindow {
  const start = Math.max(0, end - n + 1);
  const solves = all.slice(start, end + 1);
  const trim = n === 3 ? 0 : trimFor(n);
  const order = solves.map((s, i) => ({ i, t: effectiveMs(s) })).sort((a, b) => a.t - b.t || a.i - b.i);
  const trimmed = new Set<number>();
  for (let k = 0; k < trim; k++) {
    trimmed.add(order[k].i);
    trimmed.add(order[order.length - 1 - k].i);
  }
  return { n, start, solves, trimmed, value };
}

/** csTimer-style plain-text report (copied to the clipboard from the average modal). */
export function averageReport(label: string, w: AverageWindow, precision: Precision): string {
  const lines = [`cubetype · ${new Date().toISOString().slice(0, 10)}`, `${label}: ${fmtAvg(w.value, precision)}`, '', 'Time List:'];
  w.solves.forEach((s, i) => {
    const t = fmtSolveShort(s, precision);
    lines.push(`${i + 1}. ${w.trimmed.has(i) ? `(${t})` : t}   ${s.scramble.replace(/\n/g, ' ')}`);
  });
  return lines.join('\n');
}

/** Evenly thins a series to at most `max` points (keeps first & last). */
export function strideIndices(length: number, max: number): number[] {
  if (length <= max) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (max - 1);
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(Math.round(k * step));
  return out;
}

export interface Bucket {
  from: number;
  to: number;
  count: number;
}

const NICE_STEPS = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

/** Histogram of finite times; range clipped to the 1st–99th percentile, outliers go to the edges. */
export function histogram(times: number[], targetBuckets = 24): Bucket[] {
  const xs = times.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (xs.length === 0) return [];
  const q = (p: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.floor(p * (xs.length - 1))))];
  const lo = xs.length >= 50 ? q(0.01) : xs[0];
  const hi = xs.length >= 50 ? q(0.99) : xs[xs.length - 1];
  const span = Math.max(1, hi - lo);
  const step = NICE_STEPS.find((s) => span / s <= targetBuckets) ?? NICE_STEPS[NICE_STEPS.length - 1];
  const start = Math.floor(lo / step) * step;
  const count = Math.max(1, Math.floor((hi - start) / step) + 1);
  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => ({ from: start + i * step, to: start + (i + 1) * step, count: 0 }));
  for (const t of xs) {
    const i = Math.min(count - 1, Math.max(0, Math.floor((t - start) / step)));
    buckets[i].count++;
  }
  return buckets;
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
