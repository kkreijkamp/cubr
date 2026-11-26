import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { Section, WidgetError } from './Widget';
import { addDaysKey, formatDayKey, monthShort, plural } from './util';
import { api } from '../../lib/api';
import { formatNumber, localDateKey } from '../../lib/format';
import type { ActivityDay } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { Spinner } from '../Spinner';

/**
 * Monkeytype's activity buckets: take the non-zero day counts, trim the top and bottom 10 %,
 * average the rest (m) -> thresholds [floor(m/2), round(m), round(1.5m)]; above -> level 4.
 */
export function activityBuckets(counts: number[]): [number, number, number] {
  const filtered = counts.filter((c) => c > 0).sort((a, b) => a - b);
  if (filtered.length === 0) return [0, 0, 0];
  const trim = Math.round(filtered.length * 0.1);
  let trimmed = filtered.slice(trim, filtered.length - trim);
  if (trimmed.length === 0) trimmed = filtered;
  const m = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  return [Math.floor(m / 2), Math.round(m), Math.round(m * 1.5)];
}

export function activityLevel(count: number, buckets: [number, number, number]): number {
  if (count <= 0) return 0;
  if (count <= buckets[0]) return 1;
  if (count <= buckets[1]) return 2;
  if (count <= buckets[2]) return 3;
  return 4;
}

const keyToUtc = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const dayDiff = (a: string, b: string) => Math.round((keyToUtc(b) - keyToUtc(a)) / 86_400_000);

interface Cell {
  key: string;
  week: number;
  dow: number;
  /** null = outside the range (filler) */
  count: number | null;
  level: number;
}

function buildCalendar(from: string, to: string, today: string, days: ActivityDay[]) {
  const counts = new Map(days.map((d) => [d.date, d.solves]));
  const startDow = new Date(keyToUtc(from)).getUTCDay(); // 0 = Sunday (rows run sun -> sat)
  const first = addDaysKey(from, -startDow);
  const last = to < today ? to : today;
  const weeks = Math.ceil((dayDiff(first, to) + 1) / 7);
  const inRange: number[] = [];
  const cells: Cell[] = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const key = addDaysKey(first, w * 7 + d);
      const visible = key >= from && key <= last;
      const count = visible ? (counts.get(key) ?? 0) : null;
      if (count !== null) inRange.push(count);
      cells.push({ key, week: w, dow: d, count, level: 0 });
    }
  }
  const buckets = activityBuckets(inRange);
  for (const c of cells) if (c.count !== null) c.level = activityLevel(c.count, buckets);

  // month labels under the first week containing the 1st of each month (>= 3 weeks apart)
  const months: { week: number; label: string }[] = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const key = addDaysKey(first, w * 7 + d);
      if (key.endsWith('-01') && key >= from && key <= to) months.push({ week: w, label: monthShort(Number(key.slice(5, 7)) - 1) });
    }
  }
  if (!from.endsWith('-01') && (months.length === 0 || months[0].week >= 3)) {
    months.unshift({ week: 0, label: monthShort(Number(from.slice(5, 7)) - 1) });
  }
  const spaced = months.filter((m, i) => i === 0 || m.week - months[i - 1].week >= 3);
  const total = inRange.reduce((a, b) => a + b, 0);
  return { cells, weeks, months: spaced, total };
}

/**
 * GitHub/Monkeytype-style activity calendar of solves per day. The title's range ("the last 12 months")
 * doubles as a picker for the calendar years in `years` (the ones with solves, newest first).
 */
