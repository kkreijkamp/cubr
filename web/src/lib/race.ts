// Race client - wraps socket.io-client for the race service (docs/SPEC.md section 9.6).
//
// - websocket transport only (no long-polling -> the load balancer needs no sticky sessions);
// - handshake auth {token, name, guestKey} is re-read on every (re)connect;
// - every (re)connect re-joins the room, so a race pod being killed / drained during a rolling
//   update is invisible apart from the "connected via pod ..." label changing;
// - ack-based calls become promises with timeouts; calls are rejected (never buffered) while
//   disconnected so nothing is replayed twice after a reconnect.
import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getToken } from './api';
import { createStore, type Store } from './store';
import type { Penalty, RacePlayer, RoomState } from './types';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type PlayerStatus = 'idle' | 'inspecting' | 'solving' | 'done';

export interface LivePlayer extends RacePlayer {
  /** extra field from the race service: pods currently holding this player's socket(s) */
  pods?: string[];
}
export interface LiveRound {
  n: number;
  scramble: string;
  startedAt: string;
  /** extra field: "scramble-service" | "fallback" */
  scrambleSource?: string;
}
/** SPEC RoomState plus the extra fields the race service sends (rev, isPrivate, pods...). */
export interface LiveRoomState extends Omit<RoomState, 'players' | 'round' | 'hostId'> {
  hostId: string | null;
  players: LivePlayer[];
  round: LiveRound | null;
  isPrivate?: boolean;
  rev?: number;
}
export interface ChatMessage {
  playerId: string;
  name: string;
  text: string;
  at: string;
  /** generated locally (joins, leaves, rounds) - not sent by the server */
  system?: boolean;
}

export interface RaceSnapshot {
  roomId: string;
  connection: ConnectionState;
  room: LiveRoomState | null;
  playerId: string | null;
  name: string | null;
  /** race pod serving our websocket (from the join ack) */
  servedBy: string | null;
  /** pods we were connected via before, most recent first */
  previousPods: string[];
  chat: ChatMessage[];
  /** fatal: the room does not exist / expired / is full */
  joinError: RaceError | null;
  /** reconnect attempt counter while reconnecting */
  attempt: number;
  lastError: string | null;
}

export class RaceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RaceError';
  }
}

// ---- guest identity ---------------------------------------------------------------------------
// A guest is whoever holds its secret key (kept here, sent only in the handshake); the server shows the
// others an id made from it (services/race/src/identity.ts), which can't be used to play as that guest.
const GUEST_KEY_KEY = 'cubr.guestKey';
const GUEST_ID_KEY = 'cubr.guestId';
const GUEST_NAME_KEY = 'cubr.guestName';
const GUEST_KEY_RE = /^[a-z0-9]{32}$/;
/** an id the server assigned: "gst-" from a key, or "guest-" from the previous release */
const GUEST_ID_RE = /^(gst|guest)-[a-z0-9]{6,24}$/;

