import { useNavigate } from 'react-router-dom';
import { LogOut, Pencil, UserCog } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useRegisterCommands } from '../../lib/commands';
import { toast } from '../../lib/toast';
import type { PrivateUser } from '../../lib/types';

/** Account-only section: profile + logout. */
export function AccountSection({ user, onEdit }: { user: PrivateUser; onEdit: () => void }) {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const doLogout = async () => {
    await logout();
    toast.notice('you have been signed out', { title: 'signed out' });
    navigate('/');
  };

  useRegisterCommands(
    'account',
    () => [{ id: 'account-edit', label: 'Edit profile', icon: <Pencil />, run: onEdit }],
    [onEdit],
  );

  return (
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
            <button className="btn" onClick={onEdit}>
              <Pencil /> edit profile
            </button>
            <button className="btn danger-text" onClick={doLogout}>
              <LogOut /> log out
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
