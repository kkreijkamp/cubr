import { useMemo, useState } from 'react';
import type { ChartConfiguration } from 'chart.js';
import { History } from 'lucide-react';
import { rollingAverage } from '@cubetype/cubestats';
import { EventSelect } from './Charts';
import { WidgetError } from './Widget';
import { eventLabel } from './util';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber, formatTime } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { ChartCanvas, themedScales, useThemeColors, type ThemeColors } from '../ChartCanvas';
import { Loading, Spinner } from '../Spinner';

/**
 * Monkeytype-style history chart: every solve as a point, with toggleable overlays for the PB
 * progression and rolling averages (ao5 ... ao1000). Averages are computed over the user's whole
 * chronological solve history with the shared WCA rules (@cubetype/cubestats), so a window that
 * starts mid-history still shows correct averages from its first point.
 */

const HEIGHT = 300;
const MAX_POINTS = 6000; // scatter points drawn (PBs and DNFs are always kept)
const MAX_LINE_POINTS = 1500; // points per overlay line (averages are smooth, so this is lossless to the eye)
const GAP_MS = 3 * 86_400_000; // "by date": break average lines across pauses longer than 3 days

type Ink = 'main' | 'text' | 'sub';
type LineKey = 'pb' | 'ao5' | 'ao12' | 'ao50' | 'ao100' | 'ao1000';
type ToggleKey = 'solves' | 'dnf' | LineKey;

const LINES: { key: LineKey; n: number; ink: Ink; dash: number[]; width: number }[] = [
  { key: 'pb', n: 1, ink: 'main', dash: [], width: 2.5 },
  { key: 'ao5', n: 5, ink: 'sub', dash: [], width: 1.25 },
  { key: 'ao12', n: 12, ink: 'text', dash: [], width: 1.75 },
  { key: 'ao50', n: 50, ink: 'sub', dash: [6, 4], width: 2 },
  { key: 'ao100', n: 100, ink: 'text', dash: [6, 4], width: 2.25 },
  { key: 'ao1000', n: 1000, ink: 'text', dash: [2, 3], width: 2.25 },
];
const DEFAULT_SHOWN: ToggleKey[] = ['solves', 'dnf', 'pb', 'ao12', 'ao100'];
const INK_VAR: Record<Ink, string> = { main: 'var(--main-color)', text: 'var(--text-color)', sub: 'var(--sub-color)' };

type Range = 'all' | '1000' | '100';
type XMode = 'solves' | 'date';

/** '#rrggbb' + alpha -> '#rrggbbaa' (canvas can't use color-mix). */
function withAlpha(color: string, alpha: number): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color + Math.round(alpha * 255).toString(16).padStart(2, '0');
  return color;
}

/** Round axis bounds to a readable step so the edge labels are e.g. 9.00 / 22.00, not 8.87 / 21.33. */
function niceBounds(lo: number, hi: number): { min: number; max: number; step: number } {
  const range = Math.max(1, hi - lo);
  const step = [250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 300_000].find((s) => range / s <= 8) ?? 600_000;
  return { min: Math.max(0, Math.floor((lo * 0.97) / step) * step), max: Math.ceil((hi * 1.01) / step) * step, step };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
}

function tooltipStyle(c: ThemeColors) {
  return {
    backgroundColor: c.sub,
    titleColor: c.bg,
    bodyColor: c.bg,
    footerColor: c.bg,
    titleFont: { family: c.font, size: 11, weight: 'normal' as const },
    bodyFont: { family: c.font, size: 12 },
    footerFont: { family: c.font, size: 11, weight: 'normal' as const },
    padding: 8,
    cornerRadius: 4,
    displayColors: false,
    caretSize: 5,
  };
}

