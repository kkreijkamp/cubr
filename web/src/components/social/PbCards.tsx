import { Link } from 'react-router-dom';
import { TrophyIcon } from '@phosphor-icons/react';
import { EVENT_IDS } from '@cubetype/cubestats';
import { WidgetEmpty, WidgetError } from './Widget';
import { PB_KINDS, eventLabel, plural } from './util';
import { formatDate, formatTime, timeAgo } from '../../lib/format';
import type { PB, PbKind, StatsSummary } from '../../lib/types';
import type { AsyncState } from '../../lib/useAsync';
import { Loading } from '../Spinner';

function PbCell({ kind, pb, precision }: { kind: PbKind; pb: PB | null; precision: 2 | 3 }) {
  const has = pb !== null && pb.valueMs !== null;
  const value = has ? formatTime(pb!.valueMs === -1 ? -1 : pb!.valueMs, precision) : '-';
  return (
    <div
      className={`pv-pb-cell ${has ? 'has' : 'none'}`}
      tabIndex={has ? 0 : undefined}
      aria-label={has ? `${kind} ${value}, achieved ${formatDate(pb!.achievedAt)}` : `${kind}: none yet`}
    >
      <div className="pv-pb-front">
        <span className="label">{kind}</span>
        <span className="value">{value}</span>
      </div>
      {has && (
        <div className="pv-pb-back" aria-hidden="true">
          <span>{kind} set on</span>
          <span className="d">{formatDate(pb!.achievedAt)}</span>
          <span>{timeAgo(pb!.achievedAt)}</span>
        </div>
      )}
    </div>
  );
}

/** One card per event the user has solved: single / mo3 / ao5 / ao12 / ao50 / ao100 (hover -> date). */
export function PbCards({ summary, own, precision }: { summary: AsyncState<StatsSummary>; own: boolean; precision: 2 | 3 }) {
  if (summary.error && !summary.data) {
    return (
      <section className="pv-card" aria-label="personal bests">
        <WidgetError error={summary.error} what="the stats service" onRetry={summary.reload} />
      </section>
    );
  }
  if (!summary.data) {
    return (
      <section className="pv-card" aria-label="personal bests">
        <Loading />
      </section>
    );
  }
  const events = summary.data.events.filter((e) => e.solves > 0).sort((a, b) => EVENT_IDS.indexOf(a.event) - EVENT_IDS.indexOf(b.event));
  if (events.length === 0) {
    return (
      <section className="pv-card" aria-label="personal bests">
        <WidgetEmpty icon={<TrophyIcon size={16} />}>
          {own ? (
            <>
              no solves yet - <Link to="/" className="link-main">open the timer</Link> and press space. your personal bests, charts and wca
              comparison will show up here.
            </>
          ) : (
            'no solves yet - personal bests and charts will appear after the first solve.'
          )}
        </WidgetEmpty>
      </section>
    );
  }
  return (
    <section className="pv-pbs" aria-label="personal bests">
      {events.map((e) => (
        <div className="pv-pb-card" key={e.event}>
          <div className="pv-pb-head">
            <h3 className="pv-pb-event">{eventLabel(e.event)}</h3>
            <span className="pv-pb-meta">
              {plural(e.solves, 'solve')}
              {e.meanMs !== null && e.meanMs > 0 && <> - mean {formatTime(e.meanMs, precision)}</>}
            </span>
          </div>
          <div className="pv-pb-grid">
            {PB_KINDS.map((k) => (
              <PbCell key={k} kind={k} pb={e.pbs[k] ?? null} precision={precision} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
