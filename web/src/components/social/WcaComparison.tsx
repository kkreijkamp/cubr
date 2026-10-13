import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Hourglass, Medal } from 'lucide-react';
import { EVENT_IDS } from '@cubetype/cubestats';
import { countryName } from './countries';
import { WidgetEmpty, WidgetError } from './Widget';
import { eventLabel, friendlyError, isWcaComparable, isWcaNotLoaded, wcaAverageKind } from './util';
import { api } from '../../lib/api';
import { flagEmoji, formatDate, formatNumber, formatPercent, formatTime } from '../../lib/format';
import type { StatsSummary, WcaDistribution, WcaPerson, WcaRank } from '../../lib/types';
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

/** Percent of competitors at least as fast, never shown as "top 0.00%". */
function topPercent(r: WcaRank['world']): string {
  return formatPercent(Math.max(0.01, 100 - r.percentile));
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

function RankLine({ event, kind, value, country }: { event: string; kind: WcaKind; value: number; country: string | null }) {
  const r = useAsync(() => getRank(event, kind, value, country), [event, kind, value, country]);
  if (r.error) return <span className="r" title={friendlyError(r.error, 'the wca service')}>rank unavailable</span>;
  if (!r.data) return <span className="r">…</span>;
  const w = r.data.world;
  return (
    <span className="r">
      <span>#{formatNumber(w.rank)}</span>
      <span className="sep"> · </span>
      <span>top {topPercent(w)}</span>
    </span>
  );
}

function YourCell({ row, kind, country, precision }: { row: Row; kind: WcaKind; country: string | null; precision: 2 | 3 }) {
  const value = kind === 'single' ? row.single : row.average;
  if (value === null) return <span className="sub">-</span>;
  return (
    <span className="wc-cell">
      <span className="v">
        {formatTime(value, precision)}
        {kind === 'average' && <span className="kind">{row.avgKind}</span>}
      </span>
      <RankLine event={row.event} kind={kind} value={value} country={country} />
    </span>
  );
}

function OfficialCell({ person, event, kind, precision }: { person: WcaPerson | null | undefined; event: string; kind: WcaKind; precision: 2 | 3 }) {
  const pb = person?.pbs.find((p) => p.event === event)?.[kind] ?? null;
  if (!pb) return <span className="sub">-</span>;
  return (
    <span className="wc-cell">
      <span className="v text">{formatTime(pb.value, precision)}</span>
      <span className="r">wr #{formatNumber(pb.worldRank)}</span>
    </span>
  );
}

// ------------------------------------------------------------------------------- distribution

interface ChartProps {
  dist: WcaDistribution;
  value: number;
  official: number | null;
  precision: 2 | 3;
}

/** Histogram of every official competitor's PB with your PB (and your official PB) marked. */
function DistributionChart({ dist, value, official, precision }: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref) || 640;
  const [hover, setHover] = useState<number | null>(null);
  const buckets = dist.buckets;
  const H = 210;
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
    { v: value, row: 0, cls: 'you', text: `you ${formatTime(value, precision)}${value > x1 ? ' →' : value < x0 ? ' ←' : ''}` },
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
          {fmt(hb.from)} – {fmt(hb.to)} · {formatNumber(hb.count)} cubers
        </div>
      )}
    </div>
  );
}

