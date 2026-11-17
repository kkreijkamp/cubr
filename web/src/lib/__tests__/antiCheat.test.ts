import { describe, expect, it } from 'vitest';
import { hiddenNote, missingNote } from '../antiCheat';

// local noon, so the date is the same in every timezone the tests run in
const at = new Date(2026, 10, 16, 12, 0, 0).toISOString();

describe('missingNote (why you are not on a board)', () => {
  it('names your refused best, when you did it, the limit, and what to do (all-time)', () => {
    expect(missingNote({ valueMs: 174, floorMs: 2_510, achievedAt: at }, 'all', 'single', 3)).toBe(
      "your best single, 0.174 on 16 Nov 2026, is faster than the world record, so it's left off as a likely mis-tap (times under 2.510 don't count). time a real solve and it counts.",
    );
  });

  it('says average for an ao5, and rounds to the precision you use', () => {
    expect(missingNote({ valueMs: 504, floorMs: 3_510, achievedAt: at }, 'all', 'ao5', 2)).toBe(
      "your best ao5, 0.50 on 16 Nov 2026, is faster than the world record average, so it's left off as a likely mis-tap (averages under 3.51 don't count). an ao5 of real solves counts.",
    );
  });

  it('on a day or week board: no advice (a past board stays as it is)', () => {
    expect(missingNote({ valueMs: 211, floorMs: 2_510, achievedAt: at }, 'daily', 'single', 3)).toBe(
      "your best single that day, 0.211, is faster than the world record, so it's left off as a likely mis-tap (times under 2.510 don't count).",
    );
    expect(missingNote({ valueMs: 211, floorMs: 2_510, achievedAt: at }, 'weekly', 'single', 3)).toBe(
      "your best single that week, 0.211 on 16 Nov 2026, is faster than the world record, so it's left off as a likely mis-tap (times under 2.510 don't count).",
    );
  });

  it("on the daily challenge, the day's ao5", () => {
    expect(missingNote({ valueMs: 1_000, floorMs: 2_600, achievedAt: null }, 'challenge', 'ao5', 2)).toBe(
      "your ao5, 1.00, is faster than the world record average, so it's left off as a likely mis-tap (averages under 2.60 don't count).",
    );
  });

  it('leaves the date out when it is unknown', () => {
    expect(missingNote({ valueMs: 174, floorMs: 2_510, achievedAt: null }, 'all', 'single', 3)).toMatch(/^your best single, 0\.174, is faster/);
  });
});

describe('hiddenNote (a faster time of yours was left off)', () => {
  it('names the time and why', () => {
    expect(hiddenNote({ valueMs: 300, floorMs: 2_510, achievedAt: at }, 3)).toBe("your 0.300 on 16 Nov 2026 isn't counted: it's faster than the world record, so it's taken for a mis-tap.");
  });
});
