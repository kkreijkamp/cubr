import { useMemo, useState } from 'react';
import type { ChartConfiguration } from 'chart.js';
import { Clock, TrendingDown } from 'lucide-react';
import { EVENTS } from '@cubetype/cubestats';
import { WidgetError } from './Widget';
import { eventLabel, plural } from './util';
import { api } from '../../lib/api';
import { formatDate, formatTime } from '../../lib/format';
import type { PbKind } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { ChartCanvas, themedScales, useThemeColors, type ThemeColors } from '../ChartCanvas';
import { Loading, Spinner } from '../Spinner';

const HEIGHT = 230;

/** Event picker shared by the profile charts. */
export function EventSelect({ events, value, onChange, label }: { events: string[]; value: string; onChange: (e: string) => void; label: string }) {
  const options = events.length ? events : EVENTS.map((e) => e.id);
  return (
    <select className="pv-select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {options.map((id) => (
        <option key={id} value={id}>
          {eventLabel(id)}
        </option>
      ))}
    </select>
  );
}

/** Tooltip styled like the app's balloon tooltips (sub background, bg text). */
function tooltipStyle(c: ThemeColors) {
  return {
    backgroundColor: c.sub,
    titleColor: c.bg,
    bodyColor: c.bg,
    titleFont: { family: c.font, size: 11, weight: 'normal' as const },
    bodyFont: { family: c.font, size: 12 },
    padding: 8,
    cornerRadius: 4,
    displayColors: false,
    caretSize: 5,
  };
}

/** Charts live on sub-alt cards, so the recessive grid uses the page background. */
function cardScales(c: ThemeColors, scales: Record<string, any>) {
  const themed = themedScales(c, scales);
  for (const s of Object.values(themed)) {
    s.grid = { ...s.grid, color: c.bg, tickColor: 'transparent' };
    s.border = { display: false };
  }
  return themed;
}

// ------------------------------------------------------------------------------- pb progression

/** One line per PB kind; the single gets the main colour, like Monkeytype's pb line. */
const PB_LINES: { kind: PbKind; ink: 'main' | 'text' | 'sub'; width: number; dash: number[] }[] = [
  { kind: 'single', ink: 'main', width: 3, dash: [] },
  { kind: 'ao5', ink: 'sub', width: 2, dash: [] },
  { kind: 'ao12', ink: 'text', width: 2, dash: [] },
  { kind: 'ao100', ink: 'text', width: 2, dash: [6, 4] },
];

/** "03 oct" for short spans, "oct '26" for long ones. */
function dateTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const mon = d.toLocaleString('en-US', { month: 'short' }).toLowerCase();
  return spanMs < 120 * 86_400_000 ? `${String(d.getDate()).padStart(2, '0')} ${mon}` : `${mon} '${String(d.getFullYear()).slice(2)}`;
}

