import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftIcon, ArrowTopRightOnSquareIcon, CircleStackIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { EVENTS, getEvent } from '@cubetype/cubestats';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { flagEmoji, formatNumber, formatPercent } from '../../../lib/format';
import { useAsync } from '../../../lib/useAsync';
import type { WcaDistribution, WcaRank } from '../../../lib/types';
import { ErrorState, Loading, Spinner } from '../../Spinner';
import { useDebounced } from '../hooks';
import { EventPicker, Notice, Segmented } from '../ui';
import { countryName, loadCountries, type CountryOption } from './countries';
import { DistributionChart } from './DistributionChart';
import { formatWcaValue, isFmc, parseWcaInput, wcaErrorKind } from './wcaFormat';

type Kind = 'single' | 'average';
const WCA_EVENTS = EVENTS.map((e) => e.id);

/** Error display for the wca service: friendly "being imported" notice for 503 UNAVAILABLE. */
export function WcaError({ error, onRetry, what = 'WCA data' }: { error: Error; onRetry?: () => void; what?: string }) {
  const kind = wcaErrorKind(error);
  if (kind === 'importing') {
    return (
      <Notice
        tone="main"
        icon={<CircleStackIcon />}
        action={
          onRetry && (
            <button className="btn small" onClick={onRetry}>
              retry
            </button>
          )
        }
      >
        WCA data is being imported - try again in a minute.
      </Notice>
    );
  }
  if (kind === 'unavailable') return <ErrorState error={new Error(`the wca service is unavailable right now - couldn't load ${what}`)} onRetry={onRetry} />;
  return <ErrorState error={error} onRetry={onRetry} />;
}

function Flag({ iso2 }: { iso2: string | null | undefined }) {
  const f = flagEmoji(iso2);
  return f ? (
    <span className="flag" title={countryName(iso2)} aria-label={countryName(iso2)}>
      {f}
    </span>
  ) : null;
}

// ---------------------------------------------------------------------------- rank calculator
export interface RankParams {
  event: string;
  kind: Kind;
  t: string;
  country: string;
}

