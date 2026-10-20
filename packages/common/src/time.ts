/** 'YYYY-MM-DD' of `date` in the IANA timezone `tz` (falls back to UTC for invalid tz). */
export function dayKey(date: Date, tz = 'UTC'): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Hour of day 0-23 of `date` in timezone `tz`. */
export function hourIn(date: Date, tz = 'UTC'): number {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(date);
    return Number.parseInt(h, 10) % 24;
  } catch {
    return date.getUTCHours();
  }
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
