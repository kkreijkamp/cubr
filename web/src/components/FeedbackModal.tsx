import { useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { CodeBracketIcon, EnvelopeIcon } from '@heroicons/react/24/outline';
import { Modal } from './Modal';
import { CONTACT_EMAIL } from '../lib/links';
import { describeBrowser, feedbackDetails, feedbackIssueUrl, feedbackMailto } from '../lib/feedbackLinks';
import { pwaStore } from '../lib/pwa';

/** The footer's feedback popup: an email to cubr's address or a GitHub issue, each with the version, browser,
 *  window size and page filled in below the room to write (lib/feedbackLinks.ts). */
export function FeedbackModal({ version, onClose }: { version: string | null; onClose: () => void }) {
  const { pathname } = useLocation();
  const details = useMemo(
    () =>
      feedbackDetails({
        version,
        browser: describeBrowser(navigator.userAgent, navigator.maxTouchPoints),
        installed: pwaStore.get().standalone,
        width: window.innerWidth,
        height: window.innerHeight,
        page: pathname,
      }),
    [version, pathname],
  );
  // focus starts on the first choice (React's autoFocus skips links); the ring shows only after a key press
  const email = useRef<HTMLAnchorElement>(null);
  useEffect(() => email.current?.focus(), []);
  // closes once the link is on its way (the mail app or GitHub's tab opens): after the click, not during it
  const followed = () => window.setTimeout(onClose, 0);
  return (
    <Modal title="feedback" onClose={onClose} center>
      <p className="feedback-text">
        found a bug or have an idea? send it by email to <span className="text">{CONTACT_EMAIL}</span>, or open a public issue on github.
      </p>
      <div className="feedback-options">
        <a className="btn" href={feedbackMailto(details)} onClick={followed} ref={email}>
          <EnvelopeIcon /> email
        </a>
        <a className="btn" href={feedbackIssueUrl(details)} target="_blank" rel="noreferrer noopener" onClick={followed}>
          <CodeBracketIcon /> github issue
        </a>
      </div>
      <p className="feedback-note">both come with your cubr version, browser and page filled in, which helps track bugs down.</p>
    </Modal>
  );
}
