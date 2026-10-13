import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Loading } from '../components/Spinner';
import { AccountSection } from '../components/social/DataTools';
import { EditProfileModal } from '../components/social/EditProfileModal';
import { ProfileView } from '../components/social/ProfileView';
import { useAuth } from '../lib/auth';

export default function AccountPage() {
  const { status, user } = useAuth();
  const [editing, setEditing] = useState(false);
  const openEdit = useCallback(() => setEditing(true), []);

  useEffect(() => {
    document.title = 'account | cubetype';
    return () => {
      document.title = 'cubetype';
    };
  }, []);

  if (status === 'loading') return <Loading />;
  if (status !== 'authed' || !user) return <Navigate to={`/login?next=${encodeURIComponent('/account')}`} replace />;

  return (
    <>
      <ProfileView user={user} own onEdit={openEdit}>
        <AccountSection user={user} onEdit={openEdit} />
      </ProfileView>
      {editing && <EditProfileModal user={user} onClose={() => setEditing(false)} />}
    </>
  );
}
