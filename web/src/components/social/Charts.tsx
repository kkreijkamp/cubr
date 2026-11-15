import { useMemo, useState } from 'react';
import type { ChartConfiguration } from 'chart.js';
import { Section, WidgetError } from './Widget';
import { eventLabel, plural } from './util';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { ChartCanvas, themedScales, useThemeColors, type ThemeColors } from '../ChartCanvas';
import { Loading, Spinner } from '../Spinner';

const HEIGHT = 120;

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

/** Charts sit on the page background: faint grid lines, no axis borders. */
function pageScales(c: ThemeColors, scales: Record<string, any>) {
  const themed = themedScales(c, scales);
  for (const s of Object.values(themed)) {
    s.grid = { ...s.grid, color: c.subAlt, tickColor: 'transparent' };
    s.border = { display: false };
  }
  return themed;
}

// ------------------------------------------------------------------------------- time of day

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

export function HourlyChart({ userId, event, precision }: { userId: string; event: string; precision: 2 | 3 }) {
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
            borderRadius: 3,
            barPercentage: 0.7,
            categoryPercentage: 0.9,
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
                return `${hh(h)} - ${String(h).padStart(2, '0')}:59`;
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
        scales: pageScales(c, {
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
    <Section
      label="time of day"
      title="time of day"
      extra={hourly.loading && hourly.data && <Spinner size={12} />}
      tools={
        <div className="pv-seg" role="group" aria-label="metric">
          {(['solves', 'mean'] as const).map((m) => (
            <button key={m} className={`btn-text${metric === m ? ' active' : ''}`} aria-pressed={metric === m} onClick={() => setMetric(m)}>
              {m}
            </button>
          ))}
        </div>
      }
    >
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
              busiest <b>{hh(insight.busiest.hour)}</b>
              {insight.fastest && (
                <>
                  {' '}
                  - fastest <b>{hh(insight.fastest.hour)}</b> (mean {formatTime(insight.fastest.meanMs!, precision)})
                </>
              )}
            </div>
          )}
        </>
      )}
    </Section>
  );
}
