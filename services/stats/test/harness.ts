// Shared by the stats integration suites. A stand-in for solve-service - the source of truth the
// projector's recomputes read over HTTP - that keeps sessions and solves the way its database does
// and builds the domain events it would publish for each change; and a test server wired the way
// src/index.ts wires the real service (routes, projector, pb.updated relay).
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { currentAverage, effectiveMs, toApiValue, type Penalty } from '@cubr/cubestats';
import type { EventEnvelope } from '@cubr/common';
import { startTestServer, type TestServer } from '@cubr/testkit';
import { migrations } from '../src/migrations.js';
import { createPbRelay, type PbRelay } from '../src/outbox.js';
import { createProjector } from '../src/projector.js';
import { registerRoutes } from '../src/routes/index.js';

export interface Cuber {
  id: string;
  username: string;
  /** the IANA timezone the web client sends; solve-service copies it into events as `tz` */
  tz: string;
}

export interface FakeSession {
  id: string;
  userId: string;
  event: string;
  name: string;
  practice: boolean;
}

export interface FakeSolve {
  id: string;
  userId: string;
  sessionId: string;
  event: string;
  timeMs: number;
  penalty: Penalty;
  createdAt: string;
}

/** One entry of solve-service's GET /internal/users/:id/solves. */
export interface ListedSolve {
  id: string;
  sessionId: string;
  timeMs: number;
  penalty: Penalty;
  createdAt: string;
  practice?: boolean;
}

let users = 0;

/** A user nobody has seen yet (unique id and name). */
export function newCuber(tz = 'UTC'): Cuber {
  users++;
  return { id: randomUUID(), username: `cuber_${users}_${randomUUID().slice(0, 4)}`, tz };
}

/** A stream entry as consumeEvents hands it to the projector; a fresh eventId unless `data` has one. */
export function envelope(type: string, data: Record<string, unknown>): EventEnvelope {
  return { id: '1-0', type, data: { eventId: `test-${randomUUID()}`, occurredAt: new Date().toISOString(), ...data } } as EventEnvelope;
}

/** The same domain event published again under a new eventId (an outbox replay, say). */
export function republished(evt: EventEnvelope): EventEnvelope {
  return { ...evt, data: { ...evt.data, eventId: `test-${randomUUID()}` } };
}