export function ActivityHeatmap({ userId, event, years = [] }: { userId: string; event?: string; years?: number[] }) {
  const today = localDateKey();
  const [range, setRange] = useState('last');
  const { from, to } = range === 'last' ? { from: addDaysKey(today, -364), to: today } : { from: `${range}-01-01`, to: `${range}-12-31` };

  const activity = useAsync((signal) => api.stats.activity(userId, from, to, signal, event), [userId, from, to, event]);
  // useAsync keeps the previous range's days while the next one loads: only use days for this range
  const data = activity.data?.from === from && activity.data.to === to ? activity.data : undefined;
  const model = useMemo(() => buildCalendar(from, to, today, data?.days ?? []), [from, to, today, data]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ text: string; left: number; top: number } | null>(null);

  // on narrow screens the calendar scrolls horizontally: start at the most recent weeks
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [model.weeks, data]);

  const onOver = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-day]');
    const wrap = wrapRef.current;
    if (!el || !wrap) return setTip(null);
    const count = Number(el.dataset.count);
    const w = wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const half = 115; // keep the balloon inside the card
    const left = Math.min(Math.max(r.left - w.left + r.width / 2, half), w.width - half);
    setTip({
      text: `${count === 0 ? 'no solves' : plural(count, 'solve')} on ${formatDayKey(el.dataset.day!)}`,
      left,
      top: r.top - w.top,
    });
  };

  // the line under the calendar: how many days had solves, and the biggest one
  const summary = useMemo(() => {
    const days = (data?.days ?? []).filter((d) => d.solves > 0 && d.date >= from && d.date <= to);
    const busiest = days.reduce<(typeof days)[number] | null>((a, d) => (!a || d.solves > a.solves ? d : a), null);
    return { active: days.length, busiest };
  }, [data, from, to]);

  const rangeLabel = range === 'last' ? 'the last 12 months' : range;
  const label = `in ${rangeLabel}`;

  return (
    <Section
      label="activity"
      className="pf-activity"
      title="activity"
      extra={
        <span className="pv-title">
          <span>
            {activity.error && !data ? 'activity' : <span className="text">{data ? plural(model.total, 'solve') : '...'}</span>} in{' '}
            {years.length > 0 ? (
              // reads as part of the title; the invisible select on top opens the native picker
              <span className="hm-range">
                <span aria-hidden="true">{rangeLabel}</span>
                <ChevronDownIcon />
                <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="activity range">
                  <option value="last">the last 12 months</option>
                  {years.map((y) => (
                    <option key={y} value={String(y)}>
                      {y}
                    </option>
                  ))}
                </select>
              </span>
            ) : (
              rangeLabel
            )}
          </span>
          {activity.loading && activity.data && <Spinner size={12} />}
        </span>
      }
    >
      {activity.error && !data ? (
        <WidgetError error={activity.error} what="activity data" onRetry={activity.reload} />
      ) : (
        <div className="hm-wrap" ref={wrapRef}>
          <div className="hm-scroll" ref={scrollRef}>
            <div
              className="hm-grid"
              role="img"
              aria-label={`${formatNumber(model.total)} solves ${label}`}
              style={{
                gridTemplateColumns: `auto repeat(${model.weeks}, minmax(0, 1fr))`,
                gridTemplateRows: 'repeat(7, auto) auto',
                opacity: data ? 1 : 0.4,
              }}
              onMouseOver={onOver}
              onMouseLeave={() => setTip(null)}
            >
              {['mon', 'wed', 'fri'].map((d, i) => (
                <span key={d} className="hm-day" style={{ gridColumn: 1, gridRow: i * 2 + 2 }}>
                  {d}
                </span>
              ))}
              {model.cells.map((c) =>
                c.count === null ? (
                  <div key={c.key} className="hm-cell" style={{ gridColumn: c.week + 2, gridRow: c.dow + 1 }} />
                ) : (
                  <div
                    key={c.key}
                    className="hm-cell"
                    data-day={c.key}
                    data-count={c.count}
                    data-level={c.level}
                    style={{ gridColumn: c.week + 2, gridRow: c.dow + 1 }}
                  />
                ),
              )}
              {model.months.map((m) => (
                <span key={`${m.week}-${m.label}`} className="hm-month" style={{ gridColumn: `${m.week + 2} / span 3`, gridRow: 8 }}>
                  {m.label}
                </span>
              ))}
            </div>
          </div>
          {tip && (
            <div className="hm-tip" style={{ left: tip.left, top: tip.top }} role="tooltip">
              {tip.text}
            </div>
          )}
          <div className="hm-foot">
            <span data-tip="days use the cuber's local time zone">
              {data && summary.busiest ? (
                <>
                  <b>{formatNumber(summary.active)}</b> active {summary.active === 1 ? 'day' : 'days'} - busiest{' '}
                  <b>{formatDayKey(summary.busiest.date, false)}</b> ({plural(summary.busiest.solves, 'solve')})
                </>
              ) : data ? (
                "days use the cuber's local time zone"
              ) : (
                // loading: an invisible stand-in for the line above, which may wrap to two lines on a phone
                <span className="reserve" aria-hidden="true">
                  <b>000</b> active days - busiest <b>00 sep 2026</b> (00 solves)
                </span>
              )}
            </span>
            <span className="hm-legend" aria-hidden="true">
              <span>less</span>
              {[0, 1, 2, 3, 4].map((l) => (
                <i key={l} data-level={l} />
              ))}
              <span>more</span>
            </span>
          </div>
        </div>
      )}
    </Section>
  );
}