function Swatch({ k }: { k: ToggleKey }) {
  if (k === 'solves')
    return (
      <svg viewBox="0 0 22 8" aria-hidden="true">
        <circle cx="5" cy="4" r="2" fill="var(--main-color)" opacity="0.55" />
        <circle cx="11" cy="3" r="2" fill="var(--main-color)" opacity="0.55" />
        <circle cx="17" cy="5" r="2" fill="var(--main-color)" opacity="0.55" />
      </svg>
    );
  if (k === 'dnf')
    return (
      <svg viewBox="0 0 22 8" aria-hidden="true">
        <path d="M8 1 L14 7 M14 1 L8 7" stroke="var(--error-color)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  const s = LINES.find((l) => l.key === k)!;
  return (
    <svg viewBox="0 0 22 8" aria-hidden="true">
      {k === 'pb' ? (
        <path d="M1 2 H9 V6 H21" fill="none" stroke={INK_VAR[s.ink]} strokeWidth={s.width} />
      ) : (
        <line x1="1" y1="4" x2="21" y2="4" stroke={INK_VAR[s.ink]} strokeWidth={s.width} strokeDasharray={s.dash.join(' ') || undefined} strokeLinecap="round" />
      )}
    </svg>
  );
}

interface Prepared {
  n: number;
  t: number[]; // unix ms per solve
  raw: number[]; // raw time (no penalty) per solve
  eff: number[]; // effective time, Infinity = DNF
  isPb: boolean[]; // solve set a new single PB
  pb: number[]; // running best single (Infinity before the first finish)
  avgs: Record<string, (number | null)[]>; // ao5 ... ao1000 (null = not enough solves, Infinity = DNF)
}

function prepare(rows: [number, number, number | null, number?][]): Prepared {
  const n = rows.length;
  const t = rows.map((r) => r[0] * 1000);
  const raw = rows.map((r) => r[1]);
  const eff = rows.map((r) => (r[2] === null ? Number.POSITIVE_INFINITY : r[2]));
  const isPb: boolean[] = new Array(n).fill(false);
  const pb: number[] = new Array(n);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    if (eff[i] < best) {
      best = eff[i];
      isPb[i] = true;
    }
    pb[i] = best;
  }
  const avgs: Record<string, (number | null)[]> = {};
  for (const l of LINES) if (l.key !== 'pb' && n >= l.n) avgs[l.key] = rollingAverage(eff, l.n);
  return { n, t, raw, eff, isPb, pb, avgs };
}

