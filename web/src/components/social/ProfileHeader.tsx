import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, ExternalLink, Link2, Pencil } from 'lucide-react';
import { formatDuration } from '@cubetype/cubestats';
import { AvatarEditor } from './AvatarEditor';
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

export function ProfileHeader({ user, summary, own, onEdit }: Props) {
  const name = user.displayName?.trim() || user.username;
  const totals = summary.data?.totals;
  const flag = flagEmoji(user.country);
  const hasDetails = Boolean(user.bio || user.wcaId || user.country);
  // the picture is editable where the rest of the profile is (account page)
  const editableAvatar = own && Boolean(onEdit);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const closeAvatar = useCallback(() => setAvatarOpen(false), []);

  return (
    <section className="pv-card pv-header" aria-label="profile">
      <div className="pv-ident">
        {editableAvatar ? (
          <button
            type="button"
            className="pv-avatar pv-avatar-btn"
            onClick={() => setAvatarOpen(true)}
            aria-label={user.avatarUrl ? 'change profile picture' : 'add a profile picture'}
            data-tip={user.avatarUrl ? 'change picture' : 'add a picture'}
            data-tip-pos="down"
          >
            <Avatar user={user} size={80} />
            <span className="pv-avatar-overlay" aria-hidden="true">
              <Camera />
            </span>
            <span className="pv-avatar-badge" aria-hidden="true">
              <Camera />
            </span>
          </button>
        ) : (
          <span className="pv-avatar">
            <Avatar user={user} size={80} />
          </span>
        )}
        <div className="pv-name-block">
          <h1 className="pv-name" title={name}>
            {name}
          </h1>
          <div className="pv-handle">
            {user.displayName && <span>@{user.username}</span>}
            {flag && (
              <span className="flag" data-tip={countryName(user.country)} aria-label={countryName(user.country)}>
                {flag}
              </span>
            )}
            {own && <span className="pill">you</span>}
          </div>
          <div className="pv-handle" data-tip={timeAgo(user.createdAt)} style={{ justifySelf: 'start' }}>
            joined {formatDate(user.createdAt)}
          </div>
        </div>
      </div>

      <div className="pv-divider" aria-hidden="true" />

      <div className="pv-details">
        {user.bio && (
          <div className="pv-detail wide">
            <span className="label">bio</span>
            <span className="value">{user.bio}</span>
          </div>
        )}
        {user.country && (
          <div className="pv-detail">
            <span className="label">country</span>
            <span className="value">
              {flag} {countryName(user.country)}
            </span>
          </div>
        )}
        {user.wcaId && (
          <div className="pv-detail">
            <span className="label">wca id</span>
            <span className="value">
              <Link to={`/wca?person=${encodeURIComponent(user.wcaId)}`}>{user.wcaId}</Link>
              <a
                className="ext"
                href={`https://www.worldcubeassociation.org/persons/${encodeURIComponent(user.wcaId)}`}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="open WCA profile"
                data-tip="wca profile"
              >
                <ExternalLink size={13} />
              </a>
            </span>
          </div>
        )}
        {totals && totals.activeDays > 0 && (
          <div className="pv-detail">
            <span className="label">active days</span>
            <span className="value">{formatNumber(totals.activeDays)}</span>
          </div>
        )}
        {!hasDetails && (
          <div className="pv-detail wide">
            <span className="label">bio</span>
            {own ? (
              <span className="value muted">
                tell people about yourself — add a bio, your country and your wca id.{' '}
                {onEdit && (
                  <button className="btn-text small" style={{ padding: 0, color: 'var(--main-color)' }} onClick={onEdit}>
                    edit profile
                  </button>
                )}
              </span>
            ) : (
              <span className="value muted">no bio yet.</span>
            )}
          </div>
        )}
      </div>

      <div className="pv-divider d2" aria-hidden="true" />

      {summary.error && !totals ? (
        <div className="pv-stats" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <WidgetError error={summary.error} what="the stats service" onRetry={summary.reload} compact />
        </div>
      ) : (
        <div className="pv-stats">
          <div className="stat">
            <span className="label">solves</span>
            <span className={`value${totals ? '' : ' dim'}`}>{totals ? formatNumber(totals.solves) : '-'}</span>
          </div>
          <div className="stat" data-tip={totals ? `${formatNumber(Math.round(totals.totalMs / 1000))} seconds` : undefined}>
            <span className="label">time cubing</span>
            <span className={`value${totals ? '' : ' dim'}`}>{totals ? formatDuration(totals.totalMs) : '-'}</span>
          </div>
          <div className="stat" data-tip={totals ? `longest streak: ${plural(totals.longestStreak, 'day')}` : undefined}>
            <span className="label">streak</span>
            <span className={`value${totals ? '' : ' dim'}`}>{totals ? plural(totals.currentStreak, 'day') : '-'}</span>
          </div>
        </div>
      )}

      <div className="pv-strip">
        {own && onEdit && (
          <button className="btn-text" onClick={onEdit} data-tip="edit profile" data-tip-pos="left" aria-label="edit profile">
            <Pencil />
          </button>
        )}
        <button className="btn-text" onClick={() => copyProfileLink(user.username)} data-tip="copy profile link" data-tip-pos="left" aria-label="copy profile link">
          <Link2 />
        </button>
      </div>

      {avatarOpen && (
        <Modal title="profile picture" onClose={closeAvatar}>
          <AvatarEditor onDone={closeAvatar} onCancel={closeAvatar} />
        </Modal>
      )}
    </section>
  );
}
