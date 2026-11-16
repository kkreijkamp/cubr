import { memo, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ChevronDownIcon, Squares2X2Icon } from '@heroicons/react/24/outline';
import { formatTime, getEvent, type Precision } from '@cubr/cubestats';
import { api, ApiError } from '../../../lib/api';
import { buildDailyCalendar, cellTip, monthLabel, rangeMonths, type DailyRange } from '../../../lib/dailyHistory';
import { useAsync } from '../../../lib/useAsync';
import { ErrorState, Spinner } from '../../Spinner';

/**
 * Your daily challenges in one event, as a small calendar like the profile's activity: the last
 * 30 days or a month you pick, one square per UTC day. The brighter a square, the better that
 * day's ao5 was among your finished days shown. (memo: the page re-renders every second for its
 * countdown.)
 */
export const DailyHistory = memo(function DailyHistory({
  event,
  today,
  refreshKey,
  userId,
  precision,
}: {
  event: string;
  /** the UTC day ('YYYY-MM-DD') */
  today: string;
  refreshKey: number;
  userId: string;
  precision: Precision;
}) {
  const [range, setRange] = useState<DailyRange>('last');
  const history = useAsync((signal) => api.solves.dailyHistory(event, signal), [event, refreshKey, userId]);
  // useAsync keeps the previous answer while reloading: never colour this event with another's days
  const data = history.data?.event === event ? history.data : undefined;
  const cal = useMemo(() => buildDailyCalendar(range, today, data?.days ?? []), [range, today, data]);
  const years = useMemo(() => rangeMonths(data?.days ?? [], range), [data, range]);
  const eventName = getEvent(event)?.short ?? event;

  const wrapRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ lines: [string, string?]; left: number; top: number } | null>(null);
  const byKey = useMemo(() => new Map(cal.cells.map((c) => [c.key, c])), [cal]);
  const onOver = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-day]');
    const cell = el ? byKey.get(el.dataset.day!) : undefined;
    const wrap = wrapRef.current;
    if (!el || !cell || !wrap) return setTip(null);
    const w = wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const half = 90; // keeps the balloon inside the card
    setTip({ lines: cellTip(cell, today, precision), left: Math.min(Math.max(r.left - w.left + r.width / 2, half), w.width - half), top: r.top - w.top });
  };

  const rangeText = range === 'last' ? 'the last 30 days' : monthLabel(range);
  const summary = !data
    ? '...'
    : cal.finished > 0
      ? null
      : (data.days.length === 0 ? 'finish a daily challenge and it shows here' : `nothing finished in ${rangeText}`);

  return (
    <section className="card daily-history" aria-labelledby="dhist-title">
      <div className="live-section-title">
        <h3 className="h3" id="dhist-title">
          <Squares2X2Icon /> your results
        </h3>
        <span className="meta">
          {history.loading && data ? <Spinner size={12} /> : null}{' '}
          {years.length > 0 ? (
            // reads as text; the invisible select on top opens the native picker (as on the profile)
            <span className="hm-range">
              <span aria-hidden="true">{rangeText}</span>
              <ChevronDownIcon />
              <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="days shown">
                <option value="last">the last 30 days</option>
                {years.map((y) => (
                  <optgroup key={y.year} label={String(y.year)}>
                    {y.months.map((m) => (
                      <option key={m} value={m}>
                        {monthLabel(m)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </span>
          ) : (
            rangeText
          )}
        </span>
      </div>

      {history.error && !data ? (
        <ErrorState
          error={history.error instanceof ApiError && history.error.isUnavailable ? new Error('your results are unavailable right now') : history.error}
          onRetry={history.reload}
        />
      ) : (
        <div className="hm-wrap" ref={wrapRef}>
          <div
            className="dh-grid"
            role="img"
            aria-label={`your ${eventName} daily challenges in ${rangeText}: ${cal.finished} of ${cal.shownDays} days finished${cal.best ? `, best ao5 ${formatTime(cal.best.ao5, precision)}` : ''}`}
            style={{ gridTemplateColumns: `auto repeat(${cal.weeks}, var(--dh-cell))`, opacity: data ? 1 : 0.4 }}
            onMouseOver={onOver}
            onMouseLeave={() => setTip(null)}
          >
            {['mon', 'wed', 'fri'].map((d, i) => (
              <span key={d} className="hm-day" style={{ gridColumn: 1, gridRow: i * 2 + 2 }}>
                {d}
              </span>
            ))}
            {cal.cells.map((c) =>
              c.shown ? (
                <div
                  key={c.key}
                  className="hm-cell"
                  data-day={c.key}
                  data-level={c.level}
                  style={{ gridColumn: c.week + 2, gridRow: c.dow + 1 }}
                />
              ) : (
                <div key={c.key} className="hm-cell" style={{ gridColumn: c.week + 2, gridRow: c.dow + 1 }} />
              ),
            )}
            {cal.months.map((m) => (
              <span key={`${m.week}-${m.label}`} className="hm-month" style={{ gridColumn: m.week + 2, gridRow: 8 }}>
                {m.label}
              </span>
            ))}
          </div>
          {tip && (
            <div className="hm-tip dh-tip" style={{ left: tip.left, top: tip.top }} role="tooltip">
              <span>{tip.lines[0]}</span>
              {tip.lines[1] && <span className="dh-tip-more">{tip.lines[1]}</span>}
            </div>
          )}
          <div className="hm-foot">
            <span>
              {summary ?? (
                <>
                  <b>{cal.finished}</b> of {cal.shownDays} days
                  {cal.best && (
                    <>
                      {' '}
                      - best <b>{formatTime(cal.best.ao5, precision)}</b>
                    </>
                  )}
                </>
              )}
            </span>
            <span className="hm-legend" data-tip={'compared with your\nother days shown'} data-tip-pos="left">
              <span>slower</span>
              {[1, 2, 3, 4].map((l) => (
                <i key={l} data-level={l} />
              ))}
              <span>faster</span>
            </span>
          </div>
        </div>
      )}
    </section>
  );
});