function DistributionCard({
  row,
  kind,
  onKind,
  official,
  country,
  precision,
}: {
  row: Row;
  kind: WcaKind;
  onKind: (k: WcaKind) => void;
  official: number | null;
  country: string | null;
  precision: 2 | 3;
}) {
  const value = (kind === 'single' ? row.single : row.average)!;
  const dist = useAsync(() => getDistribution(row.event, kind), [row.event, kind]);
  const rank = useAsync(() => getRank(row.event, kind, value, country), [row.event, kind, value, country]);
  const kindLabel = kind === 'single' ? 'single' : row.avgKind;

  return (
    <div className="pv-card wc-dist-card">
      <div className="pv-card-head">
        <h3 className="pv-title">
          <span>
            <span className="text">{eventLabel(row.event)}</span> {kindLabel} among official {kind === 'single' ? 'singles' : 'averages'}
          </span>
          {(dist.loading || rank.loading) && (dist.data || rank.data) && <Spinner size={14} />}
        </h3>
        <div className="pv-seg" role="group" aria-label="single or average">
          {(['single', 'average'] as const).map((k) => (
            <button
              key={k}
              className={`btn-text${kind === k ? ' active' : ''}`}
              aria-pressed={kind === k}
              disabled={(k === 'single' ? row.single : row.average) === null}
              onClick={() => onKind(k)}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
      {rank.data && (
        <div className="wc-headline">
          <span className="big">#{formatNumber(rank.data.world.rank)}</span>
          <span className="wc-headline-meta">
            <span>
              in the world · faster than <span className="text">{formatPercent(rank.data.world.percentile)}</span> of{' '}
              {formatNumber(rank.data.world.total)}
            </span>
            {rank.data.country && (
              <span>
                #{formatNumber(rank.data.country.rank)} in {flagEmoji(rank.data.country.countryIso2 ?? country)}{' '}
                {(countryName(rank.data.country.countryIso2 ?? country) || rank.data.country.countryId).toLowerCase()}
              </span>
            )}
          </span>
        </div>
      )}
      {dist.error && !dist.data ? (
        <WidgetError error={dist.error} what="the wca distribution" onRetry={dist.reload} compact />
      ) : !dist.data ? (
        <Loading />
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
            <span>
              <i className="you" /> your cubetype pb
            </span>
            <span>median {formatTime(dist.data.p50, precision)}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------- widget

interface Props {
  summary: AsyncState<StatsSummary>;
  wcaId: string | null;
  country: string | null;
  own: boolean;
  precision: 2 | 3;
}

/** "Where would my PBs rank at a WCA competition?" — rank/percentile per PB + distribution. */
export function WcaComparison({ summary, wcaId, country, own, precision }: Props) {
  const meta = useAsync((signal) => api.wca.meta(signal), []);
  const person = useAsync((signal) => (wcaId ? api.wca.person(wcaId, signal) : Promise.resolve(null)), [wcaId]);
  const rows = useMemo(() => (summary.data ? rowsFromSummary(summary.data) : []), [summary.data]);
  const [selected, setSelected] = useState<{ event: string; kind: WcaKind } | null>(null);

  const current = rows.find((r) => r.event === selected?.event) ?? rows[0];
  const currentKind: WcaKind = current
    ? selected?.event === current.event && (selected.kind === 'single' ? current.single : current.average) !== null
      ? selected.kind
      : current.single !== null
        ? 'single'
        : 'average'
    : 'single';
  const officialFor = (event: string, kind: WcaKind) => person.data?.pbs.find((p) => p.event === event)?.[kind]?.value ?? null;
  const showOfficial = Boolean(wcaId && person.data);

  let body: JSX.Element;
  if (summary.error && !summary.data) body = <WidgetError error={summary.error} what="the stats service" onRetry={summary.reload} />;
  else if (!summary.data) body = <Loading />;
  else if (rows.length === 0)
    body = <WidgetEmpty icon={<Medal size={16} />}>no personal bests in wca events yet — {own ? 'go set some!' : 'check back later.'}</WidgetEmpty>;
  else if (meta.error && isWcaNotLoaded(meta.error))
    body = (
      <div className="pv-widget-msg">
        <Hourglass size={16} />
        <span>wca data is being imported — try again in a minute.</span>
        <button className="btn-text" onClick={meta.reload}>
          retry
        </button>
      </div>
    );
  else if (meta.error) body = <WidgetError error={meta.error} what="the wca service" onRetry={meta.reload} />;
  else if (!meta.data) body = <Loading />;
  else
    body = (
      <>
        <div className="table-wrap">
          <table className="table wc-table">
            <thead>
              <tr>
                <th className="ev">event</th>
                <th>your single</th>
                {showOfficial && <th className="hide-sm">official single</th>}
                <th>your average</th>
                {showOfficial && <th className="hide-sm">official average</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.event}
                  className={`clickable${current?.event === r.event ? ' wc-selected' : ''}`}
                  onClick={() => setSelected({ event: r.event, kind: current?.event === r.event ? currentKind : r.single !== null ? 'single' : 'average' })}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setSelected({ event: r.event, kind: r.single !== null ? 'single' : 'average' });
                  }}
                  aria-selected={current?.event === r.event}
                >
                  <td className="ev">{eventLabel(r.event)}</td>
                  <td
                    onClick={(e) => {
                      if (r.single === null) return;
                      e.stopPropagation();
                      setSelected({ event: r.event, kind: 'single' });
                    }}
                  >
                    <YourCell row={r} kind="single" country={country} precision={precision} />
                  </td>
                  {showOfficial && (
                    <td className="hide-sm">
                      <OfficialCell person={person.data} event={r.event} kind="single" precision={precision} />
                    </td>
                  )}
                  <td
                    onClick={(e) => {
                      if (r.average === null) return;
                      e.stopPropagation();
                      setSelected({ event: r.event, kind: 'average' });
                    }}
                  >
                    <YourCell row={r} kind="average" country={country} precision={precision} />
                  </td>
                  {showOfficial && (
                    <td className="hide-sm">
                      <OfficialCell person={person.data} event={r.event} kind="average" precision={precision} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {current && (
          <DistributionCard
            row={current}
            kind={currentKind}
            onKind={(k) => setSelected({ event: current.event, kind: k })}
            official={wcaId ? officialFor(current.event, currentKind) : null}
            country={country}
            precision={precision}
          />
        )}
        <p className="wc-sub">
          This information is based on competition results owned and maintained by the World Cube Association, published at{' '}
          <a href="https://www.worldcubeassociation.org/results" target="_blank" rel="noreferrer noopener">
            worldcubeassociation.org/results
          </a>{' '}
          as of {formatDate(meta.data.exportDate)}.
        </p>
      </>
    );

  return (
    <section className="wc" aria-label="wca comparison">
      <div className="pv-section-head">
        <h2 className="pv-title">
          <Globe /> wca comparison
        </h2>
        <span className="wc-sub">
          {wcaId ? (
            person.data ? (
              <>
                official results of{' '}
                <Link to={`/wca?person=${encodeURIComponent(wcaId)}`}>
                  {person.data.person.name} {flagEmoji(person.data.person.countryIso2)}
                </Link>
              </>
            ) : person.error ? (
              isWcaNotLoaded(person.error) ? null : `couldn’t load wca id ${wcaId}`
            ) : person.loading ? (
              'loading official results…'
            ) : null
          ) : null}
        </span>
      </div>
      <p className="wc-sub" style={{ marginTop: '-0.5rem' }}>
        where {own ? 'your' : 'these'} cubetype personal bests would place among every official wca competitor. click a row to see the distribution.
      </p>
      {body}
    </section>
  );
}
