// What POST /api/feedback sends, refuses and logs: one email to cubr's inbox, answered to the sender, and
// no log line that ties a message to the visitor (no request lines, no address, no message or email). A
// bare Fastify app with a capturing logger, sendMail stubbed, and an in-memory stand-in for Redis's rate
// limits; the real stack is in api.integration.test.ts.
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { replyWithError } from '@cubr/common';
import type { Mail } from '../src/mail.js';
import type { Deps } from '../src/routes/index.js';
import { registerFeedbackRoutes } from '../src/routes/feedback.js';

/** what the route asked sendMail to send; `fail` makes it throw, as when Resend refuses */
const outbox = vi.hoisted(() => ({ mails: [] as Mail[], fail: false }));
vi.mock('../src/mail.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/mail.js')>();
  return {
    ...real,
    sendMail: async (_cfg: unknown, mail: Mail) => {
      if (outbox.fail) throw new Error('Resend answered 500: oops');
      outbox.mails.push(mail);
    },
  };
});

/** Just enough of ioredis for the limits: MULTI INCRBY EXPIRE EXEC, counted in memory; `down` fails every command. */
function fakeRedis() {
  const counts = new Map<string, number>();
  const redis = {
    counts,
    down: false,
    multi() {
      let key = '';
      let by = 0;
      const chain = {
        incrby(k: string, n: number) {
          key = k;
          by = n;
          return chain;
        },
        expire() {
          return chain;
        },
        async exec() {
          if (redis.down) throw new Error('Connection is closed.');
          counts.set(key, (counts.get(key) ?? 0) + by);
          return [[null, counts.get(key)]];
        },
      };
      return chain;
    },
  };
  return redis;
}

async function app() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      done();
    },
  });
  const redis = fakeRedis();
  const a = Fastify({ logger: { level: 'info', stream }, trustProxy: true });
  // every service's error handler (Fastify's own logs a 5xx with the request, address and all)
  a.setErrorHandler(replyWithError);
  await registerFeedbackRoutes(a, { config: { logLevel: 'info' }, redis } as unknown as Deps);
  await a.ready();
  return { a, lines, redis };
}

const IP = '203.0.113.77';
const feedback = { kind: 'bug', message: 'the timer stops at 10 seconds\nevery time', email: 'jo@example.com', details: 'cubr v1.6.9 · Chrome 142 on macOS · 1280×800 · /daily' };
const post = (a: Awaited<ReturnType<typeof app>>['a'], payload: unknown = feedback, ip = IP) =>
  a.inject({ method: 'POST', url: '/api/feedback', payload: payload as object, headers: { 'x-forwarded-for': ip } });

beforeEach(() => {
  outbox.mails = [];
  outbox.fail = false;
});

describe('POST /api/feedback', () => {
  it("emails the message to cubr's inbox, a reply going to the sender", async () => {
    const { a } = await app();
    const res = await post(a);
    expect(res.statusCode, res.body).toBe(204);
    expect(outbox.mails).toHaveLength(1);
    expect(outbox.mails[0]).toMatchObject({ to: 'hello@cubr.dev', replyTo: 'jo@example.com', subject: 'cubr feedback (bug): the timer stops at 10 seconds' });
    expect(outbox.mails[0].text).toContain('the timer stops at 10 seconds\nevery time');
    expect(outbox.mails[0].text).toContain('sent from: cubr v1.6.9 · Chrome 142 on macOS · 1280×800 · /daily');
    await a.close();
  });

  it("without an email, a reply goes to the inbox's usual address (no reply-to of its own)", async () => {
    const { a } = await app();
    expect((await post(a, { ...feedback, email: '' })).statusCode).toBe(204);
    expect(outbox.mails[0].replyTo).toBeUndefined();
    expect(outbox.mails[0].text).toContain('reply to: no email given');
    await a.close();
  });

  it('logs one line, with the type only: no request lines, no address, no message and no email', async () => {
    const { a, lines } = await app();
    expect((await post(a)).statusCode).toBe(204);
    expect(lines).toEqual([expect.objectContaining({ level: 30, msg: 'feedback sent', kind: 'bug', replyTo: true })]);
    const logged = JSON.stringify(lines);
    for (const secret of [IP, 'the timer stops', 'jo@example.com', 'incoming request']) expect(logged).not.toContain(secret);
    await a.close();
  });

  it('refuses a missing or blank message, an unknown type, a bad email and other fields, and sends nothing', async () => {
    const { a, lines } = await app();
    const bodies = [{ ...feedback, message: '  ' }, { kind: 'bug' }, { ...feedback, kind: 'praise' }, { ...feedback, email: 'jo@' }, { ...feedback, username: 'jo' }];
    for (const [i, body] of bodies.entries()) {
      // each from its own address: refused ones count toward the limit too
      expect((await post(a, body, `198.51.100.${i + 1}`)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(outbox.mails).toHaveLength(0);
    expect(lines).toHaveLength(0);
    await a.close();
  });

  it('refuses a body over 32 KB', async () => {
    const { a } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/feedback', payload: { ...feedback, message: 'x'.repeat(33 * 1024) }, headers: { 'x-forwarded-for': IP } });
    expect(res.statusCode).toBe(413);
    expect(outbox.mails).toHaveLength(0);
    await a.close();
  });

  it('stops one address after 3 in 10 minutes, and after 10 in a day', async () => {
    const { a, redis } = await app();
    for (let i = 0; i < 3; i++) expect((await post(a)).statusCode).toBe(204);
    expect((await post(a)).statusCode).toBe(429);
    // another address still gets through
    expect((await post(a, feedback, '198.51.100.9')).statusCode).toBe(204);
    // the 10 minutes pass, three at a time, until the day's 10 are used
    let sent = 3;
    while (sent < 10) {
      redis.counts.delete(`rl:feedback:${IP}`);
      for (let i = 0; i < 3 && sent < 10; i++, sent++) expect((await post(a)).statusCode).toBe(204);
    }
    redis.counts.delete(`rl:feedback:${IP}`);
    expect((await post(a)).statusCode).toBe(429);
    expect(outbox.mails).toHaveLength(11);
    await a.close();
  });

  it("past 25 a day from everyone together, says it can't send (503) and sends nothing more", async () => {
    const { a, lines } = await app();
    for (let i = 0; i < 25; i++) expect((await post(a, feedback, `10.0.${Math.floor(i / 3)}.${(i % 3) + 1}`)).statusCode).toBe(204);
    const res = await post(a, feedback, '10.9.9.9');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: 'UNAVAILABLE', message: "Feedback can't be sent right now" } });
    expect(outbox.mails).toHaveLength(25);
    expect(lines.at(-1)).toMatchObject({ level: 40, msg: 'feedback: not sent, past the daily cap or Redis is unavailable' });
    await a.close();
  });

  it("says it can't send (503) when the email fails, logging the failure without the message", async () => {
    const { a, lines } = await app();
    outbox.fail = true;
    expect((await post(a)).statusCode).toBe(503);
    expect(lines).toEqual([expect.objectContaining({ level: 50, msg: 'feedback: the email failed', err: 'Resend answered 500: oops' })]);
    expect(JSON.stringify(lines)).not.toContain('the timer stops');
    await a.close();
  });

  it("sends nothing while Redis is down (503): the daily cap can't be counted", async () => {
    const { a, redis } = await app();
    redis.down = true;
    expect((await post(a)).statusCode).toBe(503);
    expect(outbox.mails).toHaveLength(0);
    redis.down = false;
    expect((await post(a)).statusCode).toBe(204);
    await a.close();
  });
});