function randomId(len: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** Your guest key: the same on every visit, so a refresh or a reconnect to another pod keeps your seat. */
export function getGuestKey(): string {
  try {
    const stored = localStorage.getItem(GUEST_KEY_KEY);
    if (stored && GUEST_KEY_RE.test(stored)) return stored;
    const key = randomId(32);
    localStorage.setItem(GUEST_KEY_KEY, key);
    localStorage.removeItem(GUEST_ID_KEY); // an id from before the key belongs to someone else now
    return key;
  } catch {
    return (fallbackGuestKey ??= randomId(32));
  }
}
let fallbackGuestKey: string | null = null;
let fallbackGuestId: string | null = null;

/** Your public guest id, as the server last assigned it (for the default name), or null before the first join. */
export function getGuestId(): string | null {
  try {
    const stored = localStorage.getItem(GUEST_ID_KEY);
    return stored && GUEST_ID_RE.test(stored) ? stored : fallbackGuestId;
  } catch {
    return fallbackGuestId;
  }
}

/** Keeps the id the server assigned, to show the default name it gives you. */
function storeGuestId(id: string): void {
  if (!GUEST_ID_RE.test(id)) return;
  fallbackGuestId = id;
  try {
    localStorage.setItem(GUEST_ID_KEY, id);
  } catch {
    /* kept in memory */
  }
}

export function getGuestName(): string {
  try {
    return localStorage.getItem(GUEST_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setGuestName(name: string): void {
  try {
    const clean = name.trim().slice(0, 20);
    if (clean) localStorage.setItem(GUEST_NAME_KEY, clean);
    else localStorage.removeItem(GUEST_NAME_KEY);
  } catch {
    /* storage unavailable */
  }
}
/** Default display name the server gives a guest without a nickname ("guest" before the first join). */
export function defaultGuestName(): string {
  const id = getGuestId();
  return id ? `guest-${id.slice(-4)}` : 'guest';
}

/** Accepts a room code or a full invite link and returns the room id (or null). */
export function parseRoomCode(input: string): string | null {
  const s = input.trim().toLowerCase();
  const m = /\/race\/([a-z0-9]{4,32})(?:[/?#]|$)/.exec(s) ?? /^([a-z0-9]{4,32})$/.exec(s);
  return m ? m[1] : null;
}

export function inviteLink(roomId: string): string {
  return `${window.location.origin}/race/${roomId}`;
}

// ---- connection ---------------------------------------------------------------------------------
type Ack = { ok: boolean; error?: string; code?: string; [k: string]: unknown };

const JOIN_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 6000;
const CHAT_CAP = 150;
const FATAL_JOIN_CODES = new Set(['NOT_FOUND', 'CONFLICT', 'BAD_REQUEST', 'FORBIDDEN']);

function chatKey(m: ChatMessage): string {
  return `${m.at}|${m.playerId}|${m.text}`;
}

export class RaceConnection {
  readonly store: Store<RaceSnapshot>;
  private socket: Socket | null = null;
  private destroyed = false;
  private joinRetry: ReturnType<typeof setTimeout> | null = null;
  private joinedOnce = false;

  constructor(readonly roomId: string) {
    this.store = createStore<RaceSnapshot>(initialSnapshot(roomId));
  }

  private patch(p: Partial<RaceSnapshot>): void {
    this.store.set((s) => ({ ...s, ...p }));
  }

  get snapshot(): RaceSnapshot {
    return this.store.get();
  }

  connect(): void {
    if (this.socket || this.destroyed) return;
    const socket = io({
      path: '/socket.io',
      transports: ['websocket'],
      // a function, so token / nickname are re-read on every reconnect
      auth: (cb) => cb({ token: getToken() ?? undefined, name: getGuestName() || undefined, guestKey: getGuestKey() }),
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 8000,
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.patch({ connection: 'connected', attempt: 0, lastError: null });
      void this.join();
    });
    socket.on('disconnect', (reason) => {
      if (this.destroyed) return;
      this.patch({ connection: 'reconnecting', lastError: reason === 'io server disconnect' ? 'disconnected by server' : 'connection lost' });
      // the client does not auto-reconnect after a server-side disconnect - do it ourselves
      if (reason === 'io server disconnect') setTimeout(() => !this.destroyed && socket.connect(), 1000);
    });
    socket.on('connect_error', (err) => {
      if (this.destroyed) return;
      this.patch({ connection: this.joinedOnce ? 'reconnecting' : 'connecting', lastError: err.message || 'connection failed' });
    });
    socket.io.on('reconnect_attempt', (n) => this.patch({ attempt: n }));

    socket.on('room:state', (state: LiveRoomState) => this.applyState(state));
    socket.on('chat:message', (msg: ChatMessage) => this.addChat([msg]));
    // a moderator cleared the room's chat
    socket.on('chat:cleared', () => this.patch({ chat: [] }));
  }

  /** Reconnect with a fresh handshake (e.g. after changing the guest nickname). */
  reconnect(): void {
    if (!this.socket || this.destroyed) return;
    this.socket.disconnect();
    this.patch({ connection: 'reconnecting' });
    this.socket.connect();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.joinRetry) clearTimeout(this.joinRetry);
    this.socket?.removeAllListeners();
    this.socket?.io.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.patch({ connection: 'closed' });
  }

  private async join(): Promise<void> {
    if (this.joinRetry) clearTimeout(this.joinRetry);
    try {
      const res = await this.call<{ room: LiveRoomState; playerId: string; name?: string; servedBy?: string; chat?: ChatMessage[] }>(
        'room:join',
        { roomId: this.roomId },
        JOIN_TIMEOUT_MS,
      );
      const prev = this.snapshot;
      const servedBy = res.servedBy ?? null;
      const previousPods = prev.servedBy && servedBy && prev.servedBy !== servedBy ? [prev.servedBy, ...prev.previousPods].slice(0, 5) : prev.previousPods;
      this.joinedOnce = true;
      // guests: keep the id the server made from our key (for the default name)
      if (typeof res.playerId === 'string' && GUEST_ID_RE.test(res.playerId)) storeGuestId(res.playerId);
      this.patch({ playerId: res.playerId, name: res.name ?? prev.name, servedBy, previousPods, joinError: null });
      this.applyState(res.room, true);
      if (Array.isArray(res.chat)) this.addChat(res.chat);
    } catch (err) {
      if (this.destroyed) return;
      const e = err instanceof RaceError ? err : new RaceError('ERROR', String(err));
      if (FATAL_JOIN_CODES.has(e.code)) {
        this.patch({ joinError: e });
        this.socket?.disconnect();
        return;
      }
      // transient (timeout, Redis hiccup): try again while connected
      this.patch({ lastError: e.message });
      this.joinRetry = setTimeout(() => {
        if (!this.destroyed && this.socket?.connected) void this.join();
      }, 2000);
    }
  }

  private applyState(state: LiveRoomState, force = false): void {
    if (!state || state.id !== this.roomId) return;
    const cur = this.snapshot.room;
    // ignore stale broadcasts that arrive out of order across pods
    if (!force && cur && typeof cur.rev === 'number' && typeof state.rev === 'number' && state.rev < cur.rev) return;
    const system = cur ? diffSystemMessages(cur, state) : [];
    this.patch({ room: state });
    if (system.length) this.addChat(system);
  }

  private addChat(msgs: ChatMessage[]): void {
    this.store.set((s) => {
      const seen = new Set(s.chat.map(chatKey));
      const fresh = msgs.filter((m) => m && typeof m.text === 'string' && !seen.has(chatKey(m)));
      if (!fresh.length) return s;
      const chat = [...s.chat, ...fresh].sort((a, b) => a.at.localeCompare(b.at)).slice(-CHAT_CAP);
      return { ...s, chat };
    });
  }

  /** Emits with an ack and a timeout. Rejects immediately while disconnected (no buffering). */
  private async call<T>(event: string, payload: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    const socket = this.socket;
    if (!socket || !socket.connected) throw new RaceError('OFFLINE', 'Not connected - reconnecting...');
    let res: Ack;
    try {
      res = (await socket.timeout(timeoutMs).emitWithAck(event, payload)) as Ack;
    } catch {
      throw new RaceError('TIMEOUT', 'The race server did not answer in time');
    }
    if (!res || res.ok !== true) throw new RaceError(res?.code ?? 'ERROR', res?.error ?? 'Request failed');
    return res as unknown as T;
  }

  /** Starts the round after the one on screen: a retry, or a second click, can't skip one. */
  nextRound(): Promise<{ round: LiveRound }> {
    return this.call('round:next', { fromRound: this.snapshot.room?.round?.n ?? 0 }, 10_000);
  }
  setStatus(status: PlayerStatus): Promise<unknown> {
    return this.call('player:status', { status });
  }
  submitResult(round: number, timeMs: number, penalty: Penalty): Promise<unknown> {
    return this.call('player:result', { round, timeMs, penalty });
  }
  sendChat(text: string): Promise<unknown> {
    return this.call('chat:send', { text });
  }
  /** Explicit leave: removes you (and your results) from the room. */
  async leave(): Promise<void> {
    try {
      await this.call('room:leave', {}, 3000);
    } catch {
      /* leaving anyway */
    }
  }
}

function initialSnapshot(roomId: string): RaceSnapshot {
  return {
    roomId,
    connection: 'connecting',
    room: null,
    playerId: null,
    name: null,
    servedBy: null,
    previousPods: [],
    chat: [],
    joinError: null,
    attempt: 0,
    lastError: null,
  };
}

/** Local chat lines for joins, leaves and new rounds (derived from consecutive room states). */
function diffSystemMessages(prev: LiveRoomState, next: LiveRoomState): ChatMessage[] {
  const at = new Date().toISOString();
  const out: ChatMessage[] = [];
  const sys = (text: string) => out.push({ playerId: '', name: '', text, at, system: true });
  const before = new Map(prev.players.map((p) => [p.id, p]));
  const after = new Map(next.players.map((p) => [p.id, p]));
  for (const p of next.players) {
    const old = before.get(p.id);
    if (!old) sys(`${p.name} joined`);
    else if (old.connected && !p.connected) sys(`${p.name} disconnected`);
    else if (!old.connected && p.connected) sys(`${p.name} reconnected`);
  }
  for (const p of prev.players) if (!after.has(p.id)) sys(`${p.name} left`);
  if (next.hostId && next.hostId !== prev.hostId) {
    const host = after.get(next.hostId);
    if (host && prev.hostId) sys(`${host.name} is now the host`);
  }
  if (next.round && next.round.n !== prev.round?.n) sys(`round ${next.round.n} started`);
  return out;
}

/** React binding: one live connection per mounted room page. */
export function useRace(roomId: string): { state: RaceSnapshot; conn: RaceConnection | null } {
  const [conn, setConn] = useState<RaceConnection | null>(null);
  const [state, setState] = useState<RaceSnapshot>(() => initialSnapshot(roomId));
  useEffect(() => {
    const c = new RaceConnection(roomId);
    setConn(c);
    setState(c.store.get());
    const unsub = c.store.subscribe(() => setState(c.store.get()));
    c.connect();
    return () => {
      unsub();
      c.destroy();
      setConn(null);
    };
  }, [roomId]);
  return { state, conn };
}
