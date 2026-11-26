import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEEDBACK_KINDS, FEEDBACK_KIND_NAMES, FEEDBACK_LIMITS, feedbackEmail, feedbackSchema, firstLine } from '../src/feedback.js';

const ok = { kind: 'bug', message: 'the timer stops at 10 seconds', email: 'jo@example.com', details: 'cubr v1.6.9 · Chrome 142 on macOS · 1280×800 · /daily' };
const parse = (body: unknown) => feedbackSchema.safeParse(body);

describe('the feedback form request', () => {
  it('takes a type, a message, and optionally an email and the details line', () => {
    expect(parse(ok)).toEqual({ success: true, data: ok });
    expect(parse({ kind: 'idea', message: 'dark mode for the stackmat theme' })).toEqual({
      success: true,
      data: { kind: 'idea', message: 'dark mode for the stackmat theme' },
    });
    for (const kind of FEEDBACK_KINDS) expect(parse({ ...ok, kind }).success, kind).toBe(true);
  });

  it('keeps the message as written: line breaks as \\n, other control characters out, trimmed', () => {
    const r = parse({ ...ok, message: '  first line\r\n\r\n  indented\rnext\u0007\u0000 \tend \n ' });
    expect(r.success && r.data.message).toBe('first line\n\n  indented\nnext \tend');
  });

  it('takes an empty or all-space email as none, and trims one', () => {
    for (const email of ['', '   ']) expect(parse({ ...ok, email })).toMatchObject({ success: true, data: { email: undefined } });
    expect(parse({ ...ok, email: ' jo@example.com ' })).toMatchObject({ success: true, data: { email: 'jo@example.com' } });
  });

  it('puts the details on one line', () => {
    expect(parse({ ...ok, details: ' cubr v1.6.9\n·\u0000 Chrome  ' })).toMatchObject({ success: true, data: { details: 'cubr v1.6.9 · Chrome' } });
    expect(parse({ ...ok, details: '' })).toMatchObject({ success: true, data: { details: undefined } });
  });

  it('refuses no message, a blank one or one too long, an unknown type, a bad email and other fields', () => {
    const { message, ...noMessage } = ok;
    expect(message).toBeTruthy();
    expect(parse(noMessage).success).toBe(false);
    expect(parse({ ...ok, message: ' \n\t ' }).success).toBe(false);
    expect(parse({ ...ok, message: 'x'.repeat(FEEDBACK_LIMITS.message) }).success).toBe(true);
    expect(parse({ ...ok, message: 'x'.repeat(FEEDBACK_LIMITS.message + 1) }).success).toBe(false);
    expect(parse({ ...ok, kind: 'praise' }).success).toBe(false);
    for (const email of ['jo', 'jo@', 'jo @example.com', `${'j'.repeat(250)}@example.com`]) expect(parse({ ...ok, email }).success, email).toBe(false);
    expect(parse({ ...ok, details: 'x'.repeat(301) }).success).toBe(false);
    expect(parse({ ...ok, userId: 'someone' }).success).toBe(false);
    expect(parse(null).success).toBe(false);
  });
});

describe('the subject line', () => {
  it('starts with the first line that has words in it, its spaces collapsed', () => {
    expect(firstLine('\n  \n  the   timer\tstops \nsecond line')).toBe('the timer stops');
  });
  it('is cut to 60 characters, never through an emoji', () => {
    expect(firstLine('x'.repeat(60))).toBe('x'.repeat(60));
    expect(firstLine('x'.repeat(61))).toBe(`${'x'.repeat(59)}…`);
    const cut = firstLine('🧊'.repeat(61));
    expect(cut).toBe(`${'🧊'.repeat(59)}…`);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no half emoji
  });
});

describe('the email to cubr', () => {
  it('names the type and starts the message in the subject', () => {
    expect(feedbackEmail({ kind: 'bug', message: 'the timer stops\nat 10 s' }).subject).toBe('cubr feedback (bug): the timer stops');
    expect(feedbackEmail({ kind: 'account', message: 'locked out' }).subject).toBe('cubr feedback (account help): locked out');
  });

  it('has the message as written, then the type, where a reply goes and the details', () => {
    const { text } = feedbackEmail({ kind: 'idea', message: 'two\n\n  things', email: 'jo@example.com', details: 'cubr v1.6.9 · /daily' });
    expect(text).toBe('two\n\n  things\n\n-- \ntype: idea\nreply to: jo@example.com\nsent from: cubr v1.6.9 · /daily');
    const anonymous = feedbackEmail({ kind: 'other', message: 'hi' }).text;
    expect(anonymous).toContain('reply to: no email given');
    expect(anonymous).toContain('sent from: unknown');
  });

  it("escapes everything the sender wrote in the HTML, and keeps the message's line breaks and spacing", () => {
    const { html } = feedbackEmail({ kind: 'bug', message: '<img src=x onerror=alert(1)>\n  at "x" & y', email: 'a"b@example.com', details: '<b>' });
    expect(html).toContain('<span style="white-space:pre-wrap">&lt;img src=x onerror=alert(1)&gt;\n  at &quot;x&quot; &amp; y</span>');
    expect(html).toContain('reply to: a&quot;b@example.com');
    expect(html).toContain('sent from: &lt;b&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('<title>cubr feedback (bug): &lt;img src=x onerror=alert(1)&gt;</title>');
  });
});

describe('the web app offers the same', () => {
  // web/src/lib/feedbackForm.ts: one { value, label, prompt } per kind, and FEEDBACK_MAX
  const src = readFileSync(new URL('../../../web/src/lib/feedbackForm.ts', import.meta.url), 'utf8');

  it('types, named as the email names them', () => {
    const offered = [...src.matchAll(/\{ value: '(\w+)', label: '([^']+)'/g)].map(([, value, label]) => [value, label]);
    expect(offered).toEqual(FEEDBACK_KINDS.map((k) => [k, FEEDBACK_KIND_NAMES[k]]));
  });
  it('longest message', () => {
    expect(src).toContain(`export const FEEDBACK_MAX = ${FEEDBACK_LIMITS.message};`);
  });
});
