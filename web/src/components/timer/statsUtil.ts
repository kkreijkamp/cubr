// Small pure helpers for the timer page's stats panel, average detail modal and charts.
import { effectiveMs, formatAverage, formatSolve, formatTime, trimFor, type Precision, type SessionStats } from '@cubr/cubestats';
import type { Solve } from '../../lib/types';

/** "mo3" -> 3, "ao12" -> 12, anything else -> null */
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
  const lines = [`cubr - ${new Date().toISOString().slice(0, 10)}`, `${label}: ${formatAverage(w.value, precision)}`, '', 'Time List:'];
  w.solves.forEach((s, i) => {
    const t = fmtSolveShort(s, precision);
    lines.push(`${i + 1}. ${w.trimmed.has(i) ? `(${t})` : t}   ${s.scramble.replace(/\n/g, ' ')}`);
  });
  return lines.join('\n');
}

export type PbKind = 'single' | 'ao5' | 'ao12' | 'ao100';

/**
 * New session bests set by the latest solve. Requires an existing (finite) previous best so the
 * first few solves of a session don't spam "new pb".
 */
export function detectPbs(prev: SessionStats, next: SessionStats): { kind: PbKind; value: number }[] {
  const out: { kind: PbKind; value: number }[] = [];
  const lastIndex = next.count - 1;
  if (next.bestIndex === lastIndex && next.best !== null && prev.best !== null && prev.count >= 5 && next.best < prev.best) {
    out.push({ kind: 'single', value: next.best });
  }
  for (const kind of ['ao5', 'ao12', 'ao100'] as const) {
    const a = next.averages[kind];
    const b = prev.averages[kind];
    if (!a || !b || a.best === null || b.best === null) continue;
    if (!Number.isFinite(b.best)) continue;
    if (a.bestIndex === lastIndex && a.best < b.best) out.push({ kind, value: a.best });
  }
  return out;
}

/**
 * Which entries set a new session best when they happened: the first finite value, then each one
 * that beats every earlier value. (The "new pb" notice is stricter - see detectPbs.)
 */
export function pbFlags(values: readonly (number | null)[]): boolean[] {
  const out = new Array<boolean>(values.length).fill(false);
  let best = Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || !(v < best)) continue;
    out[i] = true;
    best = v;
  }
  return out;
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
