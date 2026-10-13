import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { UserSearch } from 'lucide-react';
import { ErrorState, Loading } from '../components/Spinner';
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
    document.title = `${username} | cubetype`;
    return () => {
      document.title = 'cubetype';
    };
  }, [username]);

  if (profile.error && !profile.data) {
    if (profile.error instanceof ApiError && profile.error.status === 404) {
      return (
        <div className="empty stack" style={{ justifyItems: 'center', paddingTop: '4rem' }}>
          <UserSearch size={40} className="sub" aria-hidden="true" />
          <div className="text" style={{ fontSize: '1.5rem' }}>
            no cuber called “{username}”
          </div>
          <div className="sub">maybe they changed their name, or it was never solved ¯\_(ツ)_/¯</div>
          <div className="row" style={{ justifyContent: 'center' }}>
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
  return <ProfileView user={own && me ? me : user} own={own} />;
}
