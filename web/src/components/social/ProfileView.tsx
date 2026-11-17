import { useMemo, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EVENT_IDS } from '@cubr/cubestats';
import { HourlyChart } from './Charts';
import { EventBests } from './EventBests';
import { SolveHistoryChart } from './HistoryChart';
import { ActivityHeatmap } from './Heatmap';
import { ProfileHeader } from './ProfileHeader';
import { ProfileSolves } from './ProfileSolves';
import { WcaComparison } from './WcaComparison';
import { isTouchDevice } from '../timer/feedback';
import { eventLabel } from './util';
import { api } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { useSettings } from '../../lib/settings';
import type { PublicUser } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { Loading } from '../Spinner';
import './social.css';

interface Props {
  user: PublicUser;
  /** the signed-in user's own profile (account page) */
  own: boolean;
  onEdit?: () => void;
  /** extra sections appended at the bottom (account: data tools) */
  children?: ReactNode;
}

/** The events the cuber has solved, as text tabs; the choice drives everything below it. */
function EventTabs({ events, counts, value, onChange }: { events: string[]; counts: Map<string, number>; value: string; onChange: (e: string) => void }) {
  return (
    <nav className="pf-tabs" aria-label="event">
      {events.map((e) => (
        <button key={e} className={`pf-tab${e === value ? ' active' : ''}`} aria-pressed={e === value} onClick={() => onChange(e)}>
          {eventLabel(e)}
          <span className="n">{formatNumber(counts.get(e) ?? 0)}</span>
        </button>
      ))}
    </nav>
  );
}

/**
 * Shared profile layout for /account and /profile/:username: who and how much on top, then one
 * event at a time (bests, progress, activity and time of day, wca, solves). Every
 * widget fetches its own data with its own loading/error state, so a down microservice only blanks
 * its widget. The event is kept in the address (?event=) so a link opens on it.
 */
export function ProfileView({ user, own, onEdit, children }: Props) {
  const { precision } = useSettings();
  const summary = useAsync((signal) => api.stats.summary(user.id, signal), [user.id]);
  const [params, setParams] = useSearchParams();

  const { events, counts, defaultEvent } = useMemo(() => {
    const list = (summary.data?.events ?? []).filter((e) => e.solves > 0);
    const sorted = [...list].sort((a, b) => EVENT_IDS.indexOf(a.event) - EVENT_IDS.indexOf(b.event)).map((e) => e.event);
    const top = list.reduce<{ event: string; solves: number } | null>((a, e) => (!a || e.solves > a.solves ? e : a), null);
    return { events: sorted, counts: new Map(list.map((e) => [e.event, e.solves])), defaultEvent: top?.event ?? '333' };
  }, [summary.data]);

  const asked = params.get('event');
  const event = asked && events.includes(asked) ? asked : defaultEvent;
  const pick = (e: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (e === defaultEvent) next.delete('event');
        else next.set('event', e);
        return next;
      },
      { replace: true },
    );

  // brand-new cubers: no event to show yet, just a word on where the numbers will come from
  const noSolves = summary.data !== undefined && summary.data.totals.solves === 0;

  return (
    <div className="pf">
      <ProfileHeader user={user} summary={summary} own={own} onEdit={onEdit} event={event} onEvent={pick} />
      {noSolves ? (
        <p className="pf-empty">
          {own ? (
            <>
              no solves yet - <Link to="/">open the timer</Link> and {isTouchDevice() ? 'hold it to start' : 'press space'}. personal bests, progress and the wca comparison show up here.
            </>
          ) : (
            'no solves yet - personal bests and progress show up here after the first solve.'
          )}
        </p>
      ) : !summary.data ? (
        !summary.error && <Loading />
      ) : (
        (
          <div className="pf-event">
            <EventTabs events={events} counts={counts} value={event} onChange={pick} />
            <EventBests key={event} userId={user.id} event={event} summary={summary} precision={precision} />
            <SolveHistoryChart key={`hist-${user.id}-${event}`} userId={user.id} event={event} precision={precision} />
            {/* when they cube: days (the calendar keeps its range across events) and hours */}
            <div className="pf-habits">
              <ActivityHeatmap key={`act-${user.id}`} userId={user.id} event={event} years={summary.data?.totals.activeYears} />
              <HourlyChart key={`hr-${user.id}-${event}`} userId={user.id} event={event} precision={precision} />
            </div>
            <WcaComparison key={`wca-${event}`} summary={summary} event={event} wcaId={user.wcaId} country={user.country} own={own} onEdit={onEdit} precision={precision} />
            <ProfileSolves key={`solves-${user.id}-${event}`} userId={user.id} event={event} precision={precision} />
          </div>
        )
      )}
      {children}
    </div>
  );
}
