import { dayKey, hourIn, isValidTimeZone } from '@cubetype/common';

/** Returns the tz if it is a valid IANA name, otherwise null. */
export function validTz(tz: unknown): string | null {
  return typeof tz === 'string' && tz.length > 0 && tz.length <= 64 && isValidTimeZone(tz) ? tz : null;
}

const SLOT_MS = 15 * 60 * 1000;

/**
 * Returns a (date → {day, hour}) function for one timezone. Every UTC offset in use is a multiple
 * of 15 minutes, so all instants inside the same 15-minute UTC slot share the same local day and
 * hour: results are memoised per slot, which makes bucketing 20k solves ~50× cheaper than calling
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
