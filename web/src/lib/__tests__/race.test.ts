import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, LivePlayer, LiveRoomState } from '../race';
import { MemoryStorage } from './memoryStorage';

// RaceConnection is driven through a fake socket.io socket: the test plays the race service.
const fake = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  class FakeSocket {
    connected = false;
    handlers = new Map<string, Handler[]>();
    emitted: { event: string; payload: unknown }[] = [];
    /** the race service's answer to an emit (throw = no answer in time) */
    answer: (event: string, payload: unknown) => unknown = () => ({ ok: true });
    io = { on: (_event: string, _fn: Handler) => this.io, removeAllListeners: () => this.io };
    /** the options io() was called with (auth: the handshake) */
    opts: { auth?: (cb: (a: Record<string, unknown>) => void) => void } = {};
    on(event: string, fn: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }
    fire(event: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    connect() {
      this.connected = true;
      this.fire('connect');
      return this;
    }
    disconnect() {
      const was = this.connected;
      this.connected = false;
      if (was) this.fire('disconnect', 'io client disconnect');
      return this;
    }
    removeAllListeners() {
      this.handlers.clear();
      return this;
    }
    timeout(_ms: number) {
      return {
        emitWithAck: async (event: string, payload: unknown) => {
          this.emitted.push({ event, payload });
          return this.answer(event, payload);
        },
      };
    }
  }
  return { FakeSocket, last: null as InstanceType<typeof FakeSocket> | null };
});
vi.mock('socket.io-client', () => ({
  io: (opts: InstanceType<typeof fake.FakeSocket>['opts']) => {
    fake.last = new fake.FakeSocket();
    fake.last.opts = opts;
    return fake.last;
  },
}));

const NOW = '2026-11-16T10:00:00.000Z';
let local: MemoryStorage;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date(NOW));
  local = new MemoryStorage();
  vi.stubGlobal('localStorage', local);
  fake.last = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Node's setImmediate, which the fake timers leave alone; typed here because the web app has no Node
// types (the Docker image and CI type-check web/ on its own)
const setImmediateReal = (globalThis as unknown as { setImmediate(cb: () => void): void }).setImmediate;
const flush = () => new Promise<void>((resolve) => setImmediateReal(resolve));
const load = () => import('../race');

const player = (id: string, extra: Partial<LivePlayer> = {}): LivePlayer => ({ id, name: id, userId: null, status: 'idle', connected: true, ...extra });
const room = (rev: number, players: LivePlayer[], extra: Partial<LiveRoomState> = {}): LiveRoomState => ({
  id: 'room42',
  name: 'friends',
  event: '333',
  rev,
  hostId: players[0]?.id ?? null,
  status: 'lobby',
  round: null,
  players,
  results: {},
  standings: [],
  createdAt: NOW,
  ...extra,
});
const chat = (at: string, text: string, playerId = 'p1'): ChatMessage => ({ playerId, name: playerId, text, at });

/** a connection that joined room42 */
async function joined(join: Record<string, unknown> = {}) {
  const { RaceConnection } = await load();
  const conn = new RaceConnection('room42');
  conn.connect();
  const socket = fake.last!;
  socket.answer = (event) => (event === 'room:join' ? { ok: true, room: room(1, [player('host'), player('guest-me1234')]), playerId: 'guest-me1234', name: 'me', servedBy: 'race-a', ...join } : { ok: true });
  socket.connect();
  await flush();
  return { conn, socket, state: () => conn.snapshot };
}

