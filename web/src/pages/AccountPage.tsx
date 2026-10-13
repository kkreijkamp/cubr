import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { LogOut, UserCog } from 'lucide-react';
import { Loading } from '../components/Spinner';
import { ProfileView } from '../components/social/ProfileView';
import { useAuth } from '../lib/auth';
import { toast } from '../lib/toast';

export default function AccountPage() {
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    document.title = 'account | cubetype';
    return () => {
      document.title = 'cubetype';
    };
  }, []);

  if (status === 'loading') return <Loading />;
  if (status !== 'authed' || !user) return <Navigate to={`/login?next=${encodeURIComponent('/account')}`} replace />;

  const doLogout = async () => {
    await logout();
    toast.notice('you have been signed out', { title: 'signed out' });
    navigate('/');
  };

  return (
    <ProfileView user={user} own>
      <section className="pv-card" aria-label="account">
        <div className="ac-rows">
          <div className="ac-row">
            <div>
              <div className="t">
                <UserCog /> account
              </div>
              <div className="d">
                signed in as <span className="text">{user.username}</span> · {user.email}
              </div>
            </div>
            <div className="ac-actions">
              <button className="btn danger-text" onClick={doLogout}>
                <LogOut /> log out
              </button>
            </div>
          </div>
        </div>
      </section>
    </ProfileView>
  );
}
