import { LockClosedIcon } from '@heroicons/react/24/outline';
import type { PublicUser } from '../../lib/types';
import { Avatar } from '../Avatar';
import './social.css';

/** A private profile as anyone but its owner sees it: the picture and username, the rest blanked. */
export function PrivateProfileView({ user }: { user: PublicUser }) {
  return (
    <div className="pf">
      <header className="pf-hero" aria-label="profile">
        <div className="pf-id">
          <span className="pv-avatar">
            <Avatar user={user} size={112} />
          </span>
          <div className="pf-who">
            <h1 className="pf-name" title={user.username}>
              {user.username}
            </h1>
          </div>
        </div>
      </header>
      <div className="pf-private" role="status">
        <LockClosedIcon width={28} height={28} aria-hidden="true" />
        <span className="pf-private-title">this profile is private</span>
        <span>only {user.username} can see their stats, solves and details.</span>
      </div>
    </div>
  );
}