export function SolveHistoryChart({ userId, events, defaultEvent, precision }: { userId: string; events: string[]; defaultEvent: string; precision: 2 | 3 }) {
  const [event, setEvent] = useState(defaultEvent);
  const [range, setRange] = useState<Range>('all');
  const [xMode, setXMode] = useState<XMode>('solves');
  const [shown, setShown] = useState<Set<ToggleKey>>(() => new Set(DEFAULT_SHOWN));
  /** index into series.data.sessions, or -1 for all sessions */
  const [session, setSession] = useState(-1);
  const colors = useThemeColors();
  const series = useAsync((signal) => api.stats.solves(userId, event, signal), [userId, event]);
  const sessions = series.data?.sessions ?? [];

  // Filtering by session happens client-side (instant switching); averages and the pb line are
  // then computed within that session only - the way cubers read session stats.
  const prep = useMemo(() => {
    if (!series.data) return null;
    const rows = session < 0 ? series.data.solves : series.data.solves.filter((r) => r[3] === session);
    return prepare(rows);
  }, [series.data, session]);

  // visible window (averages were computed over the full history above)
  const view = useMemo(() => {
    if (!prep || prep.n === 0) return null;
    const start = range === 'all' ? 0 : Math.max(0, prep.n - Number(range));
    const finite: number[] = [];
    let dnfs = 0;
    for (let i = start; i < prep.n; i++) {
      if (Number.isFinite(prep.eff[i])) finite.push(prep.eff[i]);
      else dnfs++;
    }
    const sorted = [...finite].sort((a, b) => a - b);
    // clamp the y axis so one forgotten-timer solve doesn't flatten everything
    const hi = sorted.length ? Math.min(sorted[sorted.length - 1], percentile(sorted, 0.995) * 1.12) : 1;
    const lo = sorted.length ? sorted[0] : 0;
    const hidden = sorted.filter((v) => v > hi).length;
    // least-squares trend over the window (y = effective ms, x = solve number)
    // trend is reported per 100 solves for short windows, per 1,000 for long ones (never extrapolate far)
    const trendUnit = finite.length >= 1000 ? 1000 : 100;
    let trend: number | null = null;
    if (finite.length >= 50) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
      for (let i = start; i < prep.n; i++) {
        if (!Number.isFinite(prep.eff[i])) continue;
        sx += i; sy += prep.eff[i]; sxx += i * i; sxy += i * prep.eff[i]; m++;
      }
      const denom = m * sxx - sx * sx;
      if (denom !== 0) trend = ((m * sxy - sx * sy) / denom) * trendUnit;
    }
    const mean = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
    return { start, count: prep.n - start, dnfs, lo, hi, hidden, trend, trendUnit, best: sorted[0] ?? null, mean };
  }, [prep, range]);

  const config = useMemo((): ChartConfiguration<'line'> | null => {
    if (!prep || !view) return null;
    const c = colors;
    const { start } = view;
    const xOf = (i: number) => (xMode === 'solves' ? i + 1 : prep.t[i]);
    const datasets: any[] = [];

    // every solve (thinned only for very long histories; PBs always kept)
    if (shown.has('solves')) {
      const step = Math.max(1, Math.ceil(view.count / MAX_POINTS));
      const pts: { x: number; y: number; i: number }[] = [];
      for (let i = start; i < prep.n; i++) {
        if (!Number.isFinite(prep.eff[i])) continue;
        if ((i - start) % step !== 0 && !prep.isPb[i]) continue;
        pts.push({ x: xOf(i), y: prep.eff[i], i });
      }
      const dense = pts.length > 2500;
      datasets.push({
        type: 'scatter',
        label: 'solves',
        data: pts,
        parsing: false,
        order: 10,
        pointRadius: (ctx: any) => (prep.isPb[ctx.raw?.i] ? 3.5 : dense ? 1.6 : 2.4),
        pointHoverRadius: 5,
        pointBorderWidth: 0,
        pointBackgroundColor: (ctx: any) => (prep.isPb[ctx.raw?.i] ? c.main : withAlpha(c.main, dense ? 0.35 : 0.5)),
      });
    }
    if (shown.has('dnf')) {
      const pts: { x: number; y: number; i: number }[] = [];
      for (let i = start; i < prep.n; i++) if (!Number.isFinite(prep.eff[i])) pts.push({ x: xOf(i), y: Math.min(prep.raw[i], view.hi), i });
      datasets.push({
        type: 'scatter',
        label: 'dnf',
        data: pts,
        parsing: false,
        order: 9,
        pointStyle: 'crossRot',
        pointRadius: 3.5,
        pointHoverRadius: 5,
        pointBorderWidth: 1.5,
        borderColor: c.error,
        pointBorderColor: c.error,
        backgroundColor: c.error,
      });
    }
    // overlay lines
    for (const l of LINES) {
      if (!shown.has(l.key)) continue;
      const values = l.key === 'pb' ? prep.pb : prep.avgs[l.key];
      if (!values) continue;
      const step = Math.max(1, Math.ceil(view.count / MAX_LINE_POINTS));
      const pts: { x: number; y: number | null; i: number }[] = [];
      let prevT = -1;
      for (let i = start; i < prep.n; i++) {
        const v = values[i];
        const keep = l.key === 'pb' ? i === start || prep.isPb[i] || i === prep.n - 1 : (i - start) % step === 0 || i === prep.n - 1;
        if (!keep) continue;
        // by date, break average lines across long breaks (> 3 days) instead of
        // drawing long connectors across days without solves; the pb line stays continuous
        if (xMode === 'date' && l.key !== 'pb' && prevT >= 0 && prep.t[i] - prevT > GAP_MS) pts.push({ x: (prevT + prep.t[i]) / 2, y: null, i });
        prevT = prep.t[i];
        pts.push({ x: xOf(i), y: v === null || v === undefined || !Number.isFinite(v) ? null : v, i });
      }
      const ink = c[l.ink];
      datasets.push({
        type: 'line',
        label: l.key,
        data: pts,
        parsing: false,
        order: LINES.indexOf(l),
        borderColor: ink,
        backgroundColor: ink,
        borderWidth: l.width,
        borderDash: l.dash,
        stepped: l.key === 'pb' ? 'before' : false, // hold the old pb across, then drop at the solve that beat it
        tension: l.key === 'pb' || xMode === 'date' ? 0 : 0.25,
        pointRadius: 0,
        pointHoverRadius: 0,
        pointHitRadius: 0,
        spanGaps: false,
      });
    }

    const span = xMode === 'date' ? prep.t[prep.n - 1] - prep.t[start] : view.count;
    const valueAt = (key: LineKey, i: number): number | null => {
      const arr = key === 'pb' ? prep.pb : prep.avgs[key];
      const v = arr?.[i];
      return v === undefined ? null : v;
    };

    return {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle(c),
            // one tooltip per solve: show the hovered solve, then every visible overlay at that solve
            filter: (item, idx, all) => {
              const first = all.findIndex((a) => a.dataset.label === 'solves' || a.dataset.label === 'dnf');
              return first === -1 ? idx === 0 : idx === first;
            },
            callbacks: {
              title: (items) => {
                const i = (items[0]?.raw as { i?: number } | undefined)?.i;
                return i === undefined ? '' : `solve #${formatNumber(i + 1)} - ${formatDateTime(new Date(prep.t[i]).toISOString())}`;
              },
              label: (item) => {
                const i = (item.raw as { i: number }).i;
                if (!Number.isFinite(prep.eff[i])) return `DNF (${formatTime(prep.raw[i], precision)})`;
                const plus2 = prep.eff[i] !== prep.raw[i];
                return `${formatTime(prep.eff[i], precision)}${plus2 ? '+' : ''}${prep.isPb[i] ? '  - new pb' : ''}`;
              },
              footer: (items) => {
                const i = (items[0]?.raw as { i?: number } | undefined)?.i;
                if (i === undefined) return '';
                return LINES.filter((l) => shown.has(l.key))
                  .map((l) => {
                    const v = valueAt(l.key, i);
                    if (v === null) return null;
                    return `${l.key.padEnd(6)} ${Number.isFinite(v) ? formatTime(v, precision) : 'DNF'}`;
                  })
                  .filter(Boolean) as string[];
              },
            },
          },
        },
        scales: (() => {
          const s = themedScales(c, {
            x: {
              type: 'linear',
              min: xMode === 'solves' ? start + 1 : prep.t[start],
              max: xMode === 'solves' ? prep.n : prep.t[prep.n - 1],
              ticks: {
                maxTicksLimit: 8,
                maxRotation: 0,
                callback: (v: number | string) => {
                  if (xMode === 'solves') return formatNumber(Math.round(Number(v)));
                  const d = new Date(Number(v));
                  const mon = d.toLocaleString('en-US', { month: 'short' }).toLowerCase();
                  return span < 120 * 86_400_000 ? `${String(d.getDate()).padStart(2, '0')} ${mon}` : `${mon} '${String(d.getFullYear()).slice(2)}`;
                },
              },
              title: { display: true, text: xMode === 'solves' ? 'solve' : 'date' },
            },
            y: (() => {
              const b = niceBounds(view.lo, view.hi);
              return { min: b.min, max: b.max, ticks: { stepSize: b.step, maxTicksLimit: 12, callback: (v: number | string) => formatTime(Number(v), 2) } };
            })(),
          });
          for (const axis of Object.values(s)) {
            axis.grid = { ...axis.grid, color: c.bg, tickColor: 'transparent' };
            axis.border = { display: false };
          }
          return s;
        })(),
      },
    };
  }, [prep, view, shown, colors, precision, xMode]);

  const toggle = (k: ToggleKey) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const available: ToggleKey[] = prep
    ? ['solves', ...(prep.eff.some((v) => !Number.isFinite(v)) ? (['dnf'] as const) : []), ...LINES.filter((l) => l.key === 'pb' || prep.avgs[l.key]).map((l) => l.key)]
    : [];

  const trend = view?.trend;
  const insight =
    view && trend !== null && trend !== undefined && Math.abs(trend) >= 10
      ? `${trend < 0 ? 'improving' : 'slowing'} ${formatTime(Math.abs(trend), 2)} s per ${formatNumber(view.trendUnit)} solves`
      : null;

  return (
    <section className="pv-card pv-history" aria-label="solve history">
      <div className="pv-card-head">
        <h2 className="pv-title">
          <History /> solve history
          {series.data && (
            <span className="sub">
              - {session >= 0 && prep ? `${formatNumber(prep.n)} of ` : ''}
              {formatNumber(series.data.total)} solves
            </span>
          )}
          {series.loading && series.data && <Spinner size={14} />}
        </h2>
        <div className="pv-head-tools">
          <div className="pv-seg" role="group" aria-label="range">
            {(['all', '1000', '100'] as Range[]).map((r) => (
              <button key={r} className={`btn-text${range === r ? ' active' : ''}`} onClick={() => setRange(r)} disabled={!!prep && r !== 'all' && prep.n <= Number(r)}>
                {r === 'all' ? 'all' : `last ${r}`}
              </button>
            ))}
          </div>
          <div className="pv-seg" role="group" aria-label="x axis">
            {(['solves', 'date'] as XMode[]).map((m) => (
              <button key={m} className={`btn-text${xMode === m ? ' active' : ''}`} onClick={() => setXMode(m)}>
                {m === 'solves' ? 'by solve' : 'by date'}
              </button>
            ))}
          </div>
          {sessions.length > 1 && (
            <select
              className="pv-select"
              value={session}
              onChange={(e) => {
                setSession(Number(e.target.value));
                setRange('all');
              }}
              aria-label="filter by session"
            >
              <option value={-1}>all sessions</option>
              {sessions.map((s, i) => (
                <option key={s.id} value={i}>
                  {s.name ?? `session ${i + 1}`} - {formatNumber(s.solves)}
                </option>
              ))}
            </select>
          )}
          <EventSelect
            events={events}
            value={event}
            onChange={(e) => {
              setEvent(e);
              setSession(-1);
              setRange('all');
            }}
            label="solve history event"
          />
        </div>
      </div>
      {series.error && !series.data ? (
        <WidgetError error={series.error} what="the solve history" onRetry={series.reload} />
      ) : !prep ? (
        <div style={{ height: HEIGHT }} className="pv-chart-empty">
          <Loading />
        </div>
      ) : prep.n === 0 ? (
        <div style={{ height: HEIGHT }} className="pv-chart-empty">
          {session >= 0 ? 'no solves in this session' : `no ${eventLabel(event)} solves yet`}
        </div>
      ) : (
        <>
          {config && shown.size > 0 ? (
            <ChartCanvas config={config} height={HEIGHT} />
          ) : (
            <div style={{ height: HEIGHT }} className="pv-chart-empty">
              pick something to show below
            </div>
          )}
          <div className="pv-legend" role="group" aria-label="series">
            {available.map((k) => (
              <button key={k} className="btn-text" aria-pressed={shown.has(k)} onClick={() => toggle(k)}>
                <Swatch k={k} /> {k}
              </button>
            ))}
          </div>
          <div className="pv-insight">
            {view && view.best !== null && (
              <>
                best {formatTime(view.best, precision)} - mean {view.mean !== null ? formatTime(view.mean, precision) : '-'}
                {view.dnfs > 0 && ` - ${view.dnfs} dnf`}
                {insight && ` - ${insight}`}
                {view.hidden > 0 && ` - ${view.hidden} slow outlier${view.hidden === 1 ? '' : 's'} above ${formatTime(view.hi, 2)} not shown`}
              </>
            )}
            {series.data?.truncated && ` - showing your latest ${formatNumber(series.data.solves.length)} solves`}
          </div>
        </>
      )}
    </section>
  );
}
