import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { ErrorState, Loading } from '../components/Spinner';
import { PrivateProfileView } from '../components/social/PrivateProfile';
import { ProfileView } from '../components/social/ProfileView';
import { friendlyError } from '../components/social/util';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/useAsync';

export default function ProfilePage() {
  const { username = '' } = useParams();
  const { user: me } = useAuth();
  const profile = useAsync((signal) => api.auth.user(username, signal), [username]);

  useEffect(() => {
    document.title = `${username} | cubr`;
    return () => {
      document.title = 'cubr';
    };
  }, [username]);

  if (profile.error && !profile.data) {
    if (profile.error instanceof ApiError && profile.error.status === 404) {
      return (
        <div className="empty stack" style={{ justifyItems: 'center', paddingTop: '4rem' }}>
          <MagnifyingGlassIcon width={40} height={40} className="sub" aria-hidden="true" />
          <div className="text" style={{ fontSize: '1.5rem', overflowWrap: 'anywhere' }}>
            no cuber called "{username}"
          </div>
          <div className="sub">maybe they changed their name, or it was never solved {'\u00af\\_(\u30c4)_/\u00af'}</div>
          <div className="row wrap" style={{ justifyContent: 'center' }}>
            <Link to="/leaderboards" className="btn">
              browse leaderboards
            </Link>
            <Link to="/" className="btn">
              back to the timer
            </Link>
          </div>
        </div>
      );
    }
    return <ErrorState error={new Error(friendlyError(profile.error, 'the auth service'))} onRetry={profile.reload} />;
  }
  if (!profile.data) return <Loading />;

  const user = profile.data.user;
  const own = me?.id === user.id;
  if (user.private && !own) return <PrivateProfileView user={user} />;
  const shown = own && me ? me : user;
  return (
    <ProfileView user={shown} own={own}>
      {own && (
        <div className="center small sub">
          {shown.private ? 'your profile is private: others only see your picture and username' : 'this is your public profile'} -{' '}
          <Link to="/account" className="link-main">
            edit it on your account page
          </Link>
        </div>
      )}
    </ProfileView>
  );
}
