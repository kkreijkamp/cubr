import { Link } from 'react-router-dom';
import { WidgetError } from './Widget';
import { PB_KINDS, plural } from './util';
import { api } from '../../lib/api';
import { formatAverage, formatDate, formatNumber, formatPercent, formatResult, timeAgo } from '../../lib/format';
import type { PB, PbKind, StatsSummary, UserRank } from '../../lib/types';
import { useAsync, type AsyncState } from '../../lib/useAsync';
import { Loading } from '../Spinner';

const pbText = (pb: PB | null | undefined, kind: PbKind, precision: 2 | 3) =>
  pb && pb.valueMs !== null ? formatResult(pb.valueMs === -1 ? -1 : pb.valueMs, kind, precision) : null;

/**
 * "#101 on cubr" with the share of ranked cubers, linking to that leaderboard page. The board can
 * rank another time than the best shown beside it (the anti-cheat leaves impossible times, and
 * averages with one in them, off the boards): then the rank says which time it is for.
 */
function RankLink({ rank, full, shownMs, precision }: { rank: UserRank; full?: boolean; shownMs: number | null | undefined; precision: 2 | 3 }) {
  const top = rank.total > 0 ? (rank.rank / rank.total) * 100 : 100;
  const other = shownMs != null && shownMs !== rank.valueMs ? formatResult(rank.valueMs, rank.kind, precision) : null;
  const shown = `#${formatNumber(rank.rank)}${full ? ' on cubr' : ''}${other ? ` (${other})` : ''}`;
  return (
    <Link
      className="pf-rank"
      to={`/leaderboards?event=${rank.event}&kind=${rank.kind}&period=all&page=${Math.ceil(rank.rank / 50)}`}
      // the name starts with what the link shows (speech input says what it sees)
      aria-label={`${shown}: ${rank.rank} of ${rank.total} on the ${rank.kind} leaderboard`}
      data-tip={
        other
          ? `the leaderboard has your ${other}: a faster time was left off it`
          : `top ${formatPercent(top)} of ${formatNumber(rank.total)} on the leaderboard`
      }
    >
      {shown}
    </Link>
  );
}

/**
 * One event's personal bests: the single big, the averages in a row beside it, each with its
 * all-time leaderboard place (single, ao5 and ao12 have boards).
 */
/** `fade`: the numbers fade in, for a change of event (not the first load, see ProfileView). */
export function EventBests({
  userId,
  event,
  summary,
  precision,
  fade = false,
}: {
  userId: string;
  event: string;
  summary: AsyncState<StatsSummary>;
  precision: 2 | 3;
  fade?: boolean;
}) {
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
    <section className={fade ? 'pf-bests fade' : 'pf-bests'} aria-label="personal bests">
      <div className="pf-single" aria-label={single ? `single ${pbText(single, 'single', precision)}, set ${formatDate(single.achievedAt)}` : 'no single yet'}>
        <span className="pf-single-value">{pbText(single, 'single', precision) ?? '-'}</span>
        <span className="pf-single-meta">
          <span>single</span>
          {single && <span data-tip={timeAgo(single.achievedAt)}>{formatDate(single.achievedAt)}</span>}
          {singleRank ? (
            <RankLink rank={singleRank} full shownMs={single?.valueMs} precision={precision} />
          ) : (
            // while the ranks load: a rank's width, so the averages beside it don't slide over when it comes
            single &&
            !ranks.data &&
            !ranks.error && (
              <span className="pf-rank reserve" aria-hidden="true">
                #00 on cubr
              </span>
            )
          )}
        </span>
      </div>
      <div className="pf-avgs">
        {averages.map((k) => {
          const pb = e.pbs[k] ?? null;
          const text = pbText(pb, k, precision);
          const rank = rankOf(k);
          return (
            <div
              key={k}
              className={`pf-avg${text ? '' : ' none'}`}
              data-tip={pb && text ? `set ${formatDate(pb.achievedAt)} - ${timeAgo(pb.achievedAt)}` : undefined}
            >
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
        {e.meanMs !== null && e.meanMs > 0 && <> - mean {formatAverage(e.meanMs, precision)}</>}
      </div>
    </section>
  );
}
