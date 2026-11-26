import { describe, expect, it } from 'vitest';
import modalSource from '../../components/FeedbackModal.tsx?raw';
import { ApiError } from '../api';
import { EMPTY_DRAFT, FEEDBACK_KINDS, FEEDBACK_MAX, feedbackDraft, feedbackRequest, feedbackSendError, looksLikeEmail } from '../feedbackForm';

// The feedback popup's form: what it sends to POST /api/feedback, and what it says when that fails. The
// server's side (the same types and limit) is services/auth/test/feedback.test.ts.

describe('the feedback form', () => {
  it('offers each type once, starting with a bug, each with its own question in the message box', () => {
    expect(FEEDBACK_KINDS.map((k) => k.value)).toEqual(['bug', 'idea', 'question', 'account', 'other']);
    expect(new Set(FEEDBACK_KINDS.map((k) => k.label)).size).toBe(FEEDBACK_KINDS.length);
    expect(new Set(FEEDBACK_KINDS.map((k) => k.prompt)).size).toBe(FEEDBACK_KINDS.length);
    expect(EMPTY_DRAFT).toEqual({ kind: 'bug', email: '', message: '' });
    expect(feedbackDraft.current).toEqual(EMPTY_DRAFT);
    expect(FEEDBACK_MAX).toBe(5000);
  });

  it('takes anything shaped like an email address, and leaves the real check to the server', () => {
    for (const ok of ['jo@example.com', ' jo.smith+cubr@mail.example.co ', 'a@b.c']) expect(looksLikeEmail(ok), ok).toBe(true);
    for (const bad of ['', 'jo', 'jo@', 'jo@example', '@example.com', 'jo @example.com', 'jo@exa mple.com']) expect(looksLikeEmail(bad), bad).toBe(false);
  });

  it('sends the message and email trimmed, no email when there is none, and the details line', () => {
    const details = 'cubr v1.6.9 · Chrome 142 on macOS · 1280×800 · /daily';
    expect(feedbackRequest({ kind: 'idea', email: ' jo@example.com ', message: '\n a dark stackmat \n' }, details)).toEqual({
      kind: 'idea',
      message: 'a dark stackmat',
      email: 'jo@example.com',
      details,
    });
    expect(feedbackRequest({ kind: 'bug', email: '   ', message: 'x' }, details)).toEqual({ kind: 'bug', message: 'x', details });
  });

  it('says why it was not sent, and points to the email button', () => {
    expect(feedbackSendError(new ApiError(0, 'NETWORK', 'Network error'), false)).toBe("couldn't send it: no connection. try again, or use email below");
    expect(feedbackSendError(new ApiError(429, 'RATE_LIMITED', 'Too many messages'), true)).toBe(
      'too many messages for now. try again later, or use email below',
    );
    expect(feedbackSendError(new ApiError(400, 'BAD_REQUEST', 'email: Invalid email address'), true)).toBe('check the email address');
    const later = "couldn't send it right now. try again later, or use email below";
    expect(feedbackSendError(new ApiError(400, 'BAD_REQUEST', 'message: write a message'), false)).toBe(later);
    expect(feedbackSendError(new ApiError(503, 'UNAVAILABLE', "Feedback can't be sent right now"), true)).toBe(later);
    expect(feedbackSendError(new ApiError(0, 'TIMEOUT', 'Request timed out'), true)).toBe(later);
    expect(feedbackSendError(new Error('boom'), false)).toBe(later);
  });

  it('shows the details line it sends', () => {
    expect(modalSource).toContain('api.feedback.send(feedbackRequest(form, details))');
    expect(modalSource).toContain('which helps track bugs down: {details}');
  });
});