const iso = (t: string | Date) => new Date(t).toISOString();
/** uuid order as Postgres sorts it (byte-wise, i.e. by code point for lower-case hex) */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class FakeSolveService {
  readonly sessions = new Map<string, FakeSession>();
  readonly solves = new Map<string, FakeSolve>();
  /** every request it got: path with query, and the X-Internal-Token it carried */
  readonly requests: { path: string; token: string | undefined }[] = [];
  /** when set, every request is answered with this status (503 = solve-service down) */
  failWith: number | null = null;
  /** lets a test bend the solve list (duplicates, ...) before it is sent */
  onList: ((solves: ListedSolve[]) => ListedSolve[]) | null = null;
  url = '';
  private readonly server = createServer((req, res) => this.serve(req, res));

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Requests for a user's solve list, i.e. the recomputes the projector ran for them. */
  recomputes(userId: string): string[] {
    return this.requests.filter((r) => r.path.startsWith(`/internal/users/${userId}/solves`)).map((r) => r.path);
  }

  /** What GET /internal/users/:id/solves?event= returns: ordered by session, created_at, id. */
  list(userId: string, event: string | null): ListedSolve[] {
    return [...this.solves.values()]
      .filter((s) => s.userId === userId && (!event || s.event === event))
      .sort((a, b) => byCodePoint(a.sessionId, b.sessionId) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || byCodePoint(a.id, b.id))
      .map((s) => {
        const solve: ListedSolve = { id: s.id, sessionId: s.sessionId, timeMs: s.timeMs, penalty: s.penalty, createdAt: s.createdAt };
        return this.sessions.get(s.sessionId)?.practice ? { ...solve, practice: true } : solve;
      });
  }

  private serve(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://solve');
    const token = req.headers['x-internal-token'];
    this.requests.push({ path: `${url.pathname}${url.search}`, token: typeof token === 'string' ? token : undefined });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (this.failWith) {
      send(this.failWith, { error: { code: this.failWith === 404 ? 'NOT_FOUND' : 'UNAVAILABLE', message: 'fake solve-service failure' } });
      return;
    }
    const solves = /^\/internal\/users\/([^/]+)\/solves$/.exec(url.pathname);
    if (solves) {
      const list = this.list(decodeURIComponent(solves[1]), url.searchParams.get('event'));
      send(200, { solves: this.onList ? this.onList(list) : list });
      return;
    }
    const sessions = /^\/internal\/users\/([^/]+)\/sessions$/.exec(url.pathname);
    if (sessions) {
      const own = [...this.sessions.values()].filter((s) => s.userId === decodeURIComponent(sessions[1]));
      send(200, { sessions: own.map(({ id, name, event, practice }) => ({ id, name, event, practice })) });
      return;
    }
    send(404, { error: { code: 'NOT_FOUND', message: `no route ${url.pathname}` } });
  }

  private sessionSolves(sessionId: string): FakeSolve[] {
    return [...this.solves.values()]
      .filter((s) => s.sessionId === sessionId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || byCodePoint(a.id, b.id));
  }

  /** The session's current ao5/ao12 (ms, -1 DNF, null n/a), as solve-service puts them in events. */
  private rolling(sessionId: string) {
    const times = this.sessionSolves(sessionId).slice(-12).map(effectiveMs);
    return { ao5: toApiValue(currentAverage(times, 5)), ao12: toApiValue(currentAverage(times, 12)) };
  }

  private payload(user: Cuber, s: FakeSolve) {
    const eff = effectiveMs(s);
    return {
      userId: user.id,
      username: user.username,
      event: s.event,
      sessionId: s.sessionId,
      solveId: s.id,
      timeMs: s.timeMs,
      penalty: s.penalty,
      effectiveMs: Number.isFinite(eff) ? eff : null,
      createdAt: s.createdAt,
      tz: user.tz,
      source: 'timer',
      rolling: this.rolling(s.sessionId),
    };
  }

  // ---- writes, each returning the event solve-service publishes for it -------------------------

  session(user: Cuber, event = '333', opts: { name?: string; practice?: boolean } = {}): FakeSession {
    const session = { id: randomUUID(), userId: user.id, event, name: opts.name ?? `${event} session`, practice: opts.practice ?? false };
    this.sessions.set(session.id, session);
    return session;
  }

  /** A new solve and its solve.created event; `extra` overrides payload fields (tz, rolling, ...). */
  solve(user: Cuber, session: FakeSession, timeMs: number, at: string | Date, penalty: Penalty = 'OK', extra: Record<string, unknown> = {}) {
    const solve: FakeSolve = { id: randomUUID(), userId: user.id, sessionId: session.id, event: session.event, timeMs, penalty, createdAt: iso(at) };
    this.solves.set(solve.id, solve);
    const event = envelope('solve.created', { ...this.payload(user, solve), sessionName: session.name, practice: session.practice, ...extra });
    return { solve, event };
  }

  /** solve.updated with the solve's new values (no change = a comment-only edit). */
  update(user: Cuber, solveId: string, change: { timeMs?: number; penalty?: Penalty } = {}): EventEnvelope {
    const solve = this.solves.get(solveId)!;
    Object.assign(solve, change);
    return envelope('solve.updated', { ...this.payload(user, solve), comment: 'edited' });
  }

  delete(user: Cuber, solveId: string): EventEnvelope {
    const s = this.solves.get(solveId)!;
    this.solves.delete(solveId);
    return envelope('solve.deleted', {
      userId: user.id, username: user.username, event: s.event, sessionId: s.sessionId, solveId: s.id,
      timeMs: s.timeMs, penalty: s.penalty, createdAt: s.createdAt, tz: user.tz, source: 'timer',
    });
  }

  deleteSession(user: Cuber, sessionId: string): EventEnvelope {
    const session = this.sessions.get(sessionId)!;
    for (const s of this.sessionSolves(sessionId)) this.solves.delete(s.id);
    this.sessions.delete(sessionId);
    return envelope('session.deleted', { userId: user.id, username: user.username, sessionId, event: session.event, tz: user.tz });
  }

  rename(user: Cuber, sessionId: string, name: string): EventEnvelope {
    const session = this.sessions.get(sessionId)!;
    session.name = name;
    return envelope('session.renamed', { userId: user.id, username: user.username, sessionId, event: session.event, name });
  }

  setPractice(user: Cuber, sessionId: string, practice: boolean): EventEnvelope {
    const session = this.sessions.get(sessionId)!;
    session.practice = practice;
    return envelope('session.updated', { userId: user.id, username: user.username, sessionId, event: session.event, name: session.name, practice, tz: user.tz });
  }

  /** Moves the sources' solves into the target and deletes the sources. */
  merge(user: Cuber, targetId: string, sourceIds: string[]): EventEnvelope {
    const target = this.sessions.get(targetId)!;
    let moved = 0;
    for (const s of this.solves.values()) {
      if (sourceIds.includes(s.sessionId)) {
        s.sessionId = targetId;
        moved++;
      }
    }
    for (const id of sourceIds) this.sessions.delete(id);
    return envelope('sessions.merged', { userId: user.id, username: user.username, event: target.event, targetId, sourceIds, solves: moved, tz: user.tz });
  }

  /** solves.imported for solves already added with solve() (an import publishes no solve.created). */
  imported(user: Cuber, events: string[] | null): EventEnvelope {
    const count = [...this.solves.values()].filter((s) => s.userId === user.id).length;
    return envelope('solves.imported', { userId: user.id, username: user.username, events, count, tz: user.tz });
  }
}

export interface StatsTestServer extends TestServer {
  /** the stand-in solve-service the projector's recomputes read */
  solve: FakeSolveService;
  relay: PbRelay;
  /** the projector's handler: what the `stats` consumer group runs for each stream entry */
  handle(evt: EventEnvelope): Promise<void>;
  /** hands events to the projector one after the other, as the consumer does */
  feed(...evts: EventEnvelope[]): Promise<void>;
}

/** The stats service on a fresh database and Redis, its projector reading a fake solve-service. */
export async function startStats(): Promise<StatsTestServer> {
  const solve = await new FakeSolveService().start();
  let s: TestServer;
  try {
    s = await startTestServer({
      service: 'stats',
      infoPrefixes: ['/api/stats'],
      schemas: [{ schema: 'stats', migrations }],
      routes: ({ app, config, pool, redis, auth }) => registerRoutes(app, { pool, redis, internalToken: config.internalToken, auth }),
    });
  } catch (err) {
    await solve.close();
    throw err;
  }
  const relay = createPbRelay(s.pool, s.redis, s.app.log);
  const handle = createProjector({
    pool: s.pool,
    redis: s.redis,
    log: s.app.log,
    solveUrl: solve.url,
    internalToken: s.config.internalToken,
    flushPbOutbox: () => relay.flush(),
  });
  const closeServer = s.close;
  return Object.assign(s, {
    solve,
    relay,
    handle,
    async feed(...evts: EventEnvelope[]) {
      for (const evt of evts) await handle(evt);
    },
    async close() {
      await relay.stop();
      await closeServer();
      await solve.close();
    },
  });
}
