import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CrownIcon, TrophyIcon } from '@phosphor-icons/react';
import { formatTime, fromApiValue, type Precision } from '@cubetype/cubestats';
import { api, ApiError } from '../../../lib/api';
import { flagEmoji, formatNumber } from '../../../lib/format';
import { useAsync } from '../../../lib/useAsync';
import { ErrorState, Loading, Spinner } from '../../Spinner';

const SHOWN = 10;

/** Daily-challenge ao5 leaderboard for one event + UTC date, with your row highlighted. */
export function DailyBoard({
  event,
  date,
  refreshKey,
  userId,
  username,
  precision,
  onMe,
}: {
  /** reports your rank (or null) whenever the board loads */
  onMe?: (me: { rank: number; valueMs: number; total: number } | null) => void;
  event: string;
  date: string;
  refreshKey: number;
  userId: string | null;
  username: string | null;
  precision: Precision;
}) {
  const [expanded, setExpanded] = useState(false);
  const lb = useAsync((signal) => api.leaderboards.dailyChallenge(event, date, signal), [event, date, refreshKey, userId]);
  // useAsync keeps the previous data while reloading: don't show another event's board meanwhile
  const data = lb.data && (!lb.data.event || lb.data.event === event) ? lb.data : undefined;
  const entries = data?.entries ?? [];
  const shown = expanded ? entries : entries.slice(0, SHOWN);
  const me = data?.me ?? null;
  const meVisible = me ? shown.some((e) => e.userId === userId) : false;
  const total = data?.total ?? 0;
  useEffect(() => {
    if (data) onMe?.(me ? { ...me, total } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return (
    <section className="card daily-board" aria-labelledby="dboard-title">
      <div className="live-section-title">
        <h3 className="h3" id="dboard-title">
          <TrophyIcon /> leaderboard
        </h3>
        <span className="meta">
          {lb.loading && data ? <Spinner size={12} /> : null} {data ? `${formatNumber(data.total)} ranked` : ''}
        </span>
      </div>
      {lb.error && !data ? (
        <ErrorState
          error={lb.error instanceof ApiError && lb.error.isUnavailable ? new Error('leaderboard service unavailable') : lb.error}
          onRetry={lb.reload}
        />
      ) : !data ? (
        <Loading />
      ) : entries.length === 0 ? (
        <div className="empty">no completed ao5 yet {'\u00af\\_(\u30c4)_/\u00af'}</div>
      ) : (
        <>
          <table className="table daily-table">
            <thead>
              <tr>
                <th className="center">#</th>
                <th className="left">name</th>
                <th>ao5</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.userId} className={e.userId === userId ? 'me' : ''}>
                  <td className="center">{e.rank === 1 ? <CrownIcon size={14} aria-label="1st" className="crown" /> : e.rank}</td>
                  <td className="left name">
                    {e.country && <span className="flag">{flagEmoji(e.country)}</span>}
                    <Link to={`/profile/${encodeURIComponent(e.username)}`}>{e.username}</Link>
                  </td>
                  <td>{formatTime(fromApiValue(e.valueMs), precision)}</td>
                </tr>
              ))}
              {me && !meVisible && (
                <>
                  <tr className="gap" aria-hidden="true">
                    <td colSpan={3}>...</td>
                  </tr>
                  <tr className="me">
                    <td className="center">{me.rank}</td>
                    <td className="left name">{username ?? 'you'}</td>
                    <td>{formatTime(fromApiValue(me.valueMs), precision)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
          {entries.length > SHOWN && (
            <button className="btn-text small daily-more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'show top 10' : `show top ${entries.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
