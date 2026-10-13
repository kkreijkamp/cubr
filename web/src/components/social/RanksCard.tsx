import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Crown } from 'lucide-react';
import { EVENT_IDS } from '@cubetype/cubestats';
import { WidgetEmpty, WidgetError } from './Widget';
import { eventLabel } from './util';
import { api } from '../../lib/api';
import { formatNumber, formatPercent, formatTime } from '../../lib/format';
import type { UserRank } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { Loading } from '../Spinner';

const KIND_ORDER = ['single', 'ao5', 'ao12'];
const COLLAPSED = 8;

function byEventThenKind(a: UserRank, b: UserRank): number {
  return EVENT_IDS.indexOf(a.event) - EVENT_IDS.indexOf(b.event) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
}

/** "all-time leaderboards: 3x3 single #12 · top 2.1%" (api.leaderboards.userRanks). */
export function RanksCard({ userId, own, precision }: { userId: string; own: boolean; precision: 2 | 3 }) {
  const ranks = useAsync((signal) => api.leaderboards.userRanks(userId, signal), [userId]);
  const [expanded, setExpanded] = useState(false);
  const list = ranks.data ? [...ranks.data.ranks].sort(byEventThenKind) : [];
  const shown = expanded ? list : list.slice(0, COLLAPSED);

  return (
    <section className="pv-card" aria-label="leaderboard positions">
      <div className="pv-card-head" style={{ marginBottom: list.length ? '0.85rem' : 0 }}>
        <h2 className="pv-title">
          <Crown /> all-time leaderboards
        </h2>
        <Link to="/leaderboards" className="small">
          view leaderboards
        </Link>
      </div>
      {ranks.error && !ranks.data ? (
        <WidgetError error={ranks.error} what="the leaderboard service" onRetry={ranks.reload} compact />
      ) : !ranks.data ? (
        <Loading />
      ) : list.length === 0 ? (
        <WidgetEmpty compact>
          {own ? 'not ranked yet — set a single or an ao5 on the timer to appear on the leaderboards.' : 'not ranked on any leaderboard yet.'}
        </WidgetEmpty>
      ) : (
        <>
          <div className="pv-ranks">
            {shown.map((r) => {
              const top = r.total > 0 ? (r.rank / r.total) * 100 : 100;
              const page = Math.ceil(r.rank / 50);
              return (
                <Link
                  key={`${r.event}-${r.kind}`}
                  className="pv-rank"
                  to={`/leaderboards?event=${r.event}&kind=${r.kind}&period=all&page=${page}`}
                  aria-label={`${eventLabel(r.event)} ${r.kind}: rank ${r.rank} of ${r.total}`}
                >
                  <span className="l">
                    {eventLabel(r.event)} {r.kind}
                  </span>
                  <span className="r">
                    {r.rank === 1 && <Crown />}#{formatNumber(r.rank)}
                  </span>
                  <span className="h">
                    {formatTime(r.valueMs, precision)} · top {formatPercent(top)}
                  </span>
                </Link>
              );
            })}
          </div>
          {list.length > COLLAPSED && (
            <button className="btn-text small pv-more" onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'show fewer' : `show all ${list.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