export function RankCalculator({ params, onChange, onPerson }: { params: RankParams; onChange: (p: Partial<RankParams>) => void; onPerson: (id: string) => void }) {
  const { user } = useAuth();
  const { event, kind, country } = params;
  const [input, setInput] = useState(params.t);
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const debounced = useDebounced(input, 400);
  const value = parseWcaInput(debounced, event, kind);
  const invalid = debounced.trim() !== '' && value === null;

  useEffect(() => {
    let alive = true;
    void loadCountries().then((c) => alive && setCountries(c));
    return () => {
      alive = false;
    };
  }, []);
  // default country: your profile's
  useEffect(() => {
    if (!country && user?.country && params.t === '') onChange({ country: user.country.toUpperCase() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.country]);
  useEffect(() => {
    if (debounced !== params.t) onChange({ t: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const rank = useAsync<WcaRank | null>(
    (signal) => (value === null ? Promise.resolve(null) : api.wca.rank({ event, kind, value, country: country || null }, signal)),
    [event, kind, value, country],
  );
  const dist = useAsync<WcaDistribution>((signal) => api.wca.distribution(event, kind, 50, signal), [event, kind]);
  const r = rank.data && rank.data.event === event && rank.data.kind === kind ? rank.data : null;
  // while the WCA export is being imported every call 503s: show one notice, not one per widget
  const importing = [rank.error, dist.error].find((e) => e && wcaErrorKind(e) === 'importing');
  const ev = getEvent(event);
  const fmc = isFmc(event);

  const neighbours = useMemo(() => {
    if (!r || value === null) return [];
    const list: { key: string; you?: boolean; personId?: string; name: string; iso2: string | null; value: number; rank: number | null }[] = r.neighbours.map((n) => ({
      key: n.personId,
      personId: n.personId,
      name: n.name,
      iso2: n.countryIso2,
      value: n.value,
      rank: n.worldRank,
    }));
    list.push({ key: 'you', you: true, name: user?.username ? `${user.username} (you)` : 'you', iso2: country || null, value, rank: r.world.rank });
    return list.sort((a, b) => a.value - b.value || (a.you ? -1 : b.you ? 1 : 0));
  }, [r, value, user?.username, country]);

  return (
    <div className="stack lg">
      <div className="wca-calc card">
        <div className="wca-calc-row">
          <EventPicker events={WCA_EVENTS} value={event} onChange={(e) => onChange({ event: e })} />
        </div>
        <div className="wca-calc-row inputs">
          <Segmented
            label="kind"
            value={kind}
            onChange={(k) => onChange({ kind: k })}
            options={[
              { value: 'single', label: 'single' },
              { value: 'average', label: fmc ? 'mean' : 'average' },
            ]}
          />
          <div className="wca-time">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onChange({ t: input });
              }}
              placeholder={fmc ? (kind === 'average' ? 'moves, e.g. 31.67' : 'moves, e.g. 32') : 'your time, e.g. 14.52'}
              inputMode={fmc ? 'decimal' : 'text'}
              aria-label={fmc ? 'number of moves' : 'your time'}
              aria-invalid={invalid}
              className={invalid ? 'invalid' : ''}
              autoFocus
            />
            <span className="unit">{fmc ? 'moves' : ev?.name ?? event}</span>
          </div>
          <select value={country} onChange={(e) => onChange({ country: e.target.value })} aria-label="country" className="wca-country">
            <option value="">worldwide only</option>
            {countries.map((c) => (
              <option key={c.iso2} value={c.iso2}>
                {flagEmoji(c.iso2)} {c.name}
              </option>
            ))}
          </select>
        </div>
        {invalid && <div className="small error">{fmc ? 'enter a number of moves (1-100' + (kind === 'average' ? ', up to 2 decimals)' : ')') : 'enter a time like 12.34, 1:05.21 or 1234'}</div>}
      </div>

      {importing ? (
        <WcaError
          error={importing}
          onRetry={() => {
            rank.reload();
            dist.reload();
          }}
        />
      ) : value === null ? (
        <div className="wca-hint sub">
          enter your {kind === 'average' ? (fmc ? 'mean' : 'average') : 'single'} to see where it would rank among every WCA competitor{country ? ` and in ${countryName(country)}` : ''}.
        </div>
      ) : rank.error ? (
        <WcaError error={rank.error} onRetry={rank.reload} what="your rank" />
      ) : !r ? (
        <Loading label="ranking..." />
      ) : (
        <div className={`wca-rank${rank.loading ? ' refreshing' : ''}`}>
          <div className="wca-rank-main">
            {r.world.total === 0 ? (
              <div className="sub">nobody has an official {kind} in {ev?.name ?? event} yet.</div>
            ) : (
              <>
                <div className="stat lg">
                  <span className="label">world rank</span>
                  <span className="value">#{formatNumber(r.world.rank)}</span>
                </div>
                <div className="wca-rank-sub">
                  faster than <span className="main">{formatPercent(r.world.percentile)}</span> of {formatNumber(r.world.total)} competitors
                </div>
                {r.country && (
                  <div className="wca-country-rank">
                    <Flag iso2={r.country.countryIso2} /> #{formatNumber(r.country.rank)} in {(r.country as { countryName?: string }).countryName ?? countryName(r.country.countryIso2) ?? r.country.countryId}
                    <span className="sub">
                      {' '}
                      - faster than {formatPercent(r.country.percentile)} of {formatNumber(r.country.total)}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
          {neighbours.length > 1 && (
            <div className="wca-neighbours">
              <div className="label sub small">around you</div>
              <table className="table">
                <tbody>
                  {neighbours.map((n) => (
                    <tr key={n.key} className={n.you ? 'me' : 'clickable'} onClick={n.personId ? () => onPerson(n.personId!) : undefined}>
                      <td className="center sub">{n.rank !== null ? formatNumber(n.rank) : ''}</td>
                      <td className="left name">
                        <Flag iso2={n.iso2} /> {n.name}
                      </td>
                      <td>{formatWcaValue(n.value, event, kind)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!importing && (
        <section className="card wca-dist" aria-labelledby="dist-title">
          <div className="live-section-title">
            <h3 className="h3" id="dist-title">
              {ev?.name ?? event} {kind === 'average' ? (fmc ? 'mean' : 'average') : 'single'} - all competitors
            </h3>
            <span className="meta">{dist.data ? `${formatNumber(dist.data.total)} people` : dist.loading ? <Spinner size={12} /> : ''}</span>
          </div>
          {dist.error ? (
            <WcaError error={dist.error} onRetry={dist.reload} what="the distribution" />
          ) : !dist.data || dist.data.event !== event || dist.data.kind !== kind ? (
            <Loading />
          ) : (
            <>
              <DistributionChart dist={dist.data} value={value} />
              <div className="wca-percentiles">
                {(
                  [
                    ['top 10%', dist.data.p10],
                    ['top 25%', dist.data.p25],
                    ['median', dist.data.p50],
                    ['top 75%', dist.data.p75],
                    ['top 90%', dist.data.p90],
                  ] as const
                ).map(([label, v]) => (
                  <span key={label}>
                    {label} <b>{formatWcaValue(v, event, kind)}</b>
                  </span>
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- records
export function RecordsTable({ onPerson }: { onPerson: (id: string) => void }) {
  const rec = useAsync((signal) => api.wca.records(signal), []);
  if (rec.error) return <WcaError error={rec.error} onRetry={rec.reload} what="records" />;
  if (!rec.data) return <Loading />;
  const rows = rec.data.records ?? [];
  if (!rows.length) return <div className="empty">no records found.</div>;

  const Holder = ({ v }: { v: NonNullable<(typeof rows)[number]['single']> & { holders?: { personId: string; personName: string; countryIso2: string | null }[] } }) => {
    const others = v.holders && v.holders.length > 1 ? v.holders.filter((h) => h.personId !== v.personId) : [];
    return (
      <>
        <button className="link-btn" onClick={() => onPerson(v.personId)}>
          <Flag iso2={v.countryIso2} /> {v.personName}
        </button>
        {others.length > 0 && (
          <span className="shared" title={`shared with ${others.map((h) => h.personName).join(', ')}`}>
            {' '}
            +{others.length}
          </span>
        )}
      </>
    );
  };

  return (
    <div className="table-wrap">
      <table className="table wca-records">
        <thead>
          <tr>
            <th className="left">event</th>
            <th>single</th>
            <th className="left">holder</th>
            <th>average</th>
            <th className="left">holder</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.event}>
              <td className="left">
                <span className="ev-short">{getEvent(r.event)?.short ?? r.event}</span>
                <span className="secondary"> {r.eventName}</span>
              </td>
              <td className="main-val">{r.single ? formatWcaValue(r.single.value, r.event, 'single') : '-'}</td>
              <td className="left holder">{r.single ? <Holder v={r.single} /> : ''}</td>
              <td className="main-val">{r.average ? formatWcaValue(r.average.value, r.event, 'average') : '-'}</td>
              <td className="left holder">{r.average ? <Holder v={r.average} /> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------- people
export function PeopleSearch({ initialQuery, onQuery, onPerson }: { initialQuery: string; onQuery: (q: string) => void; onPerson: (id: string) => void }) {
  const [q, setQ] = useState(initialQuery);
  const dq = useDebounced(q.trim(), 300);
  useEffect(() => {
    if (dq !== initialQuery) onQuery(dq);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  const res = useAsync((signal) => (dq.length >= 2 ? api.wca.persons(dq, 25, signal) : Promise.resolve(null)), [dq]);
  const persons = res.data?.persons ?? null;

  return (
    <div className="stack">
      <div className="wca-search">
        <MagnifyingGlassIcon width={16} height={16} className="sub" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search by name or WCA ID (e.g. 2009ZEMD01)" aria-label="search WCA competitors" autoFocus />
        {res.loading && dq.length >= 2 && <Spinner size={14} />}
      </div>
      {dq.length < 2 ? (
        <div className="empty">type at least 2 characters.</div>
      ) : res.error ? (
        <WcaError error={res.error} onRetry={res.reload} what="search results" />
      ) : !persons ? (
        <Loading />
      ) : persons.length === 0 ? (
        <div className="empty">nobody found for "{dq}".</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="left">name</th>
                <th className="left">wca id</th>
                <th className="left">country</th>
              </tr>
            </thead>
            <tbody>
              {persons.map((p) => (
                <tr key={p.wcaId} className="clickable" onClick={() => onPerson(p.wcaId)}>
                  <td className="left">
                    <Flag iso2={p.countryIso2} /> {p.name}
                  </td>
                  <td className="left secondary">{p.wcaId}</td>
                  <td className="left secondary">{countryName(p.countryIso2) || p.countryId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PersonCard({ wcaId, onBack }: { wcaId: string; onBack: () => void }) {
  const res = useAsync((signal) => api.wca.person(wcaId, signal), [wcaId]);
  const back = (
    <button className="btn-text wca-back" onClick={onBack}>
      <ArrowLeftIcon width={14} height={14} /> back
    </button>
  );
  if (res.error) {
    return (
      <div className="stack">
        {back}
        {wcaErrorKind(res.error) === 'notfound' ? <div className="empty">no WCA competitor with id {wcaId}.</div> : <WcaError error={res.error} onRetry={res.reload} what="this person" />}
      </div>
    );
  }
  if (!res.data) return <Loading />;
  const { person, pbs } = res.data;
  const rankCells = (v: { worldRank: number; continentRank: number; countryRank: number } | null) =>
    v ? (
      <>
        <td className={`rank ${v.countryRank === 1 ? 'nr' : ''}`}>{formatNumber(v.countryRank)}</td>
        <td className={`rank hide-sm ${v.continentRank === 1 ? 'cr' : ''}`}>{formatNumber(v.continentRank)}</td>
        <td className={`rank ${v.worldRank === 1 ? 'wr' : ''}`}>{formatNumber(v.worldRank)}</td>
      </>
    ) : (
      <>
        <td />
        <td className="hide-sm" />
        <td />
      </>
    );
  return (
    <div className="stack">
      {back}
      <div className="card wca-person">
        <div className="avatar" aria-hidden="true">
          {person.name.slice(0, 1)}
        </div>
        <div className="who">
          <div className="name">{person.name}</div>
          <div className="sub small">
            <Flag iso2={person.countryIso2} /> {countryName(person.countryIso2) || person.countryId} - {person.wcaId}
          </div>
        </div>
        <a className="btn small" href={`https://www.worldcubeassociation.org/persons/${encodeURIComponent(person.wcaId)}`} target="_blank" rel="noreferrer">
          <ArrowTopRightOnSquareIcon /> WCA profile
        </a>
      </div>
      {pbs.length === 0 ? (
        <div className="empty">no official results.</div>
      ) : (
        <div className="table-wrap">
          <table className="table wca-pbs">
            <thead>
              <tr>
                <th className="left">event</th>
                <th>NR</th>
                <th className="hide-sm">CR</th>
                <th>WR</th>
                <th>single</th>
                <th>average</th>
                <th>WR</th>
                <th className="hide-sm">CR</th>
                <th>NR</th>
              </tr>
            </thead>
            <tbody>
              {pbs.map((pb) => (
                <tr key={pb.event}>
                  <td className="left">{getEvent(pb.event)?.name ?? pb.event}</td>
                  {rankCells(pb.single)}
                  <td className="main-val">{formatWcaValue(pb.single?.value, pb.event, 'single')}</td>
                  <td className="main-val">{formatWcaValue(pb.average?.value, pb.event, 'average')}</td>
                  {pb.average ? (
                    <>
                      <td className={`rank ${pb.average.worldRank === 1 ? 'wr' : ''}`}>{formatNumber(pb.average.worldRank)}</td>
                      <td className={`rank hide-sm ${pb.average.continentRank === 1 ? 'cr' : ''}`}>{formatNumber(pb.average.continentRank)}</td>
                      <td className={`rank ${pb.average.countryRank === 1 ? 'nr' : ''}`}>{formatNumber(pb.average.countryRank)}</td>
                    </>
                  ) : (
                    <>
                      <td />
                      <td className="hide-sm" />
                      <td />
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
