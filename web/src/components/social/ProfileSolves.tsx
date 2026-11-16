import { useMemo, useState } from 'react';
import { rollingAverage, type Penalty } from '@cubr/cubestats';
import { Section, WidgetEmpty, WidgetError } from './Widget';
import { eventLabel } from './util';
import { fmtAvg, fmtSolveLong } from '../timer/statsUtil';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatNumber, timeAgo } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { SessionName } from '../SessionName';
import { Loading, Spinner } from '../Spinner';

const PAGE = 25;
/** older solves fetched beyond the listed ones, so the oldest listed row still gets its ao1000 */
const CONTEXT = 999;
/** the stats service's ?limit= cap */
const MAX_LIMIT = 50_000;

/**
 * Monkeytype-style results table at the bottom of the profile: the newest solves of one event,
 * newest first, with the rolling ao5 / ao12 / ao100 / ao1000 at each solve (over the whole history,
 * like the history chart) and "load more". Served from the stats read model, so it works on any
 * public profile.
 */
export function ProfileSolves({ userId, event, precision }: { userId: string; event: string; precision: 2 | 3 }) {
  const [listed, setListed] = useState(PAGE);
  const series = useAsync((signal) => api.stats.solves(userId, event, signal, { limit: listed + CONTEXT }), [userId, event, listed]);
  // useAsync keeps the previous event's rows while the next one loads
  const data = series.data?.event === event ? series.data : undefined;

  const rows = useMemo(() => {
    if (!data) return [];
    const eff = data.solves.map((r) => (r[2] === null ? Number.POSITIVE_INFINITY : r[2]));
    const ao5 = rollingAverage(eff, 5);
    const ao12 = rollingAverage(eff, 12);
    const ao100 = rollingAverage(eff, 100);
    const ao1000 = rollingAverage(eff, 1000);
    const before = data.total - data.solves.length; // older solves that were not fetched
    // while "load more" is loading, only list rows whose averages are already complete
    const count = Math.min(listed, data.solves.length - (data.truncated ? CONTEXT : 0));
    const out = [];
    for (let i = data.solves.length - 1; i >= data.solves.length - count; i--) {
      const [t, timeMs, effective, session = -1] = data.solves[i];
      const penalty: Penalty = effective === null ? 'DNF' : effective > timeMs ? '+2' : 'OK';
      const s = data.sessions?.[session];
      out.push({
        n: before + i + 1,
        at: new Date(t * 1000).toISOString(),
        time: fmtSolveLong({ timeMs, penalty }, precision),
        dnf: penalty === 'DNF',
        ao5: fmtAvg(ao5[i], precision),
        ao12: fmtAvg(ao12[i], precision),
        ao100: fmtAvg(ao100[i], precision),
        ao1000: fmtAvg(ao1000[i], precision),
        session: s ? (s.name ?? `session ${session + 1}`) : '-',
        practice: s?.practice === true,
      });
    }
    return out;
  }, [data, listed, precision]);

  const more = data ? Math.min(PAGE, data.total - rows.length, MAX_LIMIT - CONTEXT - listed) : 0;

  let body;
  if (series.error && !data) body = <WidgetError error={series.error} what="the solves" onRetry={series.reload} />;
  else if (!data) body = <Loading />;
  else if (data.total === 0) body = <WidgetEmpty>no {eventLabel(event)} solves yet</WidgetEmpty>;
  else
    body = (
      <>
        <div className="table-wrap">
          <table className="table ps-table">
            <thead>
              <tr>
                <th className="left">#</th>
                <th>time</th>
                <th>ao5</th>
                <th>ao12</th>
                <th className="ps-long">ao100</th>
                <th className="ps-long">ao1000</th>
                <th className="left hide-mobile-cell">session</th>
                <th>date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.n}>
                  <td className="left sub">{formatNumber(r.n)}</td>
                  <td className={r.dnf ? 'dnf' : undefined}>{r.time}</td>
                  <td>{r.ao5}</td>
                  <td>{r.ao12}</td>
                  <td className="ps-long">{r.ao100}</td>
                  <td className="ps-long">{r.ao1000}</td>
                  <td className="left sub hide-mobile-cell">
                    <SessionName name={r.session} practice={r.practice} />
                  </td>
                  <td className="sub" title={`${formatDateTime(r.at)} - ${timeAgo(r.at)}`}>
                    {formatDate(r.at)}
                    {/* phones: the day only, so the row fits without scrolling sideways */}
                    <span className="hide-mobile-cell"> {formatDateTime(r.at).slice(-5)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {more > 0 && (
          <button className="btn-text small ps-more" onClick={() => setListed((n) => n + PAGE)} disabled={series.loading}>
            {series.loading ? <Spinner size={14} /> : `load ${more} more`}
          </button>
        )}
      </>
    );

  return (
    <Section label="solves" className="ps" title="solves" extra={data && data.total > 0 && `${formatNumber(rows.length)} of ${formatNumber(data.total)}`}>
      {body}
    </Section>
  );
}
