import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { CalendarDays } from 'lucide-react';
import { WidgetError } from './Widget';
import { addDaysKey, formatDayKey, monthShort, plural } from './util';
import { api } from '../../lib/api';
import { formatNumber, localDateKey } from '../../lib/format';
import type { ActivityDay } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { Spinner } from '../Spinner';

/**
 * Monkeytype's activity buckets: take the non-zero day counts, trim the top and bottom 10 %,
 * average the rest (m) → thresholds [floor(m/2), round(m), round(1.5m)]; above → level 4.
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
  const startDow = new Date(keyToUtc(from)).getUTCDay(); // 0 = Sunday (rows run sun → sat)
  const first = addDaysKey(from, -startDow);
  const last = to < today ? to : today;
  const weeks = Math.ceil((dayDiff(first, to) + 1) / 7);
  const inRange: number[] = [];
  const cells: Cell[] = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const key = addDaysKey(first, w * 7 + d);
      const visible = key >= from && key <= last;
      const count = visible ? counts.get(key) ?? 0 : null;
      if (count !== null) inRange.push(count);
      cells.push({ key, week: w, dow: d, count, level: 0 });
    }
  }
  const buckets = activityBuckets(inRange);
  for (const c of cells) if (c.count !== null) c.level = activityLevel(c.count, buckets);

  // month labels under the first week containing the 1st of each month (≥ 3 weeks apart)
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

/** GitHub/Monkeytype-style activity calendar of solves per day. */
export function ActivityHeatmap({ userId, joinedAt }: { userId: string; joinedAt: string }) {
  const today = localDateKey();
  const thisYear = Number(today.slice(0, 4));
  const joinYear = Math.max(thisYear - 4, new Date(joinedAt).getFullYear() || thisYear);
  const years = Array.from({ length: Math.max(0, thisYear - joinYear + 1) }, (_, i) => thisYear - i);
  const [range, setRange] = useState('last');
  const { from, to } = range === 'last' ? { from: addDaysKey(today, -364), to: today } : { from: `${range}-01-01`, to: `${range}-12-31` };

  const activity = useAsync((signal) => api.stats.activity(userId, from, to, signal), [userId, from, to]);
  const model = useMemo(() => buildCalendar(from, to, today, activity.data?.days ?? []), [from, to, today, activity.data]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ text: string; left: number; top: number } | null>(null);

  // on narrow screens the calendar scrolls horizontally: start at the most recent weeks
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [model.weeks, activity.data]);

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

  const label = range === 'last' ? 'in the last 12 months' : `in ${range}`;

  return (
    <section className="pv-card" aria-label="activity">
      <div className="pv-card-head">
        <h2 className="pv-title">
          <CalendarDays />
          <span>
            {activity.error && !activity.data ? (
              'activity'
            ) : (
              <>
                <span className="text">{activity.data ? plural(model.total, 'solve') : '…'}</span> {label}
              </>
            )}
          </span>
          {activity.loading && activity.data && <Spinner size={14} />}
        </h2>
        {years.length > 1 && (
          <select className="pv-select" value={range} onChange={(e) => setRange(e.target.value)} aria-label="activity range">
            <option value="last">last 12 months</option>
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </select>
        )}
      </div>

      {activity.error && !activity.data ? (
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
                opacity: activity.data ? 1 : 0.4,
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
            <span>days use the cuber&apos;s local time zone</span>
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
    </section>
  );
}
