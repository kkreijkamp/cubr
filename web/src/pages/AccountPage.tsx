import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { Loading } from '../components/Spinner';
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
    <div className="stack" style={{ justifyItems: 'center', paddingTop: '4rem' }}>
      <h1 className="h2">{user.username}</h1>
      <div className="sub">
        signed in as <span className="text">{user.username}</span> · {user.email}
      </div>
      <button className="btn" onClick={doLogout}>
        <LogOut /> log out
      </button>
    </div>
  );
}
