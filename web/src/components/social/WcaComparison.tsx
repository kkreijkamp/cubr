import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ClockIcon } from '@heroicons/react/24/outline';
import { EVENT_IDS } from '@cubr/cubestats';
import { countryName } from './countries';
import { Section, WidgetEmpty, WidgetError } from './Widget';
import { eventLabel, isWcaComparable, isWcaNotLoaded, wcaAverageKind } from './util';
import { api } from '../../lib/api';
import { flagEmoji, formatDate, formatNumber, formatPercent, formatTime } from '../../lib/format';
import type { StatsSummary, WcaDistribution, WcaRank } from '../../lib/types';
import { useAsync, type AsyncState } from '../../lib/useAsync';
import { Loading, Spinner } from '../Spinner';

type WcaKind = 'single' | 'average';

// Rank / distribution lookups are shared between the table and the chart headline, so cache the
// promises (keyed by query) instead of firing duplicate requests. Failures are evicted.
const rankCache = new Map<string, Promise<WcaRank>>();
const distCache = new Map<string, Promise<WcaDistribution>>();
function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) {
    p = load();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}
function getRank(event: string, kind: WcaKind, value: number, country: string | null): Promise<WcaRank> {
  return cached(rankCache, `${event}|${kind}|${value}|${country ?? ''}`, () => api.wca.rank({ event, kind, value, country }));
}
function getDistribution(event: string, kind: WcaKind): Promise<WcaDistribution> {
  return cached(distCache, `${event}|${kind}`, () => api.wca.distribution(event, kind, 50));
}

function useElementWidth(ref: React.RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

interface Row {
  event: string;
  single: number | null;
  average: number | null;
  avgKind: 'ao5' | 'mo3';
}

function rowsFromSummary(summary: StatsSummary): Row[] {
  return summary.events
    .filter((e) => isWcaComparable(e.event))
    .map((e) => {
      const avgKind = wcaAverageKind(e.event);
      const ok = (v: number | undefined | null) => (v !== undefined && v !== null && v > 0 ? v : null);
      return { event: e.event, single: ok(e.pbs.single?.valueMs), average: ok(e.pbs[avgKind]?.valueMs), avgKind };
    })
    .filter((r) => r.single !== null || r.average !== null)
    .sort((a, b) => EVENT_IDS.indexOf(a.event) - EVENT_IDS.indexOf(b.event));
}

// ------------------------------------------------------------------------------- distribution

interface ChartProps {
  dist: WcaDistribution;
  value: number;
  official: number | null;
  precision: 2 | 3;
}

/** The distribution chart's height (its loading box keeps the same). */
const DIST_H = 210;

/** Histogram of every official competitor's PB with your PB (and your official PB) marked. */
function DistributionChart({ dist, value, official, precision }: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref) || 640;
  const [hover, setHover] = useState<number | null>(null);
  const buckets = dist.buckets;
  const H = DIST_H;
  const pad = { l: 4, r: 4, t: official !== null ? 50 : 30, b: 24 };
  const x0 = buckets[0]?.from ?? 0;
  const x1 = buckets[buckets.length - 1]?.to ?? 1;
  const innerW = Math.max(10, width - pad.l - pad.r);
  const sx = (v: number) => pad.l + ((v - x0) / (x1 - x0 || 1)) * innerW;
  const maxC = Math.max(1, ...buckets.map((b) => b.count));
  const base = H - pad.b;
  const sy = (c: number) => pad.t + (1 - c / maxC) * (base - pad.t);

  const bars = buckets.map((b, i) => {
    const xa = sx(b.from) + 1;
    const w = Math.max(1, sx(b.to) - sx(b.from) - 2);
    const y = Math.min(sy(b.count), base - (b.count > 0 ? 1.5 : 0));
    const h = base - y;
    const r = Math.min(3, w / 2, h);
    const d = h <= 0 ? '' : `M${xa},${base} V${y + r} Q${xa},${y} ${xa + r},${y} H${xa + w - r} Q${xa + w},${y} ${xa + w},${y + r} V${base} Z`;
    return { d, beat: (b.from + b.to) / 2 > value, i };
  });

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => x0 + (x1 - x0) * f);
  // markers: lines first, then labels on top (so a line never cuts through the other label)
  const markers = [
    ...(official !== null ? [{ v: official, row: 1, cls: 'official', text: `official ${formatTime(official, precision)}` }] : []),
    { v: value, row: 0, cls: 'you', text: `you ${formatTime(value, precision)}${value > x1 ? ' ->' : value < x0 ? ' <-' : ''}` },
  ].map((m) => {
    const x = Math.min(Math.max(sx(m.v), pad.l + 1), width - pad.r - 1);
    const labelW = m.text.length * 6.7 + 14;
    return { ...m, x, labelW, lx: Math.min(Math.max(x - labelW / 2, 0), width - labelW), ly: 2 + m.row * 20 };
  });

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const v = x0 + ((e.clientX - rect.left - pad.l) / innerW) * (x1 - x0);
    const i = buckets.findIndex((b) => v >= b.from && v < b.to);
    setHover(i >= 0 ? i : null);
  };
  const hb = hover !== null ? buckets[hover] : null;
  const fmt = (v: number) => formatTime(v, 2);

  return (
    <div className="wc-dist" ref={ref}>
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`distribution of ${formatNumber(dist.total)} official results, your result ${formatTime(value, precision)} marked`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <g>
          {bars.map((b) =>
            b.d ? <path key={b.i} d={b.d} className={`bar${b.beat ? ' beat' : ''}${hover === b.i ? ' hover' : ''}`} /> : null,
          )}
        </g>
        <g className="median">
          <line x1={sx(dist.p50)} x2={sx(dist.p50)} y1={pad.t} y2={base} />
        </g>
        <g className="axis">
          <line x1={pad.l} x2={width - pad.r} y1={base + 1} y2={base + 1} />
          {ticks.map((t, i) => (
            <text key={i} x={sx(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}>
              {fmt(t)}
            </text>
          ))}
        </g>
        {markers.map((m) => (
          <g key={`l-${m.cls}`} className={`marker ${m.cls}`}>
            <line x1={m.x} x2={m.x} y1={m.ly + 16} y2={base} />
          </g>
        ))}
        {markers.map((m) => (
          <g key={`t-${m.cls}`} className={`marker ${m.cls}`}>
            <rect x={m.lx} y={m.ly} width={m.labelW} height={16} rx={4} />
            <text x={m.lx + m.labelW / 2} y={m.ly + 11.5} textAnchor="middle">
              {m.text}
            </text>
          </g>
        ))}
      </svg>
      {hb && (
        <div
          className="hm-tip"
          role="tooltip"
          style={{ left: Math.min(Math.max(sx((hb.from + hb.to) / 2), 90), width - 90), top: sy(hb.count) }}
        >
          {fmt(hb.from)} - {fmt(hb.to)}: {formatNumber(hb.count)} cubers
        </div>
      )}
    </div>
  );
}

