import { z } from 'zod';
import { escapeHtml, page, type Email } from './mail.js';

// ---------------------------------------------------------------------------------------------
// The feedback form (POST /api/feedback), in the footer's feedback popup next to an email and a GitHub
// issue (web/src/components/FeedbackModal.tsx): the request schema, the limits and the email that takes
// a message to cubr's inbox (pure, unit-tested). The route is in routes/feedback.ts. Nothing is stored:
// the message is emailed to the contact inbox (MAIL_REPLY_TO, hello@cubr.dev), and a reply goes to the
// address the person gave, if any.
// ---------------------------------------------------------------------------------------------

/** What a message is about. The web app's menu offers the same (web/src/lib/feedbackLinks.ts, FEEDBACK_KINDS). */
export const FEEDBACK_KINDS = ['bug', 'idea', 'question', 'account', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** each kind as the menu and the email's subject name it */
export const FEEDBACK_KIND_NAMES: Readonly<Record<FeedbackKind, string>> = {
  bug: 'bug',
  idea: 'idea',
  question: 'question',
  account: 'account help',
  other: 'something else',
};

export const FEEDBACK_LIMITS = {
  /** a message's length in characters (UTF-16 code units, as the browser's maxlength counts them) */
  message: 5000,
  /** messages one address may send, per 10 minutes and per day */
  perIp: 3,
  perIpWindowSec: 600,
  perIpDay: 10,
  /**
   * emails from everyone together per day. Past it, or while Redis can't count, the form says to email
   * instead, so a flood can't use up the sending that password resets and confirmations need.
   */
  total: 25,
  totalWindowSec: 86_400,
  /** the request body */
  bodyBytes: 32 * 1024,
} as const;

// control characters other than tab and line feed
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** an empty or all-space field counts as left out */
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const feedbackSchema = z
  .object({
    kind: z.enum(FEEDBACK_KINDS),
    /** as written, with its line breaks as \n, no other control characters, and trimmed */
    message: z
      .string()
      .transform((s) => s.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim())
      .pipe(z.string().min(1, 'write a message').max(FEEDBACK_LIMITS.message)),
    /** where a reply goes; none when left out or empty */
    email: z.preprocess(blank, z.string().trim().max(254).email().optional()),
    /** the app's one line of what helps track a bug down (web/src/lib/feedbackLinks.ts, feedbackDetails) */
    details: z.preprocess(
      blank,
      z
        .string()
        .max(300)
        .transform((s) => s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim())
        .optional(),
    ),
  })
  .strict();

export type Feedback = z.infer<typeof feedbackSchema>;

/** The message's first line with words in it, its spaces collapsed, cut to `max` characters (whole ones: never half an emoji). */
export function firstLine(message: string, max = 60): string {
  const line = message.split('\n').find((l) => l.trim() !== '') ?? '';
  const chars = Array.from(line.replace(/\s+/g, ' ').trim());
  return chars.length <= max
    ? chars.join('')
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

/**
 * The email to cubr's inbox: the message as written, then what it's about, where a reply goes and the
 * app's details line. The subject names the kind and starts the message, so the inbox reads as a list.
 * The route sets reply-to to the sender's address, so answering is just "reply". In the HTML the message
 * keeps its line breaks and spacing (a pasted error stays readable).
 */
export function feedbackEmail(f: Feedback): Email {
  const kind = FEEDBACK_KIND_NAMES[f.kind];
  const subject = `cubr feedback (${kind}): ${firstLine(f.message)}`;
  const facts = [`type: ${kind}`, `reply to: ${f.email ?? 'no email given'}`, `sent from: ${f.details ?? 'unknown'}`];
  const text = [f.message, '', '-- ', ...facts].join('\n');
  const html = page({
    title: subject,
    paragraphs: [`<span style="white-space:pre-wrap">${escapeHtml(f.message)}</span>`],
    footnote: facts.map(escapeHtml).join('<br>'),
  });
  return { subject, text, html };
}