describe('room codes, invite links and guest identity', () => {
  it.each([
    ['abcd', 'abcd'],
    ['  AbCd12  ', 'abcd12'],
    ['https://cubr.dev/race/room42', 'room42'],
    ['https://cubr.dev/race/Room42/', 'room42'],
    ['https://cubr.dev/race/room42?ref=chat', 'room42'],
    ['http://localhost:5173/race/room42#top', 'room42'],
    ['abc', null],
    ['a'.repeat(33), null],
    ['room 42', null],
    ['room-42', null],
    ['https://cubr.dev/racing/room42', null],
    ['', null],
  ])('reads %j as room %j', async (input, id) => {
    const { parseRoomCode } = await load();
    expect(parseRoomCode(input)).toBe(id);
  });

  it('makes invite links on this origin that read back as the room', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://cubr.dev' } });
    const { inviteLink, parseRoomCode } = await load();
    expect(inviteLink('room42')).toBe('https://cubr.dev/race/room42');
    expect(parseRoomCode(inviteLink('room42'))).toBe('room42');
  });

  it('keeps one secret guest key per browser, and replaces a malformed one (the October review\'s #12)', async () => {
    local.setItem('cubr.guestId', 'guest-old123'); // an id from before keys
    const { getGuestKey, getGuestId, defaultGuestName } = await load();
    const key = getGuestKey();
    expect(key).toMatch(/^[a-z0-9]{32}$/);
    expect(getGuestKey()).toBe(key);
    expect(local.getItem('cubr.guestKey')).toBe(key);
    expect(getGuestId()).toBeNull(); // the old id went with the new key: the server makes a new one from it
    expect(defaultGuestName()).toBe('guest');
    local.setItem('cubr.guestKey', 'short');
    expect(getGuestKey()).toMatch(/^[a-z0-9]{32}$/);
    expect(getGuestKey()).not.toBe(key);
  });

  it('keeps the same guest key for the page when storage is blocked', async () => {
    const blocked = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    const { getGuestKey, getGuestName, setGuestName } = await load();
    const key = getGuestKey();
    expect(key).toMatch(/^[a-z0-9]{32}$/);
    expect(getGuestKey()).toBe(key);
    expect(getGuestName()).toBe('');
    expect(() => setGuestName('x')).not.toThrow();
  });

  it('stores a trimmed nickname of at most 20 characters and forgets a blank one', async () => {
    const { getGuestName, setGuestName } = await load();
    expect(getGuestName()).toBe('');
    setGuestName('  speedy  ');
    expect(getGuestName()).toBe('speedy');
    setGuestName('x'.repeat(30));
    expect(getGuestName()).toBe('x'.repeat(20));
    setGuestName('   ');
    expect(local.getItem('cubr.guestName')).toBeNull();
  });
});

