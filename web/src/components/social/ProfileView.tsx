import { useMemo, type ReactNode } from 'react';
import { EVENT_IDS } from '@cubetype/cubestats';
import { HourlyChart } from './Charts';
import { SolveHistoryChart } from './HistoryChart';
import { ActivityHeatmap } from './Heatmap';
import { PbCards } from './PbCards';
import { ProfileHeader } from './ProfileHeader';
import { ProfileSolves } from './ProfileSolves';
import { RanksCard } from './RanksCard';
import { WcaComparison } from './WcaComparison';
import { api } from '../../lib/api';
import { useSettings } from '../../lib/settings';
import type { PublicUser } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import './social.css';

interface Props {
  user: PublicUser;
  /** the signed-in user's own profile (account page) */
  own: boolean;
  onEdit?: () => void;
  /** extra sections appended at the bottom (account: data tools) */
  children?: ReactNode;
}

/**
 * Shared profile layout for /account and /profile/:username. Every widget fetches its own data
 * (useAsync) with its own loading/error state, so a down microservice only blanks its widget.
 */
export function ProfileView({ user, own, onEdit, children }: Props) {
  const { precision } = useSettings();
  const summary = useAsync((signal) => api.stats.summary(user.id, signal), [user.id]);

  const { events, defaultEvent } = useMemo(() => {
    const list = (summary.data?.events ?? []).filter((e) => e.solves > 0);
    const sorted = [...list].sort((a, b) => EVENT_IDS.indexOf(a.event) - EVENT_IDS.indexOf(b.event)).map((e) => e.event);
    const top = list.reduce<{ event: string; solves: number } | null>((a, e) => (!a || e.solves > a.solves ? e : a), null);
    return { events: sorted, defaultEvent: top?.event ?? '333' };
  }, [summary.data]);

  // brand-new cubers: skip the empty charts / comparison and let the pb card invite them to solve
  const noSolves = summary.data !== undefined && summary.data.totals.solves === 0;

  return (
    <div className="pv">
      <ProfileHeader user={user} summary={summary} own={own} onEdit={onEdit} />
      <RanksCard userId={user.id} own={own} precision={precision} />
      <PbCards summary={summary} own={own} precision={precision} />
      <ActivityHeatmap userId={user.id} joinedAt={user.createdAt} />
      {!noSolves && (
        <>
          <SolveHistoryChart key={`hist-${user.id}-${defaultEvent}`} userId={user.id} events={events} defaultEvent={defaultEvent} precision={precision} />
          <HourlyChart key={`hr-${user.id}-${defaultEvent}`} userId={user.id} events={events} defaultEvent={defaultEvent} precision={precision} />
          <WcaComparison summary={summary} wcaId={user.wcaId} country={user.country} own={own} onEdit={onEdit} precision={precision} />
          <ProfileSolves key={`solves-${user.id}-${defaultEvent}`} userId={user.id} events={events} defaultEvent={defaultEvent} precision={precision} />
        </>
      )}
      {children}
    </div>
  );
}
