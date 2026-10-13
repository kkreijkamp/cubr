import type { ReactNode } from 'react';
import { ActivityHeatmap } from './Heatmap';
import { PbCards } from './PbCards';
import { ProfileHeader } from './ProfileHeader';
import { api } from '../../lib/api';
import { useSettings } from '../../lib/settings';
import type { PublicUser } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import './social.css';

interface Props {
  user: PublicUser;
  /** the signed-in user's own profile (account page) */
  own: boolean;
  /** extra sections appended at the bottom (account page) */
  children?: ReactNode;
}

/**
 * Shared profile layout for /account and /profile/:username. Every widget fetches its own data
 * (useAsync) with its own loading/error state, so a down microservice only blanks its widget.
 */
export function ProfileView({ user, own, children }: Props) {
  const { precision } = useSettings();
  const summary = useAsync((signal) => api.stats.summary(user.id, signal), [user.id]);

  return (
    <div className="pv">
      <ProfileHeader user={user} summary={summary} own={own} />
      <PbCards summary={summary} own={own} precision={precision} />
      <ActivityHeatmap userId={user.id} joinedAt={user.createdAt} />
      {children}
    </div>
  );
}