/** Where one PB places among official results: world (and country) rank over the distribution. */
function Placement({
  row,
  kind,
  official,
  country,
  precision,
  intro,
  source,
}: {
  row: Row;
  kind: WcaKind;
  official: number | null;
  country: string | null;
  precision: 2 | 3;
  intro: ReactNode;
  source: ReactNode;
}) {
  const value = (kind === 'single' ? row.single : row.average)!;
  const dist = useAsync(() => getDistribution(row.event, kind), [row.event, kind]);
  const rank = useAsync(() => getRank(row.event, kind, value, country), [row.event, kind, value, country]);

  return (
    <div className="wc-body">
      <div className="wc-side">
        {intro}
        {rank.data ? (
          <div className="wc-headline">
            <span className="big">#{formatNumber(rank.data.world.rank)}</span>
            <span className="wc-headline-meta">
              <span>
                in the world - faster than <span className="text">{formatPercent(rank.data.world.percentile)}</span> of {formatNumber(rank.data.world.total)}
              </span>
              {rank.data.country && (
                <span>
                  #{formatNumber(rank.data.country.rank)} in {flagEmoji(rank.data.country.countryIso2 ?? country)}{' '}
                  {(countryName(rank.data.country.countryIso2 ?? country) || rank.data.country.countryId).toLowerCase()}
                </span>
              )}
            </span>
          </div>
        ) : rank.error ? (
          <WidgetError error={rank.error} what="the wca ranks" onRetry={rank.reload} compact />
        ) : (
          <div className="wc-headline">
            <span className="big dim">#-</span>
            {/* the lines beside the rank come with it (the country's when the cuber has one): invisible
                stand-ins keep their room */}
            <span className="wc-headline-meta reserve" aria-hidden="true">
              <span>in the world - faster than 00.0% of 000,000</span>
              {country && (
                <span>
                  #0,000 in {flagEmoji(country)} {(countryName(country) || country).toLowerCase()}
                </span>
              )}
            </span>
          </div>
        )}
        {source}
      </div>
      <div className="wc-chart">
        {dist.error && !dist.data ? (
          <WidgetError error={dist.error} what="the wca distribution" onRetry={dist.reload} compact />
        ) : !dist.data ? (
          <>
            <div style={{ height: DIST_H }} className="pv-chart-empty">
              <Loading />
            </div>
            <div className="wc-legend reserve" aria-hidden="true">
              <span>
                <i className="beat" /> cubers you beat
              </span>
              <span>
                <i className="faster" /> faster than you
              </span>
              <span>median 00.00</span>
            </div>
          </>
        ) : dist.data.buckets.length === 0 ? (
          <WidgetEmpty compact>no official results for this event yet</WidgetEmpty>
        ) : (
          <>
            <DistributionChart dist={dist.data} value={value} official={official} precision={precision} />
            <div className="wc-legend" aria-hidden="true">
              <span>
                <i className="beat" /> cubers you beat
              </span>
              <span>
                <i className="faster" /> faster than you
              </span>
              <span>median {formatTime(dist.data.p50, precision)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------- widget

interface Props {
  summary: AsyncState<StatsSummary>;
  event: string;
  wcaId: string | null;
  country: string | null;
  own: boolean;
  onEdit?: () => void;
  precision: 2 | 3;
}

/** "Where would this PB rank at a WCA competition?" for the profile's event, single or average. */
export function WcaComparison({ summary, event, wcaId, country, own, onEdit, precision }: Props) {
  const meta = useAsync((signal) => api.wca.meta(signal), []);
  const person = useAsync((signal) => (wcaId ? api.wca.person(wcaId, signal) : Promise.resolve(null)), [wcaId]);
  const row = useMemo(() => (summary.data ? (rowsFromSummary(summary.data).find((r) => r.event === event) ?? null) : null), [summary.data, event]);
  const [asked, setAsked] = useState<WcaKind>('single');
  if (!isWcaComparable(event) || !row) return null;

  const kind: WcaKind = (asked === 'single' ? row.single : row.average) !== null ? asked : asked === 'single' ? 'average' : 'single';
  const officialPb = person.data?.pbs.find((p) => p.event === event)?.[kind] ?? null;
  const kindLabel = kind === 'single' ? 'single' : row.avgKind;

  let body: JSX.Element;
  if (meta.error && isWcaNotLoaded(meta.error))
    body = (
      <div className="pv-widget-msg compact">
        <ClockIcon width={16} height={16} />
        <span>wca data is being imported - try again in a minute.</span>
        <button className="btn-text" onClick={meta.reload}>
          retry
        </button>
      </div>
    );
  else if (meta.error) body = <WidgetError error={meta.error} what="the wca service" onRetry={meta.reload} compact />;
  // while the export's date loads, everything else is laid out already: only the date fills in
  else
    body = (
      <Placement
        row={row}
        kind={kind}
        official={wcaId ? (officialPb?.value ?? null) : null}
        country={country}
        precision={precision}
        intro={
          <p className="wc-sub">
            where {own ? 'your' : 'this'} {kindLabel} of <span className="text">{formatTime((kind === 'single' ? row.single : row.average)!, precision)}</span>{' '}
            would place among official {eventLabel(event)} {kind === 'single' ? 'singles' : 'averages'}
            {officialPb && (
              <>
                {' '}
                - official pb <span className="text">{formatTime(officialPb.value, precision)}</span> (wr #{formatNumber(officialPb.worldRank)})
              </>
            )}
          </p>
        }
        source={
          <p className="wc-sub wc-source">
            based on results owned and maintained by the World Cube Association,{' '}
            <a href="https://www.worldcubeassociation.org/results" target="_blank" rel="noreferrer noopener">
              worldcubeassociation.org/results
            </a>{' '}
            {/* "as of <date>", as the WCA asks (the /wca page and About say it the same way) */}
            {meta.data ? (
              `as of ${formatDate(meta.data.exportDate)}`
            ) : (
              <span className="reserve" aria-hidden="true">
                as of 00 Sep 2026
              </span>
            )}
          </p>
        }
      />
    );

  return (
    <Section
      label="wca comparison"
      className="wc"
      title="vs the wca"
      extra={
        wcaId ? (
          person.data ? (
            <Link to={`/wca?person=${encodeURIComponent(wcaId)}`}>
              {person.data.person.name} {flagEmoji(person.data.person.countryIso2)}
            </Link>
          ) : person.loading ? (
            <Spinner size={12} />
          ) : null
        ) : own && onEdit ? (
          <button className="btn-text pf-link" onClick={onEdit}>
            link your wca id
          </button>
        ) : null
      }
      tools={
        <div className="pv-seg" role="group" aria-label="single or average">
          {(['single', 'average'] as const).map((k) => (
            <button
              key={k}
              className={`btn-text${kind === k ? ' active' : ''}`}
              aria-pressed={kind === k}
              disabled={(k === 'single' ? row.single : row.average) === null}
              onClick={() => setAsked(k)}
            >
              {k === 'single' ? 'single' : row.avgKind}
            </button>
          ))}
        </div>
      }
    >
      {body}
    </Section>
  );
}
