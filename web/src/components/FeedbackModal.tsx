import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { CodeBracketIcon, EnvelopeIcon } from '@heroicons/react/24/outline';
import { Modal } from './Modal';
import { Spinner } from './Spinner';
import { api } from '../lib/api';
import { CONTACT_EMAIL } from '../lib/links';
import { describeBrowser, feedbackDetails, feedbackIssueUrl, feedbackMailto } from '../lib/feedbackLinks';
import {
  EMPTY_DRAFT,
  FEEDBACK_KINDS,
  FEEDBACK_MAX,
  feedbackDraft,
  feedbackRequest,
  feedbackSendError,
  looksLikeEmail,
  type FeedbackDraft,
  type FeedbackKind,
} from '../lib/feedbackForm';
import { pwaStore } from '../lib/pwa';
import { toast } from '../lib/toast';

/** The footer's feedback popup: a message sent from here (lib/feedbackForm.ts), or an email to cubr's
 *  address or a GitHub issue (lib/feedbackLinks.ts). All three add the version, browser, window size and
 *  page, which the popup shows. */
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
  const [form, setForm] = useState<FeedbackDraft>(() => feedbackDraft.current);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the draft outlives the popup until it's sent
  const change = (patch: Partial<FeedbackDraft>) => {
    const next = { ...form, ...patch };
    feedbackDraft.current = next;
    setForm(next);
    setError(null);
  };
  // focus starts on the first field, as in the app's other forms
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  // closes once the link is on its way (the mail app or GitHub's tab opens): after the click, not during it
  const followed = () => window.setTimeout(onClose, 0);

  const email = form.email.trim();
  const badEmail = submitted && email !== '' && !looksLikeEmail(email);
  const blank = form.message.trim() === '';
  const prompt = FEEDBACK_KINDS.find((k) => k.value === form.kind)?.prompt;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (busy || blank || (email !== '' && !looksLikeEmail(email))) return;
    setBusy(true);
    setError(null);
    try {
      await api.feedback.send(feedbackRequest(form, details));
      feedbackDraft.current = EMPTY_DRAFT;
      toast.success('feedback sent, thanks');
      onClose();
    } catch (err) {
      setError(feedbackSendError(err, email !== ''));
      setBusy(false);
    }
  };

  return (
    <Modal title="feedback" onClose={onClose} center>
      <p className="feedback-text">found a bug or have an idea? tell us here.</p>
      <form className="feedback-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="feedback-two">
          <div className="field">
            <label htmlFor="feedback-email">email (optional)</label>
            <input
              id="feedback-email"
              ref={first}
              type="email"
              autoComplete="email"
              spellCheck={false}
              maxLength={254}
              placeholder="for a reply"
              value={form.email}
              aria-invalid={badEmail}
              aria-describedby={badEmail ? 'feedback-email-error' : undefined}
              onChange={(e) => change({ email: e.target.value })}
            />
            {badEmail && (
              <span className="error-text" id="feedback-email-error">
                that doesn&apos;t look like an email address
              </span>
            )}
          </div>
          <div className="field">
            <label htmlFor="feedback-kind">type</label>
            <select id="feedback-kind" value={form.kind} onChange={(e) => change({ kind: e.target.value as FeedbackKind })}>
              {FEEDBACK_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="feedback-message">message</label>
          <textarea
            id="feedback-message"
            rows={5}
            maxLength={FEEDBACK_MAX}
            placeholder={prompt}
            value={form.message}
            onChange={(e) => change({ message: e.target.value })}
          />
        </div>
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
        <div className="feedback-actions">
          <button type="submit" className="btn primary" disabled={busy || blank}>
            {busy && <Spinner size={16} />} send
          </button>
        </div>
      </form>
      <div className="feedback-or" aria-hidden="true">
        or
      </div>
      <p className="feedback-text">
        send it by email to <span className="text">{CONTACT_EMAIL}</span>, or open a public issue on github.
      </p>
      <div className="feedback-options">
        <a className="btn" href={feedbackMailto(details)} onClick={followed}>
          <EnvelopeIcon /> email
        </a>
        <a className="btn" href={feedbackIssueUrl(details)} target="_blank" rel="noreferrer noopener" onClick={followed}>
          <CodeBracketIcon /> github issue
        </a>
      </div>
      <p className="feedback-note">all three come with your cubr version, browser and page, which helps track bugs down: {details}</p>
    </Modal>
  );
}
