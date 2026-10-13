// Small helpers shared by the social pages (login, profile/account, leaderboards).
import { getEvent } from '@cubetype/cubestats';
import { ApiError } from '../../lib/api';
import type { PbKind } from '../../lib/types';

export const PB_KINDS: PbKind[] = ['single', 'mo3', 'ao5', 'ao12', 'ao50', 'ao100'];

/** Short event label ("3x3", "OH"…), lowercase like the rest of the UI. */
export function eventLabel(id: string): string {
  return (getEvent(id)?.short ?? id).toLowerCase();
}

/** Events whose official WCA average is a mean of 3 rather than an average of 5. */
const MEAN_OF_3 = new Set(['666', '777', '333bf', '444bf', '555bf']);
/** Which cubetype PB kind corresponds to the WCA "average" of an event. */
export function wcaAverageKind(event: string): 'ao5' | 'mo3' {
  return MEAN_OF_3.has(event) ? 'mo3' : 'ao5';
}
/** Events that can be compared against WCA results (FMC is counted in moves, not ms). */
export function isWcaComparable(event: string): boolean {
  return event !== '333fm' && getEvent(event) !== undefined;
}

/** Only allow same-origin relative redirects ("/x", never "//evil.com" or "https://…"). */
export function safeNext(next: string | null | undefined, fallback = '/account'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (next.startsWith('/login')) return fallback;
  return next;
}

/** The WCA service answers 503 UNAVAILABLE until the results export has been imported. */
export function isWcaNotLoaded(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503 && (err.code === 'UNAVAILABLE' || /not loaded/i.test(err.message));
}

/** Friendly, lowercase message for a failed widget request. */
export function friendlyError(err: unknown, what: string): string {
  if (err instanceof ApiError) {
    if (err.isUnavailable || err.status >= 500) return `${what} is unavailable right now`;
    if (err.status === 429) return 'too many requests, slow down a little';
    return err.message.charAt(0).toLowerCase() + err.message.slice(1);
  }
  // programming errors (TypeError etc.) are not meant for users
  if (err instanceof TypeError || err instanceof ReferenceError) {
    console.error(err);
    return 'something went wrong — please try again';
  }
  return (err as Error)?.message || 'something went wrong';
}

/** Triggers a browser download of `content`. */
export function downloadFile(filename: string, content: BlobPart, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "Mon 03 Mar 2026" for a "YYYY-MM-DD" calendar key (no timezone shifting). */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDayKey(key: string, withWeekday = true): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const base = `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
  return withWeekday ? `${DAYS[date.getUTCDay()]} ${base}` : base;
}
export function monthShort(monthIndex: number): string {
  return MONTHS[monthIndex].toLowerCase();
}

/** "YYYY-MM-DD" key of a Date in UTC. */
export function utcKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** Add `days` to a "YYYY-MM-DD" key (UTC calendar arithmetic). */
export function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return utcKey(new Date(Date.UTC(y, m - 1, d + days)));
}

/** "s" suffix helper: plural(3, 'solve') → "3 solves". */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : pluralWord}`;
}
