import { useEffect, useRef, useState } from 'react';
import { Chart, registerables, type ChartConfiguration, type ChartType } from 'chart.js';
import { cssVar } from '../lib/themes';

Chart.register(...registerables);
Chart.defaults.animation = false;
Chart.defaults.maintainAspectRatio = false;

export interface ThemeColors {
  bg: string;
  main: string;
  sub: string;
  subAlt: string;
  text: string;
  error: string;
  font: string;
}

function readColors(): ThemeColors {
  return {
    bg: cssVar('--bg-color'),
    main: cssVar('--main-color'),
    sub: cssVar('--sub-color'),
    subAlt: cssVar('--sub-alt-color'),
    text: cssVar('--text-color'),
    error: cssVar('--error-color'),
    font: cssVar('--font') || 'monospace',
  };
}

/** Current theme colours; re-renders when the theme changes. */
export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState(readColors);
  useEffect(() => {
    const update = () => setColors(readColors());
    window.addEventListener('cubetype:theme', update);
    return () => window.removeEventListener('cubetype:theme', update);
  }, []);
  return colors;
}

/** Applies Monkeytype-style axis colours to every scale of a chart config. */
export function themedScales(c: ThemeColors, scales: Record<string, any> = {}): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(scales)) {
    out[k] = {
      ...v,
      ticks: { color: c.sub, font: { family: c.font, size: 11 }, ...(v?.ticks ?? {}) },
      grid: { color: c.subAlt, tickColor: c.subAlt, ...(v?.grid ?? {}) },
      border: { color: c.subAlt, ...(v?.border ?? {}) },
      title: v?.title ? { color: c.sub, font: { family: c.font }, ...v.title } : undefined,
    };
  }
  return out;
}

interface Props<T extends ChartType> {
  config: ChartConfiguration<T>;
  height?: number | string;
  className?: string;
}

/** Thin Chart.js wrapper: (re)creates the chart when `config` changes identity. Memoise configs. */
export function ChartCanvas<T extends ChartType>({ config, height = 240, className }: Props<T>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart<T> | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(canvasRef.current, config);
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [config]);

  return (
    <div className={className} style={{ position: 'relative', height, width: '100%' }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
