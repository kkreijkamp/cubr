import { DNF, type Penalty } from './averages.js';

export type Precision = 2 | 3;

/**
 * Formats milliseconds the way cubers expect: 9.87, 1:02.34, 1:02:03.45.
 * Values are truncated (not rounded) to the precision, like WCA singles.
 * Infinity / -1 -> "DNF", null/undefined -> "-".
 */
export function formatTime(ms: number | null | undefined, precision: Precision = 2): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '-';
  if (ms === DNF || ms === -1) return 'DNF';
  const unit = precision === 3 ? 1 : 10;
  const t = Math.floor(ms / unit) * unit;
  const totalSec = Math.floor(t / 1000);
  const frac = String(precision === 3 ? t % 1000 : Math.floor((t % 1000) / 10)).padStart(precision, '0');
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${frac}`;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}.${frac}`;
  return `${s}.${frac}`;
}

/**
 * Formats an average or mean (ms): rounded to the precision, half up (WCA 9f1: averages are rounded,
 * singles truncated). cubr's averages are whole milliseconds wherever they're stored or ranked
 * (cubestats rounds the mean once, to the ms), and every page formats them with this, so an average
 * reads the same on the timer, the profile and the boards (the October review's #16).
 * Infinity / -1 -> "DNF", null/undefined -> "-".
 */
export function formatAverage(ms: number | null | undefined, precision: Precision = 2): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '-';
  if (ms === DNF || ms === -1 || !Number.isFinite(ms)) return 'DNF';
  const unit = precision === 3 ? 1 : 10;
  return formatTime(Math.round(ms / unit) * unit, precision);
}

/** A result of a kind: a 'single' is truncated (formatTime), anything else (ao5, mean...) rounded (formatAverage). */
export function formatResult(ms: number | null | undefined, kind: string, precision: Precision = 2): string {
  return kind === 'single' ? formatTime(ms, precision) : formatAverage(ms, precision);
}

/** Formats a raw solve with its penalty: "12.34", "14.34+", "DNF(12.34)". */
export function formatSolve(timeMs: number, penalty: Penalty, precision: Precision = 2): string {
  if (penalty === 'DNF') return `DNF(${formatTime(timeMs, precision)})`;
  if (penalty === '+2') return `${formatTime(timeMs + 2000, precision)}+`;
  return formatTime(timeMs, precision);
}

/** Formats a duration in a human way for profile totals: "3h 12m", "45m 10s", "12s". */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/**
 * Parses manual time entry. Accepts "12.34", "1:02.34", "1:02:03.4", and csTimer-style digit
 * strings where the last two digits are centiseconds ("1234" -> 12.34 s, "10234" -> 1:02.34).
 * Returns ms, or null if unparseable. "DNF" -> Infinity.
 */
export function parseTimeInput(input: string): number | null {
  const s = input.trim().toUpperCase();
  if (!s) return null;
  if (s === 'DNF') return DNF;
  if (/^\d+$/.test(s)) {
    // digits only: ...HHMMSScc
    const padded = s.padStart(8, '0');
    const cs = Number(padded.slice(-2));
    const sec = Number(padded.slice(-4, -2));
    const min = Number(padded.slice(-6, -4));
    const hr = Number(padded.slice(0, -6));
    if (sec >= 60 || min >= 60) return null;
    const ms = ((hr * 60 + min) * 60 + sec) * 1000 + cs * 10;
    return ms > 0 ? ms : null;
  }
  const m = /^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d{1,3})?)$/.exec(s);
  if (!m) return null;
  let h = 0;
  let mins = 0;
  if (m[1] !== undefined && m[2] !== undefined) {
    h = Number(m[1]);
    mins = Number(m[2]);
  } else if (m[1] !== undefined) {
    mins = Number(m[1]);
  }
  const secs = Number(m[3]);
  if ((m[1] !== undefined && secs >= 60) || (m[2] !== undefined && mins >= 60)) return null;
  const ms = Math.round(((h * 60 + mins) * 60 + secs) * 1000);
  return ms > 0 ? ms : null;
}