/** Stepped PB progression per kind (api.stats.pbHistory): each line holds a PB until it is beaten. */
export function PbHistoryChart({ userId, events, defaultEvent, precision }: { userId: string; events: string[]; defaultEvent: string; precision: 2 | 3 }) {
  const [event, setEvent] = useState(defaultEvent);
  const colors = useThemeColors();
  const history = useAsync((signal) => api.stats.pbHistory(userId, event, signal), [userId, event]);

  const lines = useMemo(() => {
    const rows = history.data?.history ?? [];
    return PB_LINES.map((l) => ({ ...l, points: rows.filter((r) => r.kind === l.kind) })).filter((l) => l.points.length > 0);
  }, [history.data]);

  const config = useMemo((): ChartConfiguration<'line'> | null => {
    if (lines.length === 0) return null;
    const c = colors;
    const now = Date.now();
    const first = Math.min(...lines.map((l) => Date.parse(l.points[0].achievedAt)));
    const span = Math.max(1, now - first);
    const datasets: any[] = lines.map((l) => ({
      label: l.kind,
      // the current pb is repeated at "now" so every line reaches the right edge
      data: [...l.points.map((p) => ({ x: Date.parse(p.achievedAt), y: p.valueMs, at: p.achievedAt })), { x: now, y: l.points[l.points.length - 1].valueMs, at: null }],
      parsing: false,
      stepped: 'before', // hold the old pb across, then drop at the moment it was beaten
      borderColor: c[l.ink],
      backgroundColor: c[l.ink],
      borderWidth: l.width,
      borderDash: l.dash,
      pointRadius: (ctx: any) => (ctx.raw?.at ? 2.5 : 0),
      pointHoverRadius: (ctx: any) => (ctx.raw?.at ? 4 : 0),
      pointHitRadius: (ctx: any) => (ctx.raw?.at ? 6 : 0),
    }));
    return {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { labels: { color: c.sub, font: { family: c.font, size: 11 }, boxWidth: 12, boxHeight: 2 } },
          tooltip: {
            ...tooltipStyle(c),
            filter: (item) => Boolean((item.raw as { at: string | null }).at),
            callbacks: {
              title: (items) => formatDate((items[0]?.raw as { at: string | null } | undefined)?.at),
              label: (item) => `${item.dataset.label} ${formatTime(item.parsed.y, precision)}`,
            },
          },
        },
        // chart.js' time scale needs a date adapter; a linear axis over epoch ms with date ticks is enough here
        scales: cardScales(c, {
          x: { type: 'linear', min: first, max: now, ticks: { maxTicksLimit: 6, maxRotation: 0, callback: (v: number | string) => dateTick(Number(v), span) } },
          y: { ticks: { maxTicksLimit: 5, callback: (v: number | string) => formatTime(Number(v), 2) } },
        }),
      },
    };
  }, [lines, colors, precision]);

  return (
    <section className="pv-card" aria-label="pb progression">
      <div className="pv-card-head">
        <h2 className="pv-title">
          <TrendingDown /> pb progression {history.loading && history.data && <Spinner size={14} />}
        </h2>
        <div className="pv-head-tools">
          <EventSelect events={events} value={event} onChange={setEvent} label="pb progression event" />
        </div>
      </div>
      {history.error && !history.data ? (
        <WidgetError error={history.error} what="the pb progression" onRetry={history.reload} />
      ) : !history.data ? (
        <div style={{ height: HEIGHT }} className="pv-chart-empty">
          <Loading />
        </div>
      ) : !config ? (
        <div style={{ height: HEIGHT }} className="pv-chart-empty">
          no {eventLabel(event)} pbs yet
        </div>
      ) : (
        <ChartCanvas config={config} height={HEIGHT} />
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------- time of day

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

export function HourlyChart({ userId, events, defaultEvent, precision }: { userId: string; events: string[]; defaultEvent: string; precision: 2 | 3 }) {
  const [event, setEvent] = useState(defaultEvent);
  const [metric, setMetric] = useState<'solves' | 'mean'>('solves');
  const colors = useThemeColors();
  const hourly = useAsync((signal) => api.stats.hourly(userId, event, signal), [userId, event]);

  const hours = useMemo(() => {
    const by = new Map((hourly.data?.hours ?? []).map((h) => [h.hour, h]));
    return Array.from({ length: 24 }, (_, h) => by.get(h) ?? { hour: h, solves: 0, meanMs: null });
  }, [hourly.data]);
  const total = hours.reduce((a, h) => a + h.solves, 0);

  const insight = useMemo(() => {
    if (total === 0) return null;
    const busiest = hours.reduce((a, b) => (b.solves > a.solves ? b : a));
    const minSolves = Math.max(3, Math.ceil(total * 0.02));
    const candidates = hours.filter((h) => h.meanMs !== null && h.meanMs > 0 && h.solves >= minSolves);
    const fastest = candidates.length > 1 ? candidates.reduce((a, b) => (b.meanMs! < a.meanMs! ? b : a)) : null;
    return { busiest, fastest };
  }, [hours, total]);

  const config = useMemo((): ChartConfiguration<'bar'> => {
    const c = colors;
    return {
      type: 'bar',
      data: {
        labels: hours.map((h) => String(h.hour).padStart(2, '0')),
        datasets: [
          {
            label: metric,
            data: hours.map((h) => (metric === 'solves' ? h.solves : h.meanMs && h.meanMs > 0 ? h.meanMs : null)),
            backgroundColor: c.main,
            hoverBackgroundColor: c.text,
            borderRadius: 4,
            barPercentage: 0.82,
            categoryPercentage: 0.92,
          },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle(c),
            callbacks: {
              title: (items) => {
                const h = items[0]?.dataIndex ?? 0;
                return `${hh(h)} – ${String(h).padStart(2, '0')}:59`;
              },
              label: (item) => {
                const h = hours[item.dataIndex];
                const lines = [plural(h.solves, 'solve')];
                if (h.meanMs && h.meanMs > 0) lines.push(`mean ${formatTime(h.meanMs, precision)}`);
                return lines;
              },
            },
          },
        },
        scales: cardScales(c, {
          x: {
            grid: { display: false },
            ticks: { autoSkip: false, maxRotation: 0, callback: (_v: unknown, i: number) => (i % 3 === 0 ? String(i).padStart(2, '0') : '') },
          },
          y: {
            beginAtZero: true,
            ticks:
              metric === 'solves'
                ? { maxTicksLimit: 5, precision: 0 }
                : { maxTicksLimit: 5, callback: (v: number | string) => formatTime(Number(v), 2) },
          },
        }),
      },
    };
  }, [hours, metric, colors, precision]);

  return (
    <section className="pv-card" aria-label="time of day">
      <div className="pv-card-head">
        <h2 className="pv-title">
          <Clock /> time of day {hourly.loading && hourly.data && <Spinner size={14} />}
        </h2>
        <div className="pv-head-tools">
          <div className="pv-seg" role="group" aria-label="metric">
            {(['solves', 'mean'] as const).map((m) => (
              <button key={m} className={`btn-text${metric === m ? ' active' : ''}`} aria-pressed={metric === m} onClick={() => setMetric(m)}>
                {m}
              </button>
            ))}
          </div>
          <EventSelect events={events} value={event} onChange={setEvent} label="time of day event" />
        </div>
      </div>
      {hourly.error && !hourly.data ? (
        <WidgetError error={hourly.error} what="the time-of-day chart" onRetry={hourly.reload} />
      ) : !hourly.data ? (
        <div style={{ height: HEIGHT }} className="pv-chart-empty">
          <Loading />
        </div>
      ) : total === 0 ? (
        <div style={{ height: HEIGHT }} className="pv-chart-empty">
          no {eventLabel(event)} solves yet
        </div>
      ) : (
        <>
          <ChartCanvas config={config} height={HEIGHT} />
          {insight && (
            <div className="pv-insight">
              most solves around <b>{hh(insight.busiest.hour)}</b>
              {insight.fastest && (
                <>
                  {' '}
                  · fastest around <b>{hh(insight.fastest.hour)}</b> (mean {formatTime(insight.fastest.meanMs!, precision)})
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
