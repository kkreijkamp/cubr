import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle } from 'lucide-react';
import { CountrySelect } from './CountrySelect';
import { friendlyError } from './util';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import type { PrivateUser } from '../../lib/types';
import { Modal } from '../Modal';
import { Spinner } from '../Spinner';

const MAX_NAME = 40;
const MAX_BIO = 280;
const WCA_ID_RE = /^\d{4}[A-Z]{4}\d{2}$/;

function Counter({ n, max }: { n: number; max: number }) {
  return (
    <span className={`count${n > max ? ' over' : ''}`} aria-hidden="true">
      {n}/{max}
    </span>
  );
}

/** Edit display name, bio, country and WCA id → PATCH /api/auth/me → auth.setUser. */
export function EditProfileModal({ user, onClose }: { user: PrivateUser; onClose: () => void }) {
  const { setUser } = useAuth();
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [bio, setBio] = useState(user.bio ?? '');
  const [country, setCountry] = useState(user.country ?? '');
  const [wcaId, setWcaId] = useState(user.wcaId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const wca = wcaId.trim().toUpperCase();
  const wcaError = wca && !WCA_ID_RE.test(wca) ? 'format: 4 digits, 4 letters, 2 digits — e.g. 2015ABCD01' : null;
  const nameError = displayName.trim().length > MAX_NAME ? `at most ${MAX_NAME} characters` : null;
  const bioError = bio.trim().length > MAX_BIO ? `at most ${MAX_BIO} characters` : null;
  const invalid = Boolean(wcaError || nameError || bioError);

  const patch = {
    displayName: displayName.trim() || null,
    bio: bio.trim() || null,
    country: country || null,
    wcaId: wca || null,
  };
  const changed =
    patch.displayName !== (user.displayName ?? null) ||
    patch.bio !== (user.bio ?? null) ||
    patch.country !== (user.country ?? null) ||
    patch.wcaId !== (user.wcaId ?? null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (invalid || busy) return;
    if (!changed) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.auth.updateMe(patch);
      setUser(res.user);
      toast.success('profile updated');
      onClose();
    } catch (err) {
      setError(friendlyError(err, 'the auth service'));
      setBusy(false);
    }
  };

  return (
    <Modal title="edit profile" onClose={onClose}>
      <form className="ep-form" onSubmit={submit} noValidate>
        <div className="field">
          <label className="ep-label" htmlFor="ep-name">
            <span>display name</span>
            <Counter n={displayName.trim().length} max={MAX_NAME} />
          </label>
          <input
            id="ep-name"
            ref={nameRef}
            value={displayName}
            placeholder={user.username}
            maxLength={MAX_NAME + 10}
            onChange={(e) => setDisplayName(e.target.value)}
            aria-invalid={Boolean(nameError)}
          />
          {nameError && <span className="error-text">{nameError}</span>}
        </div>
        <div className="field">
          <label className="ep-label" htmlFor="ep-bio">
            <span>bio</span>
            <Counter n={bio.trim().length} max={MAX_BIO} />
          </label>
          <textarea
            id="ep-bio"
            value={bio}
            placeholder="main: gan 12 · cfop, learning zbll · sub-10 goal"
            maxLength={MAX_BIO + 20}
            rows={3}
            onChange={(e) => setBio(e.target.value)}
            aria-invalid={Boolean(bioError)}
          />
          {bioError && <span className="error-text">{bioError}</span>}
        </div>
        <div className="ep-two">
          <div className="field">
            <label htmlFor="ep-country">country</label>
            <CountrySelect id="ep-country" value={country} onChange={setCountry} />
          </div>
          <div className="field">
            <label htmlFor="ep-wca">wca id</label>
            <input
              id="ep-wca"
              value={wcaId}
              placeholder="2015ABCD01"
              maxLength={10}
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e) => setWcaId(e.target.value.toUpperCase().replace(/\s/g, ''))}
              aria-invalid={Boolean(wcaError && (submitted || wca.length >= 10))}
              aria-describedby="ep-wca-hint"
            />
          </div>
        </div>
        {wcaError && (submitted || wca.length >= 10) ? (
          <span className="field">
            <span className="error-text" id="ep-wca-hint">
              {wcaError}
            </span>
          </span>
        ) : (
          <span className="ep-hint" id="ep-wca-hint">
            linking your wca id shows your official results next to your cubetype pbs.{' '}
            <a href="https://www.worldcubeassociation.org/persons" target="_blank" rel="noreferrer noopener">
              find your id
            </a>
          </span>
        )}
        {error && (
          <div className="ep-error" role="alert">
            <AlertCircle size={15} /> {error}
          </div>
        )}
        <div className="ep-actions">
          <button type="button" className="btn" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || (submitted && invalid)}>
            {busy && <Spinner size={16} />} save
          </button>
        </div>
      </form>
    </Modal>
  );
}
