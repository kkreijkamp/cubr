const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' → whole days since 1970-01-01 (calendar arithmetic, no timezone involved). */
export function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** Inverse of dayNumber. */
export function dayString(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** `day` shifted by `delta` calendar days. */
export function addDays(day: string, delta: number): string {
  return dayString(dayNumber(day) + delta);
}

export interface Streaks {
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
}

/**
 * Streaks over the set of active days (each 'YYYY-MM-DD', bucketed in the user's timezone).
 * currentStreak = run of consecutive days ending today or yesterday (a day "ahead" of `today` —
 * possible when the days were bucketed in a timezone east of the one `today` was computed in —
 * also counts as today). longestStreak = longest run anywhere.
 */
export function computeStreaks(days: Iterable<string>, today: string): Streaks {
  const nums = [...new Set([...days].map(dayNumber))].sort((a, b) => a - b);
  if (nums.length === 0) return { activeDays: 0, currentStreak: 0, longestStreak: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < nums.length; i++) {
    run = nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  // `run` is now the length of the run ending at the latest active day
  const last = nums[nums.length - 1];
  const current = last >= dayNumber(today) - 1 ? run : 0;
  return { activeDays: nums.length, currentStreak: current, longestStreak: longest };
}
