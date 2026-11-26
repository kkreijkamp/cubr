import { useState } from 'react';
import { CloudArrowUpIcon } from '@heroicons/react/24/outline';
import { Modal } from '../Modal';
import { Spinner } from '../Spinner';
import { dismissUploadOffer, uploadLocalSolves, useUploadOffer } from '../../lib/solves';
import { useStore } from '../../lib/store';
import { solvingStore } from '../../timer/useTimerEngine';
import { formatNumber } from '../../lib/format';
import { toast } from '../../lib/toast';
import './dialogs.css';

/** "1 solve", "1,250 solves" */
const solvesText = (n: number) => `${formatNumber(n)} solve${n === 1 ? '' : 's'}`;

/**
 * After login: "upload the guest solves stored in this browser to your account?". Shown once per
 * browser session until accepted. Rendered once, by the app layout, so it appears on every page.
 */
export function LocalUploadOffer() {
  const offer = useUploadOffer();
  // it waits while a solve is under way: it must never open over a running timer
  const solving = useStore(solvingStore);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!offer || solving) return null;
  const one = offer.solves === 1;

  const upload = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await uploadLocalSolves();
      toast.success(`uploaded ${solvesText(r.solves)} in ${r.sessions} session${r.sessions === 1 ? '' : 's'}`);
    } catch (e) {
      setError((e as Error).message || 'upload failed - try again in a moment');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="keep your guest solves?" onClose={() => !busy && dismissUploadOffer()} center>
      <div className="dialog-message">
        <p style={{ margin: 0 }}>
          This browser has <span className="main">{solvesText(offer.solves)}</span> in {offer.sessions} session{offer.sessions === 1 ? '' : 's'} from before you
          signed in. {one ? 'Upload it to your account so it syncs' : 'Upload them to your account so they sync'} across devices and {one ? 'counts' : 'count'}{' '}
          towards your stats.
        </p>
        <p className="sub" style={{ margin: '0.75rem 0 0' }}>
          They are added as new sessions; the local copy is removed once the upload succeeds.
        </p>
        {error && (
          <p className="error" style={{ margin: '0.75rem 0 0' }}>
            {error}
          </p>
        )}
      </div>
      <div className="dialog-actions">
        <button className="btn" onClick={dismissUploadOffer} disabled={busy}>
          not now
        </button>
        <button className="btn primary" onClick={upload} disabled={busy}>
          {busy ? <Spinner size={16} /> : <CloudArrowUpIcon width={16} height={16} />} upload {solvesText(offer.solves)}
        </button>
      </div>
    </Modal>
  );
}
