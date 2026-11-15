import { dayKey, hourIn, isValidTimeZone } from '@cubr/common';
import { effectiveMs, type Penalty } from '@cubr/cubestats';

export interface DayAgg {
  day: string; // YYYY-MM-DD in the bucketing tz
  solves: number;
  totalMs: number; // raw time spent cubing (timeMs, without penalties)
}

export interface HourAgg {
  hour: number; // 0..23 in the bucketing tz
  solves: number; // non-DNF solves
  sumMs: number; // sum of effective times of non-DNF solves
  dnfs: number;
}

export interface BucketInput {
  timeMs: number;
  penalty: Penalty;
  createdAt: string | Date;
}

/** Returns the tz if it is a valid IANA name, otherwise null. */
export function validTz(tz: unknown): string | null {
  return typeof tz === 'string' && tz.length > 0 && tz.length <= 64 && isValidTimeZone(tz) ? tz : null;
}

const SLOT_MS = 15 * 60 * 1000;

/**
 * Returns a (date -> {day, hour}) function for one timezone. Every UTC offset in use is a multiple
 * of 15 minutes, so all instants inside the same 15-minute UTC slot share the same local day and
 * hour: results are memoised per slot, which makes bucketing 20k solves ~50x cheaper than calling
 * dayKey/hourIn (each builds an Intl formatter) for every solve.
 */
export function makeBucketer(tz: string): (date: Date) => { day: string; hour: number } {
  const memo = new Map<number, { day: string; hour: number }>();
  return (date: Date) => {
    const slot = Math.floor(date.getTime() / SLOT_MS);
    let hit = memo.get(slot);
    if (!hit) {
      const probe = new Date(slot * SLOT_MS);
      hit = { day: dayKey(probe, tz), hour: hourIn(probe, tz) };
      memo.set(slot, hit);
    }
    return hit;
  };
}

/** Aggregates solves into daily_activity and hourly rows (one event, one timezone). */
export function bucketSolves(solves: BucketInput[], tz: string): { days: DayAgg[]; hours: HourAgg[] } {
  const bucket = makeBucketer(tz);
  const days = new Map<string, DayAgg>();
  const hours = new Map<number, HourAgg>();
  for (const s of solves) {
    const { day, hour } = bucket(s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt));
    let d = days.get(day);
    if (!d) days.set(day, (d = { day, solves: 0, totalMs: 0 }));
    d.solves++;
    d.totalMs += s.timeMs;
    let h = hours.get(hour);
    if (!h) hours.set(hour, (h = { hour, solves: 0, sumMs: 0, dnfs: 0 }));
    const eff = effectiveMs(s);
    if (Number.isFinite(eff)) {
      h.solves++;
      h.sumMs += eff;
    } else {
      h.dnfs++;
    }
  }
  return {
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    hours: [...hours.values()].sort((a, b) => a.hour - b.hour),
  };
}
