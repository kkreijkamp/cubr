import { memo, useMemo, useState } from 'react';
import { ChartColumn, ChartLine } from 'lucide-react';
import type { ChartConfiguration } from 'chart.js';
import { formatTime, type Precision } from '@cubetype/cubestats';
import { ChartCanvas, themedScales, useThemeColors, type ThemeColors } from '../ChartCanvas';
import { fmtAvg, histogram, shortTime, strideIndices } from './statsUtil';
import { formatNumber } from '../../lib/format';
import { noFocus } from './ConfigBar';

const MAX_POINTS = 1500;

/** "#e2b714" + "99" → "#e2b71499" (Monkeytype's translucent secondary line). */
function alpha(hex: string, a: string): string {
  const h = hex.trim();
  if (/^#[0-9a-f]{6}$/i.test(h)) return h + a;
  if (/^#[0-9a-f]{3}$/i.test(h)) return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}${a}`;
  return h;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

function tooltipStyle(c: ThemeColors) {
  return {
    backgroundColor: c.subAlt,
    titleColor: c.sub,
    bodyColor: c.text,
    borderColor: c.sub,
    borderWidth: 0,
    padding: 10,
    cornerRadius: 6,
    displayColors: true,
    boxWidth: 8,
    boxHeight: 8,
    boxPadding: 4,
    usePointStyle: true,
    titleFont: { family: c.font, size: 11, weight: 'normal' as const },
    bodyFont: { family: c.font, size: 12 },
  };
}

type SeriesKey = 'single' | 'ao5' | 'ao12';

interface TrendProps {
  times: number[];
  ao5: (number | null)[];
  ao12: (number | null)[];
  precision: Precision;
  onOpenSolve: (index: number) => void;
}

/** Times over the session (points) with rolling ao5 / ao12 lines — styled like Monkeytype's history chart. */
export const TrendChart = memo(function TrendChart({ times, ao5, ao12, precision, onOpenSolve }: TrendProps) {
  const c = useThemeColors();
  const [hidden, setHidden] = useState<Set<SeriesKey>>(new Set());

  const config = useMemo((): ChartConfiguration<'line'> => {
    const idx = strideIndices(times.length, MAX_POINTS);
    const ok = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
    const pt = (arr: (number | null)[]) => idx.map((i) => ({ x: i + 1, y: ok(arr[i]) ? arr[i] : null }));
    // downsampled average lines: mean of each bucket, so huge sessions still show a smooth trend
    const line = (arr: (number | null)[]) => {
      if (idx.length === times.length) return pt(arr);
      return idx.map((i, k) => {
        const from = k === 0 ? i : idx[k - 1] + 1;
        let sum = 0;
        let n = 0;
        for (let j = from; j <= i; j++) {
          const v = arr[j];
          if (ok(v)) {
            sum += v;
            n++;
          }
        }
        return { x: i + 1, y: n ? sum / n : null };
      });
    };
    const finite = times.filter(Number.isFinite).sort((a, b) => a - b);
    const top = finite.length ? percentile(finite, finite.length > 30 ? 0.985 : 1) : 1000;
    const bottom = finite.length ? finite[0] : 0;
    const pad = Math.max(200, (top - bottom) * 0.08);
    // round the visible range to a "nice" step so the axis ends on clean labels
    const span = top - bottom + 2 * pad;
    const step = [500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000].find((x) => span / x <= 6) ?? 600_000;
    const yMin = Math.max(0, Math.floor((bottom - pad) / step) * step);
    const yMax = Math.ceil((top + pad) / step) * step;
    const series: Record<SeriesKey, string> = { single: 'single', ao5: 'ao5', ao12: 'ao12' };
    const xPad = Math.max(0.5, times.length * 0.012);
    return {
      type: 'line',
      data: {
        datasets: [
          {
            label: series.ao5,
            data: line(ao5) as never,
            borderColor: alpha(c.main, '99'),
            backgroundColor: alpha(c.main, '99'),
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.25,
            spanGaps: true,
            hidden: hidden.has('ao5'),
            order: 2,
          },
          {
            label: series.ao12,
            data: line(ao12) as never,
            borderColor: c.main,
            backgroundColor: c.main,
            borderWidth: 3,
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.25,
            spanGaps: true,
            hidden: hidden.has('ao12'),
            order: 1,
          },
          {
            label: series.single,
            data: pt(times) as never,
            showLine: false,
            borderColor: c.sub,
            backgroundColor: c.sub,
            pointRadius: times.length > 600 ? 1.5 : times.length < 50 ? 3 : 2,
            pointHoverRadius: 4,
            pointBorderWidth: 0,
            hidden: hidden.has('single'),
            order: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        onHover: (e, els) => {
          const t = e.native?.target as HTMLElement | undefined;
          if (t) t.style.cursor = els.length ? 'pointer' : 'default';
        },
        onClick: (_e, els) => {
          const el = els[0];
          if (!el) return;
          const p = el.element as unknown as { $context?: { raw?: { x: number } } };
          const x = p.$context?.raw?.x;
          if (typeof x === 'number') onOpenSolve(x - 1);
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle(c),
            callbacks: {
              title: (items) => `solve #${(items[0]?.raw as { x: number })?.x ?? ''}`,
              label: (item) => {
                const y = (item.raw as { y: number | null }).y;
                return ` ${item.dataset.label}  ${y === null ? 'DNF' : item.dataset.label === 'single' ? formatTime(y, precision) : fmtAvg(y, precision)}`;
              },
            },
          },
        },
        scales: themedScales(c, {
          x: {
            type: 'linear',
            min: 1 - xPad,
            max: Math.max(2, times.length) + xPad,
            ticks: { precision: 0, maxTicksLimit: 8, callback: (v: number | string) => (Number.isInteger(Number(v)) && Number(v) >= 1 ? Number(v).toLocaleString('en-US') : '') },
            grid: { display: false },
          },
          y: {
            min: yMin,
            max: yMax,
            ticks: { stepSize: step, callback: (v: number | string) => shortTime(Number(v)), maxTicksLimit: 14 },
          },
        }),
      },
    };
  }, [times, ao5, ao12, c, hidden, precision, onOpenSolve]);

  const toggle = (k: SeriesKey) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <section className="tp-panel tp-chart" aria-label="trend chart">
      <div className="tp-panel-title">
        <ChartLine size={14} /> trend
        <div className="tp-legend">
          {(['single', 'ao5', 'ao12'] as const).map((k) => (
            <button key={k} className={`tp-legend-item ${k}${hidden.has(k) ? ' off' : ''}`} onClick={() => toggle(k)} aria-pressed={!hidden.has(k)} {...noFocus}>
              <i />
              {k}
            </button>
          ))}
        </div>
      </div>
      <ChartCanvas config={config} height={220} />
    </section>
  );
});

interface HistProps {
  times: number[];
  /** effective time of the latest solve (its bucket is highlighted) */
  latest: number | null;
}

/** Distribution of times (DNFs excluded) with "nice" bucket widths. */
export const HistogramChart = memo(function HistogramChart({ times, latest }: HistProps) {
  const c = useThemeColors();
  const buckets = useMemo(() => histogram(times), [times]);
  const config = useMemo((): ChartConfiguration<'bar'> => {
    const step = buckets.length ? buckets[0].to - buckets[0].from : 1000;
    const latestIdx = latest !== null && Number.isFinite(latest) ? buckets.findIndex((b) => latest >= b.from && latest < b.to) : -1;
    return {
      type: 'bar',
      data: {
        labels: buckets.map((b) => shortTime(b.from)),
        datasets: [
          {
            label: 'solves',
            data: buckets.map((b) => b.count),
            backgroundColor: buckets.map((_, i) => (i === latestIdx ? c.text : c.main)),
            hoverBackgroundColor: c.text,
            borderRadius: { topLeft: 4, topRight: 4 },
            borderSkipped: 'start',
            categoryPercentage: 0.88,
            barPercentage: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle(c),
            displayColors: false,
            callbacks: {
              title: (items) => {
                const b = buckets[items[0]?.dataIndex ?? 0];
                return b ? `${shortTime(b.from)} – ${shortTime(b.from + step)}` : '';
              },
              label: (item) => ` ${formatNumber(Number(item.raw))} solve${item.raw === 1 ? '' : 's'}`,
            },
          },
        },
        scales: themedScales(c, {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 8 } },
          y: { beginAtZero: true, ticks: { precision: 0, maxTicksLimit: 5 } },
        }),
      },
    };
  }, [buckets, c, latest]);

  const enough = buckets.reduce((a, b) => a + b.count, 0) >= 5;
  return (
    <section className="tp-panel tp-chart" aria-label="time distribution">
      <div className="tp-panel-title">
        <ChartColumn size={14} /> distribution
      </div>
      {enough ? (
        <ChartCanvas config={config} height={220} />
      ) : (
        <div className="tp-empty tp-chart-empty">
          a few more solves
          <span>the distribution appears after 5 solves</span>
        </div>
      )}
    </section>
  );
});
