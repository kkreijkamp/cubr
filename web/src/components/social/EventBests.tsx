import { Link } from 'react-router-dom';
import { WidgetError } from './Widget';
import { PB_KINDS, plural } from './util';
import { api } from '../../lib/api';
import { formatDate, formatNumber, formatPercent, formatTime, timeAgo } from '../../lib/format';
import type { PB, PbKind, StatsSummary, UserRank } from '../../lib/types';
import { useAsync, type AsyncState } from '../../lib/useAsync';
import { Loading } from '../Spinner';

const pbText = (pb: PB | null | undefined, precision: 2 | 3) =>
  pb && pb.valueMs !== null ? formatTime(pb.valueMs === -1 ? -1 : pb.valueMs, precision) : null;

/**
 * "#101 on cubr" with the share of ranked cubers, linking to that leaderboard page. The board can
 * rank another time than the best shown beside it (the anti-cheat leaves impossible times, and
 * averages with one in them, off the boards): then the rank says which time it is for.
 */
function RankLink({ rank, full, shownMs, precision }: { rank: UserRank; full?: boolean; shownMs: number | null | undefined; precision: 2 | 3 }) {
  const top = rank.total > 0 ? (rank.rank / rank.total) * 100 : 100;
  const other = shownMs != null && shownMs !== rank.valueMs ? formatTime(rank.valueMs, precision) : null;
  return (
    <Link
      className="pf-rank"
      to={`/leaderboards?event=${rank.event}&kind=${rank.kind}&period=all&page=${Math.ceil(rank.rank / 50)}`}
      aria-label={`rank ${rank.rank} of ${rank.total} on the ${rank.kind} leaderboard${other ? `, with ${other}` : ''}`}
      data-tip={
        other
          ? `the leaderboard has your ${other}: a faster time was left off it`
          : `top ${formatPercent(top)} of ${formatNumber(rank.total)} on the leaderboard`
      }
    >
      #{formatNumber(rank.rank)}
      {full && ' on cubr'}
      {other && ` (${other})`}
    </Link>
  );
}

/**
 * One event's personal bests: the single big, the averages in a row beside it, each with its
 * all-time leaderboard place (single, ao5 and ao12 have boards).
 */
export function EventBests({ userId, event, summary, precision }: { userId: string; event: string; summary: AsyncState<StatsSummary>; precision: 2 | 3 }) {
  const ranks = useAsync((signal) => api.leaderboards.userRanks(userId, signal), [userId]);
  if (summary.error && !summary.data) return <WidgetError error={summary.error} what="the stats service" onRetry={summary.reload} />;
  if (!summary.data) return <Loading />;
  const e = summary.data.events.find((x) => x.event === event);
  if (!e) return null;
  const rankOf = (kind: PbKind) => ranks.data?.ranks.find((r) => r.event === event && r.kind === kind);
  const single = e.pbs.single ?? null;
  const singleRank = rankOf('single');
  const averages = PB_KINDS.filter((k) => k !== 'single');

  return (
    <section className="pf-bests" aria-label="personal bests">
      <div className="pf-single" aria-label={single ? `single ${pbText(single, precision)}, set ${formatDate(single.achievedAt)}` : 'no single yet'}>
        <span className="pf-single-value">{pbText(single, precision) ?? '-'}</span>
        <span className="pf-single-meta">
          <span>single</span>
          {single && <span data-tip={timeAgo(single.achievedAt)}>{formatDate(single.achievedAt)}</span>}
          {singleRank && <RankLink rank={singleRank} full shownMs={single?.valueMs} precision={precision} />}
        </span>
      </div>
      <div className="pf-avgs">
        {averages.map((k) => {
          const pb = e.pbs[k] ?? null;
          const text = pbText(pb, precision);
          const rank = rankOf(k);
          return (
            <div key={k} className={`pf-avg${text ? '' : ' none'}`} data-tip={pb && text ? `set ${formatDate(pb.achievedAt)} - ${timeAgo(pb.achievedAt)}` : undefined}>
              <span className="v">{text ?? '-'}</span>
              <span className="k">
                {k}
                {rank && <RankLink rank={rank} shownMs={pb?.valueMs} precision={precision} />}
              </span>
            </div>
          );
        })}
      </div>
      <div className="pf-bests-meta">
        {plural(e.solves, 'solve')}
        {e.meanMs !== null && e.meanMs > 0 && <> - mean {formatTime(e.meanMs, precision)}</>}
      </div>
    </section>
  );
}
