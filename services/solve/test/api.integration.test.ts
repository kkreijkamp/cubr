// The solve service's HTTP API against a real Postgres and Redis (@cubr/testkit): sessions, solves,
// the daily challenge, import/export, the internal routes, the outbox relay and the purge of a
// deleted account. Every write must stay inside its owner's account.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope, Redis } from '@cubr/common';
import { describeIntegration, startTestServer, type TestServer } from '@cubr/testkit';
import { migrations } from '../src/migrations.js';
import { startOutboxRelay } from '../src/outbox.js';
import { makeUserPurge } from '../src/purge.js';
import { registerRoutes } from '../src/routes/index.js';
import { utcDay } from '../src/schemas.js';

interface User {
  id: string;
  username: string;
  token: string;
}
interface Session {
  id: string;
  name: string;
  event: string;
  practice?: boolean;
  solveCount: number;
}

describeIntegration('solve API', () => {
  let s: TestServer;
  let n = 0;

  beforeAll(async () => {
    s = await startTestServer({
      service: 'solve',
      infoPrefixes: ['/api/solves', '/api/sessions'],
      schemas: [{ schema: 'solve', migrations }],
      bodyLimit: 30 * 1024 * 1024,
      routes: ({ app, config, pool, redis, auth }) => registerRoutes(app, { config, pool, redis, auth }),
    });
  });
  afterAll(async () => {
    await s?.close();
  });

  async function newUser(): Promise<User> {
    const user = { id: randomUUID(), username: `solver_${++n}` };
    return { ...user, token: await s.token(user) };
  }
  const as = (u: User) => ({
    get: (url: string) => s.request('GET', url, { token: u.token }),
    post: (url: string, body?: unknown) => s.request('POST', url, { token: u.token, body: body ?? {} }),
    patch: (url: string, body: unknown) => s.request('PATCH', url, { token: u.token, body }),
    del: (url: string) => s.request('DELETE', url, { token: u.token }),
  });
  async function newSession(u: User, over: Partial<{ id: string; name: string; event: string; practice: boolean }> = {}): Promise<Session> {
    const res = await as(u).post('/api/sessions', { name: `session ${++n}`, event: '333', ...over });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().session;
  }
  async function addSolve(u: User, sessionId: string, timeMs: number, over: Record<string, unknown> = {}) {
    const res = await as(u).post('/api/solves', { id: randomUUID(), sessionId, timeMs, scramble: "R U R' U'", ...over });
    expect([200, 201], res.body).toContain(res.statusCode);
    return res.json() as {
      solve: { id: string; timeMs: number; penalty: string; event: string; sessionId: string; createdAt: string };
      rolling: { ao5: number | null; ao12: number | null };
    };
  }
  /** Events written to the outbox (the relay isn't running here), oldest first. */
  async function outbox(type?: string, userId?: string) {
    const { rows } = await s.pool.query<{ type: string; payload: Record<string, unknown> }>('SELECT type, payload FROM solve.outbox ORDER BY id');
    return rows.filter((r) => (!type || r.type === type) && (!userId || r.payload.userId === userId));
  }
  const solveCount = async (sessionId: string) =>
    Number((await s.pool.query('SELECT count(*) FROM solve.solves WHERE session_id = $1', [sessionId])).rows[0].count);

  it('answers 401 to every route without a token', async () => {
    const id = randomUUID();
    for (const [method, url] of [
      ['GET', '/api/sessions'],
      ['POST', '/api/sessions'],
      ['PATCH', `/api/sessions/${id}`],
      ['DELETE', `/api/sessions/${id}`],
      ['POST', `/api/sessions/${id}/merge`],
      ['GET', `/api/sessions/${id}/solves`],
      ['POST', '/api/solves'],
      ['PATCH', `/api/solves/${id}`],
      ['DELETE', `/api/solves/${id}`],
      ['GET', '/api/solves/daily'],
      ['POST', '/api/sessions/import'],
      ['GET', '/api/solves/export'],
    ] as const) {
      expect((await s.request(method, url, { body: method === 'GET' || method === 'DELETE' ? undefined : {} })).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  describe('sessions', () => {
    it('gives a new account "3x3" and then "3x3 practice", once, even when asked concurrently', async () => {
      const u = await newUser();
      const all = await Promise.all(Array.from({ length: 5 }, () => as(u).get('/api/sessions')));
      for (const r of all) expect(r.statusCode).toBe(200);
      const sessions: Session[] = (await as(u).get('/api/sessions')).json().sessions;
      expect(sessions.map((x) => [x.name, x.event, !!x.practice])).toEqual([
        ['3x3', '333', false],
        ['3x3 practice', '333', true],
      ]);
    });

    it('creates a session idempotently on its id, and refuses an id that belongs to someone else', async () => {
      const [u, other] = [await newUser(), await newUser()];
      const id = randomUUID();
      const first = await as(u).post('/api/sessions', { id, name: 'OH', event: '333oh' });
      expect(first.statusCode).toBe(201);
      const retry = await as(u).post('/api/sessions', { id, name: 'OH', event: '333oh' });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().session).toMatchObject({ id, name: 'OH', event: '333oh' });
      expect((await s.pool.query('SELECT count(*) FROM solve.sessions WHERE id = $1', [id])).rows[0].count).toBe(1);
      const stolen = await as(other).post('/api/sessions', { id, name: 'mine now', event: '333' });
      expect(stolen.statusCode).toBe(409);
    });

    it.each([
      ['an unknown event', { name: 'x', event: '333mbf' }],
      ['an empty name', { name: '', event: '333' }],
      ['a 41-character name', { name: 'x'.repeat(41), event: '333' }],
      ['a malformed id', { id: 'not-a-uuid', name: 'x', event: '333' }],
    ])('answers 400 to %s', async (_what, body) => {
      expect((await as(await newUser()).post('/api/sessions', body)).statusCode).toBe(400);
    });

    it("keeps a practice scramble's session a practice session, and its solves off the PBs and boards", async () => {
      const u = await newUser();
      const res = await as(u).post('/api/sessions', { name: '3x3 pll', event: '333', scramble: 'pll' });
      expect(res.statusCode).toBe(201);
      const sess = res.json().session;
      expect(sess).toMatchObject({ event: '333', scramble: 'pll', practice: true });
      expect((await as(u).patch(`/api/sessions/${sess.id}`, { practice: false })).statusCode).toBe(400);
      expect((await as(u).post('/api/sessions', { name: 'x', event: '333', scramble: '333' })).statusCode).toBe(400);
      const listed = (await as(u).get('/api/sessions')).json().sessions.find((x: Session) => x.id === sess.id);
      expect(listed).toMatchObject({ scramble: 'pll', practice: true });
      // a solve in it is published as a practice solve (stats: no PB; leaderboard: no board)
      await addSolve(u, sess.id, 1840);
      const [created] = await outbox('solve.created', u.id);
      expect(created.payload.practice).toBe(true);
    });

    it('merges only sessions of the same scramble type', async () => {
      const u = await newUser();
      const plain = await newSession(u);
      const pll = (await as(u).post('/api/sessions', { name: '3x3 pll', event: '333', scramble: 'pll' })).json().session;
      expect((await as(u).post(`/api/sessions/${plain.id}/merge`, { sourceIds: [pll.id] })).statusCode).toBe(409);
    });

    it('renames (session.renamed) and marks practice (session.updated only when it changes)', async () => {
      const u = await newUser();
      const sess = await newSession(u);
      const renamed = await as(u).patch(`/api/sessions/${sess.id}`, { name: 'comp sim' });
      expect(renamed.json().session.name).toBe('comp sim');
      await as(u).patch(`/api/sessions/${sess.id}`, { practice: true });
      await as(u).patch(`/api/sessions/${sess.id}`, { practice: true }); // no change
      await as(u).patch(`/api/sessions/${sess.id}`, { practice: false });
      expect((await outbox('session.renamed', u.id)).map((e) => e.payload.name)).toEqual(['comp sim']);
      expect((await outbox('session.updated', u.id)).map((e) => e.payload.practice)).toEqual([true, false]);
      expect((await as(u).patch(`/api/sessions/${sess.id}`, {})).statusCode).toBe(400);
    });

    it('deletes a session with its solves (session.deleted)', async () => {
      const u = await newUser();
      const sess = await newSession(u);
      await addSolve(u, sess.id, 11_000);
      expect((await as(u).del(`/api/sessions/${sess.id}`)).statusCode).toBe(204);
      expect(await solveCount(sess.id)).toBe(0);
      expect((await outbox('session.deleted', u.id)).at(-1)?.payload).toMatchObject({ sessionId: sess.id, event: '333' });
      expect((await as(u).del(`/api/sessions/${sess.id}`)).statusCode).toBe(404);
    });

    it("lists a session's solves oldest first", async () => {
      const u = await newUser();
      const sess = await newSession(u);
      const t0 = Date.now() - 60_000;
      for (const [i, ms] of [12_000, 10_000, 11_000].entries()) await addSolve(u, sess.id, ms, { createdAt: new Date(t0 + i * 1000).toISOString() });
      const res = (await as(u).get(`/api/sessions/${sess.id}/solves`)).json();
      expect(res.truncated).toBe(false);
      expect(res.solves.map((x: { timeMs: number }) => x.timeMs)).toEqual([12_000, 10_000, 11_000]);
    });
  });

  describe('merging sessions', () => {
    it("moves every solve into the target, deletes the sources and keeps the target's practice flag", async () => {
      const u = await newUser();
      const target = await newSession(u, { practice: true });
      const a = await newSession(u);
      const b = await newSession(u);
      await addSolve(u, target.id, 10_000);
      await addSolve(u, a.id, 11_000);
      await addSolve(u, a.id, 12_000);
      await addSolve(u, b.id, 13_000);
      const res = await as(u).post(`/api/sessions/${target.id}/merge`, { sourceIds: [a.id, b.id.toUpperCase()] });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ session: { id: target.id, practice: true, solveCount: 4 }, merged: { sessions: 2, solves: 3 } });
      expect((await s.pool.query('SELECT count(*) FROM solve.sessions WHERE id = ANY($1::uuid[])', [[a.id, b.id]])).rows[0].count).toBe(0);
      expect((await outbox('sessions.merged', u.id)).at(-1)?.payload).toMatchObject({ targetId: target.id, solves: 3, event: '333' });
    });

    it('refuses other events, the target itself, duplicates and sessions it cannot see, changing nothing', async () => {
      const [u, other] = [await newUser(), await newUser()];
      const target = await newSession(u);
      const oh = await newSession(u, { event: '333oh' });
      const theirs = await newSession(other);
      await addSolve(other, theirs.id, 9_000);
      const merge = (sourceIds: string[]) => as(u).post(`/api/sessions/${target.id}/merge`, { sourceIds });
      expect((await merge([oh.id])).statusCode).toBe(409);
      expect((await merge([target.id])).statusCode).toBe(400);
      expect((await merge([oh.id, oh.id])).statusCode).toBe(400);
      expect((await merge([theirs.id])).statusCode).toBe(404);
      expect((await as(other).post(`/api/sessions/${theirs.id}/merge`, { sourceIds: [target.id] })).statusCode).toBe(404);
      expect(await solveCount(theirs.id)).toBe(1);
      expect((await s.pool.query('SELECT count(*) FROM solve.sessions WHERE user_id = $1', [u.id])).rows[0].count).toBe(2);
    });
  });

  describe('solves', () => {
    it("creates a solve in its session's event, with the rolling ao5 and ao12", async () => {
      const u = await newUser();
      const sess = await newSession(u, { event: '222' });
      let last;
      for (const ms of [3000, 4000, 5000, 6000, 7000]) last = await addSolve(u, sess.id, ms);
      expect(last!.solve).toMatchObject({ event: '222', penalty: 'OK', sessionId: sess.id });
      expect(last!.rolling).toEqual({ ao5: 5000, ao12: null });
      const created = await outbox('solve.created', u.id);
      expect(created).toHaveLength(5);
      expect(created.at(-1)?.payload).toMatchObject({ event: '222', sessionName: sess.name, practice: false, rolling: { ao5: 5000 } });
    });

    it("gives a back-dated solve the ao5 ending at it, not the session's latest, so its day's board gets its own", async () => {
      const u = await newUser();
      const sess = await newSession(u);
      const at = (min: number) => new Date(Date.now() - (60 - min) * 60_000).toISOString();
      for (const [i, ms] of [10_000, 11_000, 12_000, 13_000, 14_000].entries()) await addSolve(u, sess.id, ms, { createdAt: at(i + 10) });
      for (const [i, ms] of [20_000, 21_000, 22_000, 23_000, 24_000].entries()) await addSolve(u, sess.id, ms, { createdAt: at(i + 30) });
      const back = await addSolve(u, sess.id, 9_000, { createdAt: at(15) }); // entered later, solved between the two runs
      expect(back.rolling.ao5).toBe(12_000); // 10-14 s and itself: the window ending at it (the session's latest is 22 s)
      const created = await outbox('solve.created', u.id);
      expect(created.at(-1)?.payload).toMatchObject({ rolling: { ao5: 12_000 } });
      const newest = await addSolve(u, sess.id, 25_000);
      expect(newest.rolling.ao5).toBe(23_000); // the newest solve: the session's current ao5, as before
    });

    it('takes a retry of the same id once (one row, one event) and refuses an id that someone else used', async () => {
      const [u, other] = [await newUser(), await newUser()];
      const sess = await newSession(u);
      const id = randomUUID();
      const body = { id, sessionId: sess.id, timeMs: 9_876 };
      const results = await Promise.all([as(u).post('/api/solves', body), as(u).post('/api/solves', body), as(u).post('/api/solves', body)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
      expect(await solveCount(sess.id)).toBe(1);
      expect((await outbox('solve.created', u.id)).filter((e) => e.payload.solveId === id)).toHaveLength(1);
      const theirSession = await newSession(other);
      expect((await as(other).post('/api/solves', { id, sessionId: theirSession.id, timeMs: 1 })).statusCode).toBe(409);
    });

    it('marks solves in a practice session as practice for the other services', async () => {
      const u = await newUser();
      const sess = await newSession(u, { practice: true });
      const { solve } = await addSolve(u, sess.id, 8_000);
      expect((await outbox('solve.created', u.id)).find((e) => e.payload.solveId === solve.id)?.payload.practice).toBe(true);
    });

    it.each([
      ['a zero time', { timeMs: 0 }],
      ['more than 24 hours', { timeMs: 86_400_001 }],
      ['a fractional time', { timeMs: 1.5 }],
      ['an unknown penalty', { timeMs: 1000, penalty: '+4' }],
      ['a 501-character comment', { timeMs: 1000, comment: 'x'.repeat(501) }],
      ['a malformed date', { timeMs: 1000, createdAt: 'yesterday' }],
    ])('answers 400 to %s', async (_what, body) => {
      const u = await newUser();
      const sess = await newSession(u);
      expect((await as(u).post('/api/solves', { sessionId: sess.id, ...body })).statusCode).toBe(400);
    });

    it('clamps a creation time from a fast clock to now instead of losing the solve', async () => {
      const u = await newUser();
      const sess = await newSession(u);
      const { solve } = await addSolve(u, sess.id, 1000, { createdAt: new Date(Date.now() + 86_400_000).toISOString() });
      expect(Math.abs(Date.parse(solve.createdAt) - Date.now())).toBeLessThan(60_000);
    });

    it('changes a penalty and comment (solve.updated), and ignores an edit that changes nothing', async () => {
      const u = await newUser();
      const sess = await newSession(u);
      const { solve } = await addSolve(u, sess.id, 10_000);
      const res = await as(u).patch(`/api/solves/${solve.id}`, { penalty: '+2', comment: 'pop' });
      expect(res.json().solve).toMatchObject({ penalty: '+2', comment: 'pop' });
      await as(u).patch(`/api/solves/${solve.id}`, { penalty: '+2' }); // no-op
      expect((await outbox('solve.updated', u.id)).filter((e) => e.payload.solveId === solve.id)).toHaveLength(1);
      expect((await as(u).patch(`/api/solves/${solve.id}`, {})).statusCode).toBe(400);
    });

    it('deletes a solve (solve.deleted)', async () => {
      const u = await newUser();
      const sess = await newSession(u);
      const { solve } = await addSolve(u, sess.id, 10_000);
      expect((await as(u).del(`/api/solves/${solve.id}`)).statusCode).toBe(204);
      expect((await outbox('solve.deleted', u.id)).some((e) => e.payload.solveId === solve.id)).toBe(true);
      expect((await as(u).del(`/api/solves/${solve.id}`)).statusCode).toBe(404);
    });
  });

  describe("someone else's data", () => {
    it('cannot be read, changed, deleted or written into', async () => {
      const [owner, intruder] = [await newUser(), await newUser()];
      const sess = await newSession(owner);
      const { solve } = await addSolve(owner, sess.id, 10_000);
      const bad = as(intruder);
      expect((await bad.get(`/api/sessions/${sess.id}/solves`)).statusCode).toBe(404);
      expect((await bad.patch(`/api/sessions/${sess.id}`, { name: 'pwned' })).statusCode).toBe(404);
      expect((await bad.del(`/api/sessions/${sess.id}`)).statusCode).toBe(404);
      expect((await bad.patch(`/api/solves/${solve.id}`, { penalty: 'DNF' })).statusCode).toBe(404);
      expect((await bad.del(`/api/solves/${solve.id}`)).statusCode).toBe(404);
      expect((await bad.post('/api/solves', { sessionId: sess.id, timeMs: 1 })).statusCode).toBe(404);
      expect((await bad.get('/api/sessions')).json().sessions.map((x: Session) => x.id)).not.toContain(sess.id);
      const after = (await as(owner).get(`/api/sessions/${sess.id}/solves`)).json().solves;
      expect(after).toEqual([expect.objectContaining({ id: solve.id, penalty: 'OK' })]);
      expect((await as(owner).get('/api/sessions')).json().sessions.find((x: Session) => x.id === sess.id)?.name).toBe(sess.name);
    });
  });

  describe('daily challenge', () => {
    const today = () => utcDay(Date.now());
    async function attempt(u: User, sessionId: string, index: number, timeMs: number, id = randomUUID(), date = today()) {
      return as(u).post('/api/solves', { id, sessionId, timeMs, daily: { date, index } });
    }

    it('records five attempts, then the official ao5 once (daily.completed)', async () => {
      const u = await newUser();
      const sess = await newSession(u);
      for (const [i, ms] of [10_000, 12_000, 11_000, 9_000, 13_000].entries()) expect((await attempt(u, sess.id, i, ms)).statusCode).toBe(201);
      const done = await outbox('daily.completed', u.id);
      expect(done).toHaveLength(1);
      expect(done[0].payload).toMatchObject({ date: today(), event: '333', ao5: 11_000 });
      const overview = (await as(u).get('/api/solves/daily')).json();
      expect(overview.date).toBe(today());
      expect(overview.events['333'].ao5).toBe(11_000);
      expect(overview.events['333'].solves.map((x: { timeMs: number }) => x.timeMs)).toEqual([10_000, 12_000, 11_000, 9_000, 13_000]);
    });

    it('keeps an attempt used: another solve for it is refused, even after the first one is deleted', async () => {
      const u = await newUser();
      const sess = await newSession(u);
      const id = randomUUID();
      expect((await attempt(u, sess.id, 0, 10_000, id)).statusCode).toBe(201);
      expect((await attempt(u, sess.id, 0, 10_000, id)).statusCode).toBe(200); // a retry is fine
      expect((await attempt(u, sess.id, 0, 8_000)).statusCode).toBe(409);
      await as(u).del(`/api/solves/${id}`);
      expect((await attempt(u, sess.id, 0, 8_000)).statusCode).toBe(409);
      // the overview still lists the attempt, so the page shows its slot as used (not a 409 loop)
      const overview = (await as(u).get('/api/solves/daily')).json();
      expect(overview.events['333']).toMatchObject({ solves: [], attempts: [{ index: 0, timeMs: 10_000, penalty: 'OK', solveId: id }] });
    });

    it("records when an attempt starts, and makes a second start of it a DNF (the October review's #18)", async () => {
      const u = await newUser();
      const sess = await newSession(u);
      const start = (index: number, event = '333', date = today()) => as(u).post('/api/solves/daily/start', { date, event, index });
      expect((await start(0)).statusCode).toBe(201);
      // a reload, a closed tab or a second try: the same index again
      const again = await start(0);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ abandoned: true, attempt: { index: 0, penalty: 'DNF' } });
      expect(again.json().attempt.timeMs).toBeGreaterThanOrEqual(1);
      expect((await attempt(u, sess.id, 0, 8_000)).statusCode).toBe(409); // its result can't come after all
      const overview = (await as(u).get('/api/solves/daily')).json();
      expect(overview.events['333'].attempts).toEqual([expect.objectContaining({ index: 0, penalty: 'DNF' })]);
      // a finished attempt can't be started again
      expect((await start(1)).statusCode).toBe(201);
      expect((await attempt(u, sess.id, 1, 9_000)).statusCode).toBe(201);
      expect((await start(1)).statusCode).toBe(409);
    });

    it('completes the day when the fifth attempt is a DNF from a second start', async () => {
      const u = await newUser();
      const sess = await newSession(u);
      for (const [i, ms] of [10_000, 12_000, 11_000, 9_000].entries()) expect((await attempt(u, sess.id, i, ms)).statusCode).toBe(201);
      const start = () => as(u).post('/api/solves/daily/start', { date: today(), event: '333', index: 4 });
      expect((await start()).statusCode).toBe(201);
      expect((await start()).statusCode).toBe(200);
      const done = await outbox('daily.completed', u.id);
      expect(done).toHaveLength(1);
      expect(done[0].payload).toMatchObject({ event: '333', ao5: 11_000 }); // 9, 10, 11, 12, DNF: 9 and the DNF trimmed
    });

    it('refuses starts for a closed day, a non-daily event, an index out of range, or without signing in', async () => {
      const u = await newUser();
      const start = (body: Record<string, unknown>) => as(u).post('/api/solves/daily/start', { date: today(), event: '333', index: 0, ...body });
      expect((await start({ date: utcDay(Date.now(), -3) })).statusCode).toBe(400);
      expect((await start({ event: '333fm' })).statusCode).toBe(400);
      expect((await start({ index: 5 })).statusCode).toBe(400);
      expect((await s.app.inject({ method: 'POST', url: '/api/solves/daily/start', payload: { date: today(), event: '333', index: 0 } })).statusCode).toBe(401);
    });

    it('is open only while the day is today somewhere, and only for the daily events', async () => {
      const u = await newUser();
      const sess = await newSession(u);
      const old = utcDay(Date.now(), -3);
      expect((await attempt(u, sess.id, 0, 10_000, randomUUID(), old)).statusCode).toBe(400);
      expect((await attempt(u, sess.id, 0, 10_000, randomUUID(), utcDay(Date.now(), 1))).statusCode).toBe(201);
      const fmc = await newSession(u, { event: '333fm' });
      expect((await attempt(u, fmc.id, 0, 30_000)).statusCode).toBe(400);
      expect((await attempt(u, sess.id, 5, 10_000)).statusCode).toBe(400);
    });

    it('moves the official result with a penalty while the day is open (daily.updated)', async () => {
      const u = await newUser();
      const sess = await newSession(u);
      const ids: string[] = [];
      for (const [i, ms] of [10_000, 10_000, 10_000, 10_000, 10_000].entries()) {
        const id = randomUUID();
        ids.push(id);
        await attempt(u, sess.id, i, ms, id);
      }
      await as(u).patch(`/api/solves/${ids[2]}`, { penalty: 'DNF' });
      await as(u).patch(`/api/solves/${ids[3]}`, { penalty: 'DNF' });
      const { rows } = await s.pool.query('SELECT daily_index, penalty FROM solve.daily_attempts WHERE user_id = $1 ORDER BY daily_index', [u.id]);
      expect(rows.map((r) => r.penalty)).toEqual(['OK', 'OK', 'DNF', 'DNF', 'OK']);
      // events carry a DNF average as -1 (docs/SPEC.md 8): one DNF is trimmed, two make the ao5 a DNF
      expect((await outbox('daily.updated', u.id)).map((e) => e.payload.ao5)).toEqual([10_000, -1]);
    });
  });

  describe('import and export', () => {
    it('imports sessions with their solves in one go and exports them back', async () => {
      const u = await newUser();
      const body = {
        sessions: [
          {
            name: 'imported 3x3',
            event: '333',
            solves: [
              { timeMs: 9_000, createdAt: '2026-01-01T10:00:00Z' },
              { timeMs: 10_000, penalty: '+2', createdAt: '2026-01-01T10:01:00Z' },
            ],
          },
          {
            name: 'imported practice',
            event: '222',
            practice: true,
            solves: [{ timeMs: 3_000, penalty: 'DNF', comment: 'pop', createdAt: '2026-01-02T10:00:00Z' }],
          },
        ],
      };
      const res = await as(u).post('/api/sessions/import', body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ imported: { sessions: 2, solves: 3 }, skipped: 0, continued: 0 });
      const evt = await outbox('solves.imported', u.id);
      expect(evt).toHaveLength(1);
      expect(evt[0].payload).toMatchObject({ count: 3 });

      const exported = await as(u).get('/api/solves/export');
      expect(exported.statusCode).toBe(200);
      const doc = exported.json();
      const byName = new Map(doc.sessions.map((x: { name: string }) => [x.name, x]));
      expect(byName.get('imported 3x3')).toMatchObject({
        event: '333',
        solves: [
          { timeMs: 9_000, penalty: 'OK' },
          { timeMs: 10_000, penalty: '+2' },
        ],
      });
      expect(byName.get('imported practice')).toMatchObject({ event: '222', practice: true, solves: [{ timeMs: 3_000, penalty: 'DNF', comment: 'pop' }] });
    });

    it('leaves out solves the account already has: a second import adds nothing, a retry continues its session', async () => {
      const u = await newUser();
      const solve = (i: number, penalty?: string) => ({ timeMs: 9_000 + i, ...(penalty ? { penalty } : {}), createdAt: `2026-02-0${i}T10:00:00.123Z` });
      const first = { sessions: [{ name: 'csTimer 3x3', event: '333', solves: [solve(1), solve(2)] }] };
      expect((await as(u).post('/api/sessions/import', first)).json()).toEqual({ imported: { sessions: 1, solves: 2 }, skipped: 0, continued: 0 });

      // the same file again: nothing new, no second session, no event
      expect((await as(u).post('/api/sessions/import', first)).json()).toEqual({ imported: { sessions: 0, solves: 0 }, skipped: 2, continued: 0 });
      expect(await outbox('solves.imported', u.id)).toHaveLength(1);

      // a later export of the same session (two more solves), and an unrelated session with the same name
      const later = {
        sessions: [
          { name: 'csTimer 3x3', event: '333', solves: [solve(1), solve(2), solve(3), solve(4)] },
          { name: 'csTimer 3x3', event: '333', solves: [solve(5)] },
        ],
      };
      expect((await as(u).post('/api/sessions/import', later)).json()).toEqual({ imported: { sessions: 1, solves: 3 }, skipped: 2, continued: 1 });
      const doc = (await as(u).get('/api/solves/export')).json();
      const named = doc.sessions.filter((x: { name: string }) => x.name === 'csTimer 3x3');
      expect(named.map((x: { solves: unknown[] }) => x.solves.length).sort()).toEqual([1, 4]);

      // a different penalty is a different solve
      const plus2 = { sessions: [{ name: 'csTimer 3x3', event: '333', solves: [solve(1, '+2')] }] };
      expect((await as(u).post('/api/sessions/import', plus2)).json()).toMatchObject({ imported: { solves: 1 }, skipped: 0 });
    });

    it('allows 10 imports an hour per account', async () => {
      const u = await newUser();
      const body = { sessions: [{ name: 'tiny', event: '333', solves: [{ timeMs: 1000, createdAt: '2026-01-01T00:00:00Z' }] }] };
      for (let i = 0; i < 10; i++) expect((await as(u).post('/api/sessions/import', body)).statusCode).toBe(200);
      expect((await as(u).post('/api/sessions/import', body)).statusCode).toBe(429);
      expect((await as(await newUser()).post('/api/sessions/import', body)).statusCode).toBe(200);
    });
  });

  describe('internal routes', () => {
    it('need the internal token', async () => {
      const id = randomUUID();
      expect((await s.request('GET', `/internal/users/${id}/solves`)).statusCode).toBe(403);
      expect((await s.request('GET', `/internal/users/${id}/sessions`, { headers: { 'x-internal-token': 'wrong' } })).statusCode).toBe(403);
    });

    it("list a user's solves in pages that neither repeat nor skip a solve, down to the microsecond", async () => {
      const u = await newUser();
      const a = await newSession(u);
      const b = await newSession(u);
      // created_at keeps microseconds: these differ only there, the cursor must too
      for (const [session, at] of [
        [a, '2026-03-01T10:00:00.123456Z'],
        [a, '2026-03-01T10:00:00.123457Z'],
        [a, '2026-03-01T10:00:00.123458Z'],
        [b, '2026-03-01T09:00:00.000001Z'],
        [b, '2026-03-01T11:00:00Z'],
      ] as const)
        await s.pool.query(
          `INSERT INTO solve.solves (id, user_id, session_id, event, time_ms, penalty, scramble, source, created_at) VALUES ($1, $2, $3, '333', 9000, 'OK', '', 'timer', $4)`,
          [randomUUID(), u.id, session.id, at],
        );
      const headers = { 'x-internal-token': s.config.internalToken };
      const url = `/internal/users/${u.id}/solves?event=333`;
      const whole = (await s.request('GET', url, { headers })).json();
      expect(whole.solves).toHaveLength(5);
      expect(whole.next).toBeNull();
      for (const limit of [1, 2]) {
        const paged: { id: string }[] = [];
        let after: string | null = null;
        do {
          const res = await s.request('GET', `${url}&limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`, { headers });
          expect(res.statusCode, res.body).toBe(200);
          const page = res.json();
          paged.push(...page.solves);
          after = page.next;
        } while (after);
        expect(paged, `pages of ${limit}`).toEqual(whole.solves);
      }
      expect((await s.request('GET', `${url}&limit=2&after=not-a-cursor`, { headers })).statusCode).toBe(400);
    });

    it("list a user's solves (practice marked) and sessions for the stats service", async () => {
      const u = await newUser();
      const normal = await newSession(u);
      const practice = await newSession(u, { practice: true });
      const oh = await newSession(u, { event: '333oh' });
      await addSolve(u, normal.id, 10_000);
      await addSolve(u, practice.id, 9_000);
      await addSolve(u, oh.id, 20_000);
      const headers = { 'x-internal-token': s.config.internalToken };
      const solves = (await s.request('GET', `/internal/users/${u.id}/solves?event=333`, { headers })).json().solves;
      expect(solves).toHaveLength(2);
      expect(solves.find((x: { sessionId: string }) => x.sessionId === practice.id)).toMatchObject({ timeMs: 9_000, practice: true });
      expect(solves.find((x: { sessionId: string }) => x.sessionId === normal.id).practice).toBeUndefined();
      const sessions = (await s.request('GET', `/internal/users/${u.id}/sessions`, { headers })).json().sessions;
      expect(sessions.map((x: Session) => x.id)).toEqual([normal.id, practice.id, oh.id]);
    });
  });

  describe('the outbox relay', () => {
    it('publishes queued events to the stream in order, once, with stable event ids', async () => {
      const u = await newUser();
      const sess = await newSession(u);
      const { solve } = await addSolve(u, sess.id, 10_000);
      await as(u).patch(`/api/solves/${solve.id}`, { penalty: '+2' });
      await as(u).del(`/api/solves/${solve.id}`);
      const relay = startOutboxRelay({ pool: s.pool, redis: s.redis, log: s.app.log, intervalMs: 20 });
      try {
        await expect
          .poll(async () => (await s.pool.query('SELECT count(*) FROM solve.outbox WHERE published_at IS NULL')).rows[0].count, { timeout: 5000 })
          .toBe(0);
      } finally {
        await relay.stop();
      }
      const mine = (await s.events()).filter((e) => e.data.userId === u.id);
      expect(mine.map((e) => e.type)).toEqual(['solve.created', 'solve.updated', 'solve.deleted']);
      expect(mine.every((e) => /^solve-\d+$/.test(String(e.data.eventId)))).toBe(true);
      expect(new Set(mine.map((e) => e.data.eventId)).size).toBe(3);
    });

    it('is woken by the commit of new events (NOTIFY), with no polling in between', async () => {
      // polls only every minute: a solve's event can reach the stream within seconds only by the wake-up
      const relay = startOutboxRelay({ pool: s.pool, redis: s.redis, log: s.app.log, intervalMs: 60_000, idleMs: 60_000 });
      try {
        await expect.poll(async () => (await relay.info()).listening, { timeout: 5000 }).toBe(true);
        const u = await newUser();
        const sess = await newSession(u);
        await addSolve(u, sess.id, 11_111);
        await expect.poll(async () => (await s.events()).filter((e) => e.data.userId === u.id && e.type === 'solve.created').length, { timeout: 5000 }).toBe(1);
      } finally {
        await relay.stop();
      }
    });

    it('keeps events while Redis is unreachable and delivers them once it is back', async () => {
      const u = await newUser();
      const sess = await newSession(u);
      await addSolve(u, sess.id, 12_345);
      let down = true;
      // the real client, except that ping fails while "down"
      const flaky = new Proxy(s.redis, {
        get(target, prop, receiver) {
          if (prop === 'ping' && down) return () => Promise.reject(new Error('connection refused'));
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }) as Redis;
      const relay = startOutboxRelay({ pool: s.pool, redis: flaky, log: s.app.log, intervalMs: 20, maxBackoffMs: 50 });
      try {
        await expect.poll(async () => (await relay.info()).healthy, { timeout: 5000 }).toBe(false);
        expect((await relay.info()).backlog).toBeGreaterThan(0);
        down = false;
        await expect.poll(async () => (await relay.info()).backlog, { timeout: 5000 }).toBe(0);
        expect((await relay.info()).healthy).toBe(true);
      } finally {
        await relay.stop();
      }
      expect((await s.events('solve.created')).some((e) => e.data.userId === u.id && e.data.timeMs === 12_345)).toBe(true);
    });
  });

  describe('a deleted account', () => {
    it('loses its sessions, solves, daily attempts and starts, and unsent events, and nobody else does', async () => {
      const [gone, stays] = [await newUser(), await newUser()];
      for (const u of [gone, stays]) {
        const sess = await newSession(u);
        await addSolve(u, sess.id, 10_000);
        await as(u).post('/api/solves', { sessionId: sess.id, timeMs: 10_000, daily: { date: utcDay(Date.now()), index: 0 } });
        await as(u).post('/api/solves/daily/start', { date: utcDay(Date.now()), event: '333', index: 1 });
      }
      const purge = makeUserPurge({ pool: s.pool, log: s.app.log });
      const evt: EventEnvelope = {
        id: '1-0',
        type: 'user.deleted',
        data: { userId: gone.id, username: gone.username, eventId: 'auth-x', occurredAt: new Date().toISOString() },
      };
      await purge(evt);
      await purge(evt); // a redelivery finds nothing left
      const count = async (table: string, userId: string) =>
        Number((await s.pool.query(`SELECT count(*) FROM solve.${table} WHERE user_id = $1`, [userId])).rows[0].count);
      for (const table of ['sessions', 'solves', 'daily_attempts', 'daily_starts']) {
        expect(await count(table, gone.id), table).toBe(0);
        expect(await count(table, stays.id), table).toBeGreaterThan(0);
      }
      expect(await outbox(undefined, gone.id).then((rows) => rows.length)).toBe(0);
      expect(await outbox(undefined, stays.id).then((rows) => rows.length)).toBeGreaterThan(0);
    });
  });
});
