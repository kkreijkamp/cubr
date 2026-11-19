import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { PageLoading } from '../components/Spinner';
import { AccountSection } from '../components/social/DataTools';
import { EditProfileModal } from '../components/social/EditProfileModal';
import { ProfileView } from '../components/social/ProfileView';
import { useAuth } from '../lib/auth';

export default function AccountPage() {
  const { status, user } = useAuth();
  const [editing, setEditing] = useState(false);
  const openEdit = useCallback(() => setEditing(true), []);

  useEffect(() => {
    document.title = 'account | cubr';
    return () => {
      document.title = 'cubr';
    };
  }, []);

  if (status === 'loading') return <PageLoading />;
  // back here after signing in, still with #change-password (from /.well-known/change-password)
  if (status !== 'authed' || !user) return <Navigate to={`/login?next=${encodeURIComponent(`/account${window.location.hash}`)}`} replace />;

  return (
    <>
      <ProfileView user={user} own onEdit={openEdit}>
        <AccountSection user={user} onEdit={openEdit} />
      </ProfileView>
      {editing && <EditProfileModal user={user} onClose={() => setEditing(false)} />}
    </>
  );
}
