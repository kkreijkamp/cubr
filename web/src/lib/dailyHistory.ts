// The daily page's calendar of your own daily challenges (GET /api/solves/daily/history): one square
// per UTC day, laid out like the profile's activity calendar (weeks across, sun ... sat down). The
// brighter a square, the better that day's ao5 was compared with your other finished days shown, as
// the profile's colours compare the days shown. (Against all your days ever, someone who improves
// would see nothing but the brightest green in the last 30 days.)
import { formatTime, type Precision } from '@cubr/cubestats';
import type { DailyDay } from './types';

/** 'last' = the last 30 days; otherwise a month as 'YYYY-MM' */
export type DailyRange = string;
export const LAST_DAYS = 30;

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const keyToUtc = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
/** `key` moved by `days` (UTC calendar arithmetic). */
export const addDays = (key: string, days: number) => new Date(keyToUtc(key) + days * 86_400_000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((keyToUtc(b) - keyToUtc(a)) / 86_400_000);

/** 'november 2026' for '2026-11'. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** The first and last day of a range ('YYYY-MM-DD'). A month runs to its end, also past today. */
export function rangeDays(range: DailyRange, today: string): { from: string; to: string } {
  if (range === 'last' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(range)) return { from: addDays(today, -(LAST_DAYS - 1)), to: today };
  const [y, m] = range.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${range}-01`, to: `${range}-${String(days).padStart(2, '0')}` };
}

/**
 * The months to pick from, newest first: every month with an attempt, plus `keep` (the range
 * picked before switching to an event without attempts that month), grouped by year.
 */
export function rangeMonths(days: DailyDay[], keep?: DailyRange): { year: number; months: string[] }[] {
  const set = new Set(days.map((d) => d.date.slice(0, 7)));
  if (keep && keep !== 'last') set.add(keep);
  const sorted = [...set].sort().reverse();
  const years: { year: number; months: string[] }[] = [];
  for (const m of sorted) {
    const year = Number(m.slice(0, 4));
    if (years.at(-1)?.year !== year) years.push({ year, months: [] });
    years.at(-1)!.months.push(m);
  }
  return years;
}

/** Where a finished day stands among the finished days it is compared with. */
export interface DayStanding {
  /** 1 (one of your slower days) ... 4 (one of your faster days); a DNF ao5 is always 1 */
  level: 1 | 2 | 3 | 4;
  /** 1 = your best ao5; equal times share a rank, and DNFs come last */
  rank: number;
  /** your finished days */
  of: number;
}

/** First index in sorted `xs` whose value is >= v (or > v with `after`). */
function bound(xs: number[], v: number, after = false): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < v || (after && xs[mid] === v)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Every finished day's standing: the share of your other finished days it beat (a tie counts
 * half), in quarters. Your only finished day is your best.
 */
export function standings(days: DailyDay[]): Map<string, DayStanding> {
  const done = days.filter((d) => d.attempts >= 5 && d.ao5 !== null).map((d) => ({ date: d.date, v: d.ao5! < 0 ? Infinity : d.ao5! }));
  const sorted = done.map((d) => d.v).sort((a, b) => a - b);
  const n = sorted.length;
  const out = new Map<string, DayStanding>();
  for (const d of done) {
    const better = bound(sorted, d.v);
    const equal = bound(sorted, d.v, true) - better;
    const beaten = n === 1 ? 1 : (n - better - equal + (equal - 1) / 2) / (n - 1);
    const level = d.v === Infinity ? 1 : beaten >= 0.75 ? 4 : beaten >= 0.5 ? 3 : beaten >= 0.25 ? 2 : 1;
    out.set(d.date, { level, rank: better + 1, of: n });
  }
  return out;
}

export interface DayCell {
  key: string;
  week: number;
  /** 0 = sunday (rows run sun -> sat, as on the profile) */
  dow: number;
  /** false: filler before the range, or a day still to come */
  shown: boolean;
  day?: DailyDay;
  standing?: DayStanding;
  /** 0 = no finished challenge that day, 1-4 = its standing */
  level: number;
}

/**
 * The squares of a range, coloured by how each finished day compares with the others shown, the
 * month labels under them, and what the line under them says.
 */
export function buildDailyCalendar(range: DailyRange, today: string, days: DailyDay[]) {
  const { from, to } = rangeDays(range, today);
  const last = to < today ? to : today;
  const shownDays = days.filter((d) => d.date >= from && d.date <= last);
  const byDate = new Map(shownDays.map((d) => [d.date, d]));
  const ranks = standings(shownDays);
  const first = addDays(from, -new Date(keyToUtc(from)).getUTCDay());
  const weeks = Math.ceil((dayDiff(first, to) + 1) / 7);
  const cells: DayCell[] = [];
  let dayCount = 0;
  let finished = 0;
  let best: { date: string; ao5: number } | null = null;
  for (let w = 0; w < weeks; w++) {
    for (let dow = 0; dow < 7; dow++) {
      const key = addDays(first, w * 7 + dow);
      const shown = key >= from && key <= last;
      const day = shown ? byDate.get(key) : undefined;
      const standing = day ? ranks.get(key) : undefined;
      if (shown) dayCount++;
      if (standing) {
        finished++;
        if (day!.ao5! > 0 && (!best || day!.ao5! < best.ao5)) best = { date: key, ao5: day!.ao5! };
      }
      cells.push({ key, week: w, dow, shown, day, standing, level: standing?.level ?? 0 });
    }
  }
  // a month's name under the week holding its 1st, and under the first week when the range starts mid-month
  const months: { week: number; label: string }[] = [];
  for (let w = 0; w < weeks; w++) {
    for (let dow = 0; dow < 7; dow++) {
      const key = addDays(first, w * 7 + dow);
      if (key.endsWith('-01') && key >= from && key <= to) months.push({ week: w, label: MONTH_SHORT[Number(key.slice(5, 7)) - 1] });
    }
  }
  if (!from.endsWith('-01') && months[0]?.week !== 0) months.unshift({ week: 0, label: MONTH_SHORT[Number(from.slice(5, 7)) - 1] });
  return { cells, weeks, months, shownDays: dayCount, finished, best };
}

const ordinal = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
};

/** "your 3rd best of 24" (nothing when it's your only finished day). */
export function standingText(s: DayStanding): string {
  if (s.of < 2) return '';
  return s.rank === 1 ? `your best of ${s.of}` : `your ${ordinal(s.rank)} best of ${s.of}`;
}

/** "mon 16 nov", with the year when it isn't this year's; "today". */
export function dayName(key: string, today: string): string {
  if (key === today) return 'today';
  const [y, m, d] = key.split('-').map(Number);
  return `${WEEKDAYS[new Date(keyToUtc(key)).getUTCDay()]} ${d} ${MONTH_SHORT[m - 1]}${key.slice(0, 4) === today.slice(0, 4) ? '' : ` ${y}`}`;
}

/** The balloon over a square: what happened that day, and (second line) how it ranks. */
export function cellTip(c: DayCell, today: string, precision: Precision): [string, string?] {
  const when = dayName(c.key, today);
  if (c.standing && c.day && c.day.ao5 !== null) {
    if (c.day.ao5 < 0) return [`ao5 DNF - ${when}`];
    return [`ao5 ${formatTime(c.day.ao5, precision)} - ${when}`, standingText(c.standing) || undefined];
  }
  if (c.day) return [`${c.day.attempts} of 5 attempts - ${when}`, c.key === today ? undefined : 'not finished'];
  return [c.key === today ? 'not done yet today' : `no attempts - ${when}`];
}
