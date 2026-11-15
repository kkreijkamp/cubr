import { useMemo } from 'react';
import type { ChartConfiguration, Plugin } from 'chart.js';
import { ChartCanvas, themedScales, useThemeColors } from '../../ChartCanvas';
import type { WcaDistribution } from '../../../lib/types';
import { formatWcaValue, shortAxisValue } from './wcaFormat';

interface Props {
  dist: WcaDistribution & { unit?: string; p99?: number | null; below?: number; above?: number };
  /** your value (ms or moves) - draws the marker */
  value: number | null;
  markerLabel?: string;
  height?: number;
}

function withAlpha(color: string, alpha: number): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color + Math.round(alpha * 255).toString(16).padStart(2, '0');
  return color;
}

/** fractional x position (0...1 of the plot width) of `v` across the bucket list */
function position(buckets: { from: number; to: number }[], v: number): { frac: number; clipped: 'left' | 'right' | null } {
  const n = buckets.length;
  if (v < buckets[0].from) return { frac: 0, clipped: 'left' };
  if (v >= buckets[n - 1].to) return { frac: 1, clipped: 'right' };
  let i = buckets.findIndex((b) => v < b.to);
  if (i < 0) i = n - 1;
  const b = buckets[i];
  const within = b.to > b.from ? Math.min(1, Math.max(0, (v - b.from) / (b.to - b.from))) : 0.5;
  return { frac: (i + within) / n, clipped: null };
}

/**
 * Histogram of all WCA competitors' personal bests with a vertical marker at your time (drawn by a
 * tiny inline Chart.js plugin) and a dashed median line.
 */
export function DistributionChart({ dist, value, markerLabel = 'you', height = 220 }: Props) {
  const c = useThemeColors();
  const event = dist.event;
  const kind = (dist.kind === 'average' ? 'average' : 'single') as 'single' | 'average';

  const config = useMemo<ChartConfiguration<'bar'>>(() => {
    const buckets = dist.buckets;
    const beaten = (b: { from: number; to: number }) => value !== null && b.from >= value;
    const marker: Plugin<'bar'> = {
      id: 'cubrMarker',
      afterDatasetsDraw(chart) {
        const x = chart.scales.x;
        const area = chart.chartArea;
        if (!x || !buckets.length) return;
        const ctx = chart.ctx;
        // labels sit in two rows at the top ("you" first row, "median" second); lines start below them
        const draw = (v: number, color: string, label: string, dashed: boolean, row: 0 | 1) => {
          const { frac, clipped } = position(buckets, v);
          const px = x.left + frac * (x.right - x.left);
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = dashed ? 1.5 : 2.5;
          ctx.setLineDash(dashed ? [4, 4] : []);
          ctx.beginPath();
          ctx.moveTo(px, area.top + 16 * row + 15);
          ctx.lineTo(px, area.bottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = color;
          ctx.font = `12px ${c.font}`;
          const text = clipped === 'right' ? `${label} ->` : clipped === 'left' ? `<- ${label}` : label;
          const w = ctx.measureText(text).width;
          const tx = Math.min(Math.max(px - w / 2, area.left), area.right - w);
          ctx.textBaseline = 'top';
          ctx.fillText(text, tx, area.top + 16 * row);
          ctx.restore();
        };
        if (dist.p50 !== null && dist.p50 !== undefined) draw(dist.p50, c.sub, 'median', true, value === null ? 0 : 1);
        if (value !== null) draw(value, c.main, markerLabel, false, 0);
      },
    };
    return {
      type: 'bar',
      data: {
        labels: buckets.map((b) => shortAxisValue(b.from, event, kind)),
        datasets: [
          {
            data: buckets.map((b) => b.count),
            backgroundColor: buckets.map((b) => (beaten(b) ? withAlpha(c.main, 0.62) : withAlpha(c.sub, 0.75))),
            hoverBackgroundColor: c.text,
            borderRadius: 2,
            barPercentage: 1,
            categoryPercentage: 0.9,
          },
        ],
      },
      options: {
        layout: { padding: { top: 34 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: c.bg,
            titleColor: c.text,
            bodyColor: c.sub,
            borderColor: c.sub,
            borderWidth: 1,
            titleFont: { family: c.font },
            bodyFont: { family: c.font },
            displayColors: false,
            callbacks: {
              title: (items) => {
                const b = buckets[items[0].dataIndex];
                return `${formatWcaValue(b.from, event, kind)} - ${formatWcaValue(b.to, event, kind)}`;
              },
              label: (item) => `${Number(item.raw).toLocaleString('en-US')} competitors`,
            },
          },
        },
        scales: themedScales(c, {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, autoSkipPadding: 12 } },
          y: { beginAtZero: true, ticks: { maxTicksLimit: 4, precision: 0 }, grid: { color: c.subAlt } },
        }),
      },
      plugins: [marker],
    };
  }, [dist, value, markerLabel, c, event, kind]);

  if (!dist.buckets.length) return <div className="empty">no results recorded for this event yet.</div>;
  return <ChartCanvas config={config} height={height} />;
}