describe('RaceConnection', () => {
  it('joins the room on connect, adopts the guest id the server gave, and notes the pod serving it', async () => {
    const { socket, state } = await joined({ chat: [chat('2026-11-16T09:59:00.000Z', 'hi')] });
    expect(socket.emitted).toEqual([{ event: 'room:join', payload: { roomId: 'room42' } }]);
    expect(state()).toMatchObject({ connection: 'connected', playerId: 'guest-me1234', name: 'me', servedBy: 'race-a', previousPods: [], joinError: null });
    expect(state().room?.rev).toBe(1);
    expect(state().chat.map((m) => m.text)).toEqual(['hi']);
    expect(local.getItem('cubr.guestId')).toBe('guest-me1234');
  });

  it('sends its secret guest key in the handshake, never an id, and uses the id it was given for its default name', async () => {
    const { socket } = await joined({ playerId: 'gst-abcdef123456' });
    const auth = await new Promise<Record<string, unknown>>((resolve) => socket.opts.auth!(resolve));
    expect(auth.guestKey).toMatch(/^[a-z0-9]{32}$/);
    expect(auth).not.toHaveProperty('guestId');
    const { defaultGuestName } = await load();
    expect(defaultGuestName()).toBe('guest-3456');
  });

  it('starts the round after the one on screen, so a retry cannot skip one', async () => {
    const { conn, socket } = await joined();
    socket.fire('room:state', room(2, [player('host'), player('guest-me1234')], { round: { n: 3, scramble: 'R U', startedAt: NOW } }));
    await conn.nextRound();
    expect(socket.emitted.at(-1)).toEqual({ event: 'round:next', payload: { fromRound: 3 } });
  });

  it('ignores room states older than the one it has (broadcasts from other pods arrive out of order) and those of other rooms', async () => {
    const { socket, state } = await joined();
    socket.fire('room:state', room(3, [player('host'), player('guest-me1234', { status: 'solving' })]));
    expect(state().room?.rev).toBe(3);
    socket.fire('room:state', room(2, [player('host')]));
    expect(state().room?.rev).toBe(3);
    expect(state().room?.players).toHaveLength(2);
    socket.fire('room:state', { ...room(9, []), id: 'other-room' });
    expect(state().room?.rev).toBe(3);
    socket.fire('room:state', room(3, [player('host'), player('guest-me1234', { status: 'done' })]));
    expect(state().room?.players[1].status).toBe('done');
  });

  it('adds chat lines for joins, leaves, disconnects, reconnects, a new host and a new round', async () => {
    const { socket, state } = await joined();
    socket.fire('room:state', room(2, [player('host', { connected: false }), player('carol')], { hostId: 'carol', round: { n: 1, scramble: 'R U', startedAt: NOW } }));
    socket.fire('room:state', room(3, [player('host'), player('carol')], { hostId: 'carol', round: { n: 1, scramble: 'R U', startedAt: NOW } }));
    const system = state().chat.filter((m) => m.system);
    expect(system.map((m) => m.text)).toEqual(['host disconnected', 'carol joined', 'guest-me1234 left', 'carol is now the host', 'round 1 started', 'host reconnected']);
  });

  it('keeps each chat message once, in time order, and only the latest 150', async () => {
    const { socket, state } = await joined();
    const late = chat('2026-11-16T10:00:02.000Z', 'second');
    const early = chat('2026-11-16T10:00:01.000Z', 'first');
    socket.fire('chat:message', late);
    socket.fire('chat:message', early);
    socket.fire('chat:message', late);
    expect(state().chat.map((m) => m.text)).toEqual(['first', 'second']);
    for (let i = 0; i < 160; i++) socket.fire('chat:message', chat(new Date(Date.UTC(2026, 10, 16, 11, 0, i)).toISOString(), `m${i}`));
    expect(state().chat).toHaveLength(150);
    expect(state().chat[0].text).toBe('m10');
    expect(state().chat.at(-1)!.text).toBe('m159');
  });

  it("empties the chat when a moderator clears the room's", async () => {
    const { socket, state } = await joined();
    socket.fire('chat:message', chat('2026-11-16T10:00:01.000Z', 'something to remove'));
    expect(state().chat).toHaveLength(1);
    socket.fire('chat:cleared', {});
    expect(state().chat).toEqual([]);
  });

  it('refuses calls at once while disconnected, so nothing is sent twice after a reconnect', async () => {
    const { RaceConnection } = await load();
    const conn = new RaceConnection('room42');
    conn.connect();
    await expect(conn.sendChat('hi')).rejects.toMatchObject({ name: 'RaceError', code: 'OFFLINE' });
    expect(fake.last!.emitted).toEqual([]);
  });

  it('turns a refusal into a RaceError with the server code, and no answer into TIMEOUT', async () => {
    const { conn, socket } = await joined();
    socket.answer = (event) => (event === 'chat:send' ? { ok: false, code: 'RATE_LIMITED', error: 'slow down' } : { ok: true });
    await expect(conn.sendChat('hi')).rejects.toMatchObject({ code: 'RATE_LIMITED', message: 'slow down' });
    socket.answer = () => {
      throw new Error('operation has timed out');
    };
    await expect(conn.submitResult(1, 9000, 'OK')).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(conn.leave()).resolves.toBeUndefined(); // leaving never fails
    expect(socket.emitted.slice(-2).map((e) => e.event)).toEqual(['player:result', 'room:leave']);
    expect(socket.emitted.at(-2)!.payload).toEqual({ round: 1, timeMs: 9000, penalty: 'OK' });
  });

  it('gives up on a room that does not exist, and tries a passing join error again after 2 s', async () => {
    const { RaceConnection } = await load();
    const gone = new RaceConnection('room42');
    gone.connect();
    fake.last!.answer = () => ({ ok: false, code: 'NOT_FOUND', error: 'room not found' });
    fake.last!.connect();
    await flush();
    expect(gone.snapshot.joinError).toMatchObject({ code: 'NOT_FOUND', message: 'room not found' });
    expect(fake.last!.connected).toBe(false);

    const flaky = new RaceConnection('room42');
    flaky.connect();
    const socket = fake.last!;
    let tries = 0;
    socket.answer = () => (++tries === 1 ? { ok: false, code: 'INTERNAL', error: 'redis hiccup' } : { ok: true, room: room(1, [player('host')]), playerId: 'u1', servedBy: 'race-a' });
    socket.connect();
    await flush();
    expect(flaky.snapshot).toMatchObject({ joinError: null, lastError: 'redis hiccup', room: null });
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(tries).toBe(2);
    expect(flaky.snapshot.room?.id).toBe('room42');
  });

  it('remembers the pods it was served by when a reconnect lands on another pod', async () => {
    const { socket, state } = await joined();
    socket.disconnect();
    expect(state()).toMatchObject({ connection: 'reconnecting', lastError: 'connection lost' });
    socket.fire('room:state', room(4, [player('host'), player('guest-me1234')]));
    socket.answer = () => ({ ok: true, room: room(2, [player('host'), player('guest-me1234')]), playerId: 'guest-me1234', servedBy: 'race-b' });
    socket.connect();
    await flush();
    expect(state()).toMatchObject({ connection: 'connected', servedBy: 'race-b', previousPods: ['race-a'] });
    expect(state().room?.rev).toBe(2); // the join answer is taken as it is, even with an older revision
  });

  it('closes for good on destroy', async () => {
    const { conn, socket, state } = await joined();
    conn.destroy();
    expect(state().connection).toBe('closed');
    expect(socket.connected).toBe(false);
    socket.fire('room:state', room(9, []));
    expect(state().room?.rev).toBe(1);
  });
});
