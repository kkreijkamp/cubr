import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { CameraIcon, LinkIcon, PencilIcon } from '@heroicons/react/24/outline';
import { formatDuration } from '@cubetype/cubestats';
import { AvatarEditor } from './AvatarEditor';
import { EventDonut } from './EventDonut';
import { countryName } from './countries';
import { WidgetError } from './Widget';
import { plural } from './util';
import { flagEmoji, formatDate, formatNumber, timeAgo } from '../../lib/format';
import { toast } from '../../lib/toast';
import type { PublicUser, StatsSummary } from '../../lib/types';
import type { AsyncState } from '../../lib/useAsync';
import { Avatar } from '../Avatar';
import { Modal } from '../Modal';

interface Props {
  user: PublicUser;
  summary: AsyncState<StatsSummary>;
  own: boolean;
  onEdit?: () => void;
  /** the profile's selected event (the donut highlights it and picks another) */
  event: string;
  onEvent: (event: string) => void;
}

async function copyProfileLink(username: string) {
  const url = `${window.location.origin}/profile/${encodeURIComponent(username)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast.success('profile link copied to clipboard');
  } catch {
    toast.notice(url, { title: 'profile link' });
  }
}

/** "oct 2026" */
function monthYear(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('en-US', { month: 'short', year: 'numeric' }).toLowerCase();
}

/** The top of the profile: who it is (and their events as a ring), then the lifetime totals as a row of big numbers. */
export function ProfileHeader({ user, summary, own, onEdit, event, onEvent }: Props) {
  const name = user.displayName?.trim() || user.username;
  const totals = summary.data?.totals;
  const flag = flagEmoji(user.country);
  // the picture is editable where the rest of the profile is (account page)
  const editableAvatar = own && Boolean(onEdit);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const closeAvatar = useCallback(() => setAvatarOpen(false), []);

  const stats: { label: string; value: string; tip?: string }[] = [
    { label: 'solves', value: totals ? formatNumber(totals.solves) : '-' },
    { label: 'time cubing', value: totals ? formatDuration(totals.totalMs) : '-', tip: totals ? `${formatNumber(Math.round(totals.totalMs / 1000))} seconds` : undefined },
    { label: 'active days', value: totals ? formatNumber(totals.activeDays) : '-' },
    {
      label: 'day streak',
      value: totals ? formatNumber(totals.currentStreak) : '-',
      tip: totals ? `longest streak: ${plural(totals.longestStreak, 'day')}` : undefined,
    },
  ];

  return (
    <header className="pf-hero" aria-label="profile">
      <div className="pf-id">
        {editableAvatar ? (
          <button
            type="button"
            className="pv-avatar pv-avatar-btn"
            onClick={() => setAvatarOpen(true)}
            aria-label={user.avatarUrl ? 'change profile picture' : 'add a profile picture'}
            data-tip={user.avatarUrl ? 'change picture' : 'add a picture'}
            data-tip-pos="down"
          >
            <Avatar user={user} size={112} />
            <span className="pv-avatar-overlay" aria-hidden="true">
              <CameraIcon />
            </span>
            <span className="pv-avatar-badge" aria-hidden="true">
              <CameraIcon />
            </span>
          </button>
        ) : (
          <span className="pv-avatar">
            <Avatar user={user} size={112} />
          </span>
        )}

        <div className="pf-who">
          <h1 className="pf-name" title={name}>
            {name}
          </h1>
          <div className="pf-meta">
            {user.displayName && <span>@{user.username}</span>}
            {flag && (
              <span className="flag" data-tip={countryName(user.country)} aria-label={countryName(user.country)}>
                {flag}
              </span>
            )}
            <span data-tip={`${formatDate(user.createdAt)} - ${timeAgo(user.createdAt)}`}>joined {monthYear(user.createdAt)}</span>
            {user.wcaId && (
              <Link to={`/wca?person=${encodeURIComponent(user.wcaId)}`} data-tip="official wca results">
                {user.wcaId}
              </Link>
            )}
            {own && <span className="pill">you</span>}
            <span className="pf-actions">
              {own && onEdit && (
                <button className="btn-text" onClick={onEdit} data-tip="edit profile" aria-label="edit profile">
                  <PencilIcon />
                </button>
              )}
              <button className="btn-text" onClick={() => copyProfileLink(user.username)} data-tip="copy profile link" aria-label="copy profile link">
                <LinkIcon />
              </button>
            </span>
          </div>
          {user.bio ? (
            <p className="pf-bio">{user.bio}</p>
          ) : own && onEdit ? (
            <button className="btn-text pf-bio-add" onClick={onEdit}>
              add a bio, your country and your wca id
            </button>
          ) : null}
        </div>

        {summary.data && <EventDonut events={summary.data.events} selected={event} onSelect={onEvent} />}
      </div>

      {summary.error && !totals ? (
        <WidgetError error={summary.error} what="the stats service" onRetry={summary.reload} compact />
      ) : (
        <dl className="pf-totals">
          {stats.map((s) => (
            <div key={s.label} className={totals ? undefined : 'dim'} data-tip={s.tip}>
              <dt>{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {avatarOpen && (
        <Modal title="profile picture" onClose={closeAvatar}>
          <AvatarEditor onDone={closeAvatar} onCancel={closeAvatar} />
        </Modal>
      )}
    </header>
  );
}
