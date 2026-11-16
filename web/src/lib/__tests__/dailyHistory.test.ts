import { describe, expect, it } from 'vitest';
import { buildDailyCalendar, cellTip, dayName, monthLabel, rangeDays, rangeMonths, standings, standingText } from '../dailyHistory';
import type { DailyDay } from '../types';

const done = (date: string, ao5: number): DailyDay => ({ date, attempts: 5, ao5 });
const TODAY = '2026-11-17'; // a tuesday

describe('rangeDays', () => {
  it('the last 30 days end today', () => {
    expect(rangeDays('last', TODAY)).toEqual({ from: '2026-10-19', to: TODAY });
    expect(rangeDays('last', '2026-03-01')).toEqual({ from: '2026-01-31', to: '2026-03-01' });
  });
  it('a month runs from its 1st to its last day', () => {
    expect(rangeDays('2026-11', TODAY)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(rangeDays('2026-02', TODAY)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(rangeDays('2028-02', TODAY)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(rangeDays('2025-12', TODAY)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
  it('anything else is the last 30 days', () => {
    expect(rangeDays('2026-13', TODAY)).toEqual(rangeDays('last', TODAY));
    expect(rangeDays('nonsense', TODAY)).toEqual(rangeDays('last', TODAY));
  });
});

describe('rangeMonths', () => {
  it('lists the months with an attempt, newest first, by year', () => {
    const days = [done('2025-12-30', 10_000), { date: '2026-01-02', attempts: 2, ao5: null }, done('2026-11-01', 9_000), done('2026-11-16', 9_500)];
    expect(rangeMonths(days)).toEqual([
      { year: 2026, months: ['2026-11', '2026-01'] },
      { year: 2025, months: ['2025-12'] },
    ]);
  });
  it('keeps the month picked before, also without attempts in this event', () => {
    expect(rangeMonths([done('2026-11-01', 9_000)], '2026-03')).toEqual([{ year: 2026, months: ['2026-11', '2026-03'] }]);
    expect(rangeMonths([], 'last')).toEqual([]);
  });
  it('names a month', () => {
    expect(monthLabel('2026-11')).toBe('november 2026');
    expect(monthLabel('2027-01')).toBe('january 2027');
  });
});

describe('standings (how a day compares with your other days)', () => {
  const levels = (days: DailyDay[]) => days.map((d) => standings(days).get(d.date)?.level);
  it('splits your finished days into quarters, the fastest brightest', () => {
    const four = [done('2026-11-01', 10_000), done('2026-11-02', 20_000), done('2026-11-03', 30_000), done('2026-11-04', 40_000)];
    expect(levels(four)).toEqual([4, 3, 2, 1]);
    const five = [...four, done('2026-11-05', 50_000)];
    expect(levels(five)).toEqual([4, 4, 3, 2, 1]);
    expect([...standings(five).values()].map((s) => [s.rank, s.of])).toEqual([
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
      [5, 5],
    ]);
  });
  it('compares with every finished day it is given', () => {
    const days = [done('2025-01-01', 40_000), done('2025-01-02', 41_000), done('2025-01-03', 42_000), done('2026-11-01', 20_000), done('2026-11-02', 21_000)];
    expect(levels(days)).toEqual([3, 2, 1, 4, 4]); // 40.00 beats 41 and 42: half of the other four
  });
  it('your only finished day is your best', () => {
    expect(standings([done('2026-11-01', 30_000)]).get('2026-11-01')).toEqual({ level: 4, rank: 1, of: 1 });
  });
  it('equal times share a rank', () => {
    const days = [done('2026-11-01', 10_000), done('2026-11-02', 10_000), done('2026-11-03', 20_000)];
    const s = standings(days);
    expect([...s.values()].map((x) => [x.level, x.rank])).toEqual([
      [4, 1],
      [4, 1],
      [1, 3],
    ]);
  });
  it('a DNF ao5 is the dullest and ranks last', () => {
    const days = [done('2026-11-01', 10_000), done('2026-11-02', -1), done('2026-11-03', -1)];
    const s = standings(days);
    expect(s.get('2026-11-01')).toEqual({ level: 4, rank: 1, of: 3 });
    expect(s.get('2026-11-02')).toEqual({ level: 1, rank: 2, of: 3 });
    expect(standings([done('2026-11-02', -1)]).get('2026-11-02')?.level).toBe(1);
  });
  it('leaves out days without all five attempts', () => {
    const s = standings([done('2026-11-01', 10_000), { date: '2026-11-02', attempts: 3, ao5: null }]);
    expect(s.has('2026-11-02')).toBe(false);
    expect(s.get('2026-11-01')?.of).toBe(1);
  });
});

describe('buildDailyCalendar', () => {
  it('the last 30 days: whole weeks, sunday first, labelled by month', () => {
    const cal = buildDailyCalendar('last', TODAY, []);
    expect(cal.weeks).toBe(5); // sun 18 oct ... sat 21 nov
    expect(cal.cells[0]).toMatchObject({ key: '2026-10-18', week: 0, dow: 0, shown: false });
    expect(cal.cells[1]).toMatchObject({ key: '2026-10-19', shown: true, level: 0 });
    expect(cal.cells.filter((c) => c.shown).map((c) => c.key)).toHaveLength(30);
    expect(cal.cells.find((c) => c.key === '2026-11-18')?.shown).toBe(false); // tomorrow
    expect(cal.months).toEqual([
      { week: 0, label: 'oct' },
      { week: 2, label: 'nov' },
    ]);
    expect(cal.shownDays).toBe(30);
  });
  it('a month: up to today when it is this one, all of it when it is over', () => {
    const now = buildDailyCalendar('2026-11', TODAY, []);
    expect(now.weeks).toBe(5);
    expect(now.shownDays).toBe(17);
    expect(now.months).toEqual([{ week: 0, label: 'nov' }]);
    const feb = buildDailyCalendar('2026-02', TODAY, []);
    expect(feb.weeks).toBe(4); // 1 feb 2026 is a sunday
    expect(feb.shownDays).toBe(28);
  });
  it('colours each finished day against the others shown, and finds the best one', () => {
    const days = [done('2026-10-01', 9_000), done('2026-11-02', 12_000), done('2026-11-03', 11_000), done('2026-11-04', -1), { date: '2026-11-05', attempts: 2, ao5: null }];
    const cal = buildDailyCalendar('2026-11', TODAY, days);
    const cell = (k: string) => cal.cells.find((c) => c.key === k)!;
    expect(cell('2026-11-03')).toMatchObject({ level: 4, standing: { rank: 1, of: 3 } }); // october's 9.00 isn't shown
    expect(cell('2026-11-02')).toMatchObject({ level: 3, standing: { rank: 2, of: 3 } });
    expect(cell('2026-11-04').level).toBe(1);
    expect(cell('2026-11-05')).toMatchObject({ level: 0, day: { attempts: 2 } });
    expect(cell('2026-11-05').standing).toBeUndefined();
    expect(cal.finished).toBe(3);
    expect(cal.best).toEqual({ date: '2026-11-03', ao5: 11_000 });
    expect(buildDailyCalendar('2026-11', TODAY, [done('2026-11-04', -1)]).best).toBeNull();
  });
  it('a day can look different in another range: it is compared with what is shown', () => {
    const days = [done('2026-10-20', 9_000), done('2026-10-30', 10_000), done('2026-11-02', 12_000), done('2026-11-03', 11_000)];
    const level = (range: string) => buildDailyCalendar(range, TODAY, days).cells.find((c) => c.key === '2026-11-03')!.level;
    expect(level('2026-11')).toBe(4); // the best of november
    expect(level('last')).toBe(2); // third of four in the last 30 days
  });
  it('leaves days after today and before the range out', () => {
    const days = [done('2026-11-16', 9_000), done('2026-11-17', 10_000)];
    const cal = buildDailyCalendar('last', '2026-11-16', days);
    expect(cal.cells.find((c) => c.key === '2026-11-17')).toMatchObject({ shown: false, level: 0 });
    expect(cal.cells.find((c) => c.key === '2026-11-16')?.standing).toEqual({ level: 4, rank: 1, of: 1 });
  });
});

describe('standingText', () => {
  it('reads as a rank among your days', () => {
    const t = (rank: number, of = 200) => standingText({ level: 1, rank, of });
    expect(t(1)).toBe('your best of 200');
    expect([2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map((r) => t(r))).toEqual(
      ['2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '112th'].map((o) => `your ${o} best of 200`),
    );
    expect(standingText({ level: 4, rank: 1, of: 1 })).toBe('');
  });
});

describe('the balloons over the squares', () => {
  const cal = buildDailyCalendar('last', TODAY, [
    done('2026-11-02', 12_345),
    done('2026-11-03', 11_000),
    done('2026-11-04', -1),
    { date: '2026-11-05', attempts: 3, ao5: null },
    { date: TODAY, attempts: 2, ao5: null },
  ]);
  const tip = (key: string, precision: 2 | 3 = 2) => cellTip(cal.cells.find((c) => c.key === key)!, TODAY, precision);
  it('a finished day: its ao5 in your precision, the day, and its rank among those shown', () => {
    expect(tip('2026-11-03')).toEqual(['ao5 11.00 - tue 3 nov', 'your best of 3']);
    expect(tip('2026-11-02', 3)).toEqual(['ao5 12.345 - mon 2 nov', 'your 2nd best of 3']);
  });
  it('a DNF, an unfinished day, an empty day, and today', () => {
    expect(tip('2026-11-04')).toEqual(['ao5 DNF - wed 4 nov']);
    expect(tip('2026-11-05')).toEqual(['3 of 5 attempts - thu 5 nov', 'not finished']);
    expect(tip(TODAY)).toEqual(['2 of 5 attempts - today', undefined]);
    expect(tip('2026-11-06')).toEqual(['no attempts - fri 6 nov']);
    expect(cellTip({ ...cal.cells.find((c) => c.key === TODAY)!, day: undefined }, TODAY, 2)).toEqual(['not done yet today']);
  });
  it('your only finished day has no rank line', () => {
    const one = buildDailyCalendar('last', TODAY, [done('2026-11-03', 11_000)]);
    expect(cellTip(one.cells.find((c) => c.key === '2026-11-03')!, TODAY, 2)).toEqual(['ao5 11.00 - tue 3 nov', undefined]);
  });
  it('names days of other years with the year', () => {
    expect(dayName('2025-12-31', TODAY)).toBe('wed 31 dec 2025');
    expect(dayName('2026-01-01', TODAY)).toBe('thu 1 jan');
    expect(dayName(TODAY, TODAY)).toBe('today');
  });
});
