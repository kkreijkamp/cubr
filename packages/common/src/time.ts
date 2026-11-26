/**
 * The formatters per zone, made once: each new Intl.DateTimeFormat holds ICU memory outside the JS heap,
 * which the garbage collector barely sees, so making two per call ran a recompute of a big account up to
 * 3 GB of memory (2026-11-26). A zone the runtime doesn't know is remembered as null. Kept for at most
 * MAX_ZONES zones (the oldest goes first); the world has a few hundred.
 */
const MAX_ZONES = 600;
const dayFormats = new Map<string, Intl.DateTimeFormat | null>();
const hourFormats = new Map<string, Intl.DateTimeFormat | null>();
function formatFor(cache: Map<string, Intl.DateTimeFormat | null>, tz: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat | null {
  if (cache.has(tz)) return cache.get(tz)!;
  let f: Intl.DateTimeFormat | null;
  try {
    f = make();
  } catch {
    f = null;
  }
  if (cache.size >= MAX_ZONES) cache.delete(cache.keys().next().value!);
  cache.set(tz, f);
  return f;
}

/** 'YYYY-MM-DD' of `date` in the IANA timezone `tz` (falls back to UTC for invalid tz). */
export function dayKey(date: Date, tz = 'UTC'): string {
  const f = formatFor(dayFormats, tz, () => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return f ? f.format(date) : date.toISOString().slice(0, 10);
}

/** Hour of day 0-23 of `date` in timezone `tz`. */
export function hourIn(date: Date, tz = 'UTC'): number {
  const f = formatFor(hourFormats, tz, () => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }));
  return f ? Number.parseInt(f.format(date), 10) % 24 : date.getUTCHours();
}

/** ISO-8601 week key, e.g. '2026-W42', for the calendar day of `date` in `tz`. */
export function isoWeekKey(date: Date, tz = 'UTC'): string {
  const [y, m, d] = dayKey(date, tz).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dayNum = t.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // Thursday of the same ISO week decides the year
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** True if `tz` is a valid IANA timezone name. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
