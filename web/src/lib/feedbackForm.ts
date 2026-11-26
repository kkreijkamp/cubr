// The feedback popup's form (components/FeedbackModal.tsx), for feedback without leaving cubr: an email
// address for a reply (optional), what it's about and the message, sent to POST /api/feedback, which
// emails it to cubr's inbox (services/auth/src/feedback.ts). It adds the same line as the email and the
// GitHub issue (lib/feedbackLinks.ts, feedbackDetails), and the popup shows that line.
import { ApiError } from './api';

/** What a message can be about: the value sent (the server takes these), the menu's name for it, and
 *  what the message box asks. services/auth/src/feedback.ts has the same values and names. */
export const FEEDBACK_KINDS = [
  { value: 'bug', label: 'bug', prompt: 'what happened, and what did you expect?' },
  { value: 'idea', label: 'idea', prompt: 'what would you like cubr to do?' },
  { value: 'question', label: 'question', prompt: 'what would you like to know?' },
  { value: 'account', label: 'account help', prompt: "what's wrong? add your email so we can reply" },
  { value: 'other', label: 'something else', prompt: "what's on your mind?" },
] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]['value'];

/** the longest message, in characters (the server's limit; the box's maxlength counts the same way) */
export const FEEDBACK_MAX = 5000;

export interface FeedbackDraft {
  kind: FeedbackKind;
  email: string;
  message: string;
}

export const EMPTY_DRAFT: FeedbackDraft = { kind: 'bug', email: '', message: '' };

/** What's typed in the form. It stays while the popup is closed, until it's sent, so a click outside the
 *  popup or Esc loses nothing. Only in memory: a reload starts empty. */
export const feedbackDraft: { current: FeedbackDraft } = { current: EMPTY_DRAFT };

/** Whether `s` can be an email address (something@something.something, no spaces). The server checks it properly. */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/** The request for a draft: the message and email trimmed, an empty email left out, and the details line. */
export function feedbackRequest(d: FeedbackDraft, details: string): { kind: FeedbackKind; message: string; email?: string; details: string } {
  const email = d.email.trim();
  return { kind: d.kind, message: d.message.trim(), ...(email && { email }), details };
}

/** Why a message wasn't sent, for the line under the form (the text stays in it); the email button below is the way round. */
export function feedbackSendError(err: unknown, withEmail: boolean): string {
  if (err instanceof ApiError) {
    if (err.code === 'NETWORK') return "couldn't send it: no connection. try again, or use email below";
    if (err.status === 429) return 'too many messages for now. try again later, or use email below';
    if (err.status === 400 && withEmail) return 'check the email address';
  }
  return "couldn't send it right now. try again later, or use email below";
}
