// Race client — wraps socket.io-client for the race service (docs/SPEC.md §9.6).
//
// - websocket transport only (no long-polling → the load balancer needs no sticky sessions);
// - handshake auth {token, name, guestId} is re-read on every (re)connect;
// - every (re)connect re-joins the room;
// - ack-based calls become promises with timeouts; calls are rejected (never buffered) while
//   disconnected so nothing is replayed twice after a reconnect.
import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getToken } from './api';
import { createStore, type Store } from './store';
import type { Penalty, RoomState } from './types';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type PlayerStatus = 'idle' | 'inspecting' | 'solving' | 'done';

export interface LiveRound {
  n: number;
  scramble: string;
  startedAt: string;
  /** extra field: "scramble-service" | "fallback" */
  scrambleSource?: string;
}
/** SPEC RoomState plus the extra fields the race service sends (rev, isPrivate…). */
export interface LiveRoomState extends Omit<RoomState, 'round' | 'hostId'> {
  hostId: string | null;
  round: LiveRound | null;
  isPrivate?: boolean;
  rev?: number;
}
export interface ChatMessage {
  playerId: string;
  name: string;
  text: string;
  at: string;
  /** generated locally (joins, leaves, rounds) — not sent by the server */
  system?: boolean;
}

export interface RaceSnapshot {
  roomId: string;
  connection: ConnectionState;
  room: LiveRoomState | null;
  playerId: string | null;
  name: string | null;
  chat: ChatMessage[];
  /** fatal: the room does not exist / expired / is full */
  joinError: RaceError | null;
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
const GUEST_ID_KEY = 'cubetype.guestId';
const GUEST_NAME_KEY = 'cubetype.guestName';
const GUEST_ID_RE = /^guest-[a-z0-9]{6,24}$/;

function randomId(len: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** Stable guest id (`guest-<random>`), so a refresh or a reconnect to another pod keeps your seat. */
export function getGuestId(): string {
  try {
    const stored = localStorage.getItem(GUEST_ID_KEY);
    if (stored && GUEST_ID_RE.test(stored)) return stored;
    const id = `guest-${randomId(10)}`;
    localStorage.setItem(GUEST_ID_KEY, id);
    return id;
  } catch {
    return (fallbackGuestId ??= `guest-${randomId(10)}`);
  }
}
let fallbackGuestId: string | null = null;

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
/** Default display name the server gives a guest without a nickname. */
export function defaultGuestName(): string {
  return `guest-${getGuestId().slice(-4)}`;
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

function chatKey(m: ChatMessage): string {
  return `${m.at}|${m.playerId}|${m.text}`;
}

export class RaceConnection {
  readonly store: Store<RaceSnapshot>;
  private socket: Socket | null = null;
  private destroyed = false;

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
      auth: (cb) => cb({ token: getToken() ?? undefined, name: getGuestName() || undefined, guestId: getGuestId() }),
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.patch({ connection: 'connected', lastError: null });
      void this.join();
    });
    socket.on('disconnect', () => {
      if (this.destroyed) return;
      this.patch({ connection: 'reconnecting', lastError: 'connection lost' });
    });
    socket.on('connect_error', (err) => {
      if (this.destroyed) return;
      this.patch({ lastError: err.message || 'connection failed' });
    });

    socket.on('room:state', (state: LiveRoomState) => this.applyState(state));
    socket.on('chat:message', (msg: ChatMessage) => this.addChat([msg]));
  }

  destroy(): void {
    this.destroyed = true;
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.patch({ connection: 'closed' });
  }

  private async join(): Promise<void> {
    try {
      const res = await this.call<{ room: LiveRoomState; playerId: string; name?: string; chat?: ChatMessage[] }>(
        'room:join',
        { roomId: this.roomId },
        JOIN_TIMEOUT_MS,
      );
      const prev = this.snapshot;
      this.patch({ playerId: res.playerId, name: res.name ?? prev.name, joinError: null });
      this.applyState(res.room);
      if (Array.isArray(res.chat)) this.addChat(res.chat);
    } catch (err) {
      if (this.destroyed) return;
      const e = err instanceof RaceError ? err : new RaceError('ERROR', String(err));
      this.patch({ joinError: e });
      this.socket?.disconnect();
    }
  }

  private applyState(state: LiveRoomState): void {
    if (!state || state.id !== this.roomId) return;
    const cur = this.snapshot.room;
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
    if (!socket || !socket.connected) throw new RaceError('OFFLINE', 'Not connected — reconnecting…');
    let res: Ack;
    try {
      res = (await socket.timeout(timeoutMs).emitWithAck(event, payload)) as Ack;
    } catch {
      throw new RaceError('TIMEOUT', 'The race server did not answer in time');
    }
    if (!res || res.ok !== true) throw new RaceError(res?.code ?? 'ERROR', res?.error ?? 'Request failed');
    return res as unknown as T;
  }

  nextRound(): Promise<{ round: LiveRound }> {
    return this.call('round:next', {}, 10_000);
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
    chat: [],
    joinError: null,
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
