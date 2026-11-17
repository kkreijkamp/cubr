// What the leaderboard page says when the anti-cheat left the signed-in user's best time off a board.
// A time faster than the world record is almost always a mis-tap (the timer started and stopped at
// once), so it isn't ranked; the server keeps the user's lowest refused time per board and sends
// it to them alone (`flagged`).
import { formatDate, formatTime } from './format';

/** The user's own refused best on a board (GET /api/leaderboards/...: `flagged`). */
export interface FlaggedTime {
  valueMs: number;
  /** the limit it is under: the WCA world record (or a fallback a quarter below it) */
  floorMs: number;
  achievedAt: string | null;
}

export type BoardPeriod = 'all' | 'weekly' | 'daily' | 'challenge';
type Precision = 2 | 3;

const onDate = (f: FlaggedTime) => (f.achievedAt ? ` on ${formatDate(f.achievedAt)}` : '');

/** Shown instead of your rank when the anti-cheat is why you aren't on the board. */
export function missingNote(f: FlaggedTime, period: BoardPeriod, kind: string, precision: Precision): string {
  const time = formatTime(f.valueMs, precision);
  const average = kind !== 'single';
  const record = average ? 'the world record average' : 'the world record';
  const limit = `${average ? 'averages' : 'times'} under ${formatTime(f.floorMs, precision)} don't count`;
  if (period === 'challenge') return `your ao5, ${time}, is faster than ${record}, so it's left off as a likely mis-tap (${limit}).`;
  const which = period === 'daily' ? `your best ${kind} that day, ${time},` : `your best ${kind}${period === 'weekly' ? ' that week' : ''}, ${time}${onDate(f)},`;
  // all-time boards rank your best real time, so missing means there is none of this kind yet
  const fix = period === 'all' ? (average ? ` an ${kind} of real solves counts.` : ' time a real solve and it counts.') : '';
  return `${which} is faster than ${record}, so it's left off as a likely mis-tap (${limit}).${fix}`;
}

/** Shown by your rank when a faster time of yours was left off. */
export function hiddenNote(f: FlaggedTime, precision: Precision): string {
  return `your ${formatTime(f.valueMs, precision)}${onDate(f)} isn't counted: it's faster than the world record, so it's taken for a mis-tap.`;
}
