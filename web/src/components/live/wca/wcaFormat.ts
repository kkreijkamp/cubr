import { formatTime, parseTimeInput } from '@cubetype/cubestats';
import { ApiError } from '../../../lib/api';

export const isFmc = (event: string) => event === '333fm';

/** WCA API values: ms for timed events, moves for 333fm (averages may be fractional). */
export function formatWcaValue(v: number | null | undefined, event: string, kind: 'single' | 'average'): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  if (v < 0) return 'DNF';
  if (isFmc(event)) return kind === 'average' ? v.toFixed(2) : String(Math.round(v));
  return formatTime(v, 2);
}

/** compact axis tick: "8.4", "12", "1:05" (moves stay integers) */
export function shortAxisValue(v: number, event: string, kind: 'single' | 'average'): string {
  if (isFmc(event)) return kind === 'average' ? v.toFixed(1) : String(Math.round(v));
  const s = v / 1000;
  if (s < 10) return s.toFixed(1);
  if (s < 60) return String(Math.round(s));
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

/** user input -> API value (ms, or moves for FMC); null when invalid */
export function parseWcaInput(input: string, event: string, kind: 'single' | 'average'): number | null {
  const s = input.trim();
  if (!s) return null;
  if (isFmc(event)) {
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
    const n = Number(s);
    if (!(n > 0 && n <= 100)) return null;
    if (kind === 'single' && !Number.isInteger(n)) return null;
    return n;
  }
  const ms = parseTimeInput(s);
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.round(ms);
}

export type WcaErrorKind = 'importing' | 'unavailable' | 'notfound' | 'other';

/** 503 UNAVAILABLE from the wca service = the WCA export is still being imported. */
export function wcaErrorKind(e: unknown): WcaErrorKind {
  if (e instanceof ApiError) {
    if (e.status === 503 && e.code === 'UNAVAILABLE') return 'importing';
    if (e.status === 404) return 'notfound';
    if (e.isUnavailable || e.status >= 500) return 'unavailable';
  }
  return 'other';
}
