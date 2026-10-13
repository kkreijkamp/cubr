import { useEffect, useRef, useState } from 'react';
import { Crown, MessageSquare, Send, Trophy, Users } from 'lucide-react';
import { effectiveMs, formatTime, fromApiValue, type Penalty, type Precision } from '@cubetype/cubestats';
import type { ChatMessage, LivePlayer, LiveRoomState } from '../../../lib/race';
import { Dot, type DotState } from '../ui';

const STATUS_LABEL: Record<string, string> = {
  idle: 'ready',
  inspecting: 'inspecting',
  solving: 'solving',
  done: 'done',
};

function dotFor(p: LivePlayer): DotState {
  if (!p.connected) return 'offline';
  if (p.status === 'inspecting' || p.status === 'solving' || p.status === 'done') return p.status;
  return 'idle';
}

const shortPod = (pod: string) => {
  const parts = pod.split('-');
  return parts.length >= 3 ? parts[parts.length - 1] : pod;
};

/** Players merged with standings: live status dot, host crown, wins / mean / ao5. */
export function PlayersCard({ room, playerId, precision }: { room: LiveRoomState; playerId: string | null; precision: Precision }) {
  const byId = new Map(room.players.map((p) => [p.id, p]));
  const ordered: { player: LivePlayer; wins: number; solves: number; meanMs: number | null; ao5: number | null }[] = [];
  for (const s of room.standings ?? []) {
    const player = byId.get(s.playerId);
    if (player) ordered.push({ player, wins: s.wins, solves: s.solves, meanMs: s.meanMs, ao5: s.ao5 });
  }
  for (const p of room.players) if (!ordered.some((o) => o.player.id === p.id)) ordered.push({ player: p, wins: 0, solves: 0, meanMs: null, ao5: null });
  const connected = room.players.filter((p) => p.connected).length;
  const anyRounds = Object.keys(room.results ?? {}).length > 0;

  return (
    <section className="card race-card" aria-labelledby="players-title">
      <div className="live-section-title">
        <h3 className="h3" id="players-title">
          <Users /> players
        </h3>
        <span className="meta">
          {connected}/{room.players.length} online
        </span>
      </div>
      <table className="race-standings">
        <thead>
          <tr>
            <th className="left">name</th>
            <th data-tip="rounds won">
              <Trophy size={12} aria-label="wins" />
            </th>
            <th>mean</th>
            <th>ao5</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(({ player: p, wins, meanMs, ao5 }, i) => {
            const pods = p.pods ?? [];
            const status = !p.connected ? 'offline' : room.status === 'running' || p.status !== 'idle' ? STATUS_LABEL[p.status] ?? p.status : 'online';
            return (
              <tr key={p.id} className={`${p.id === playerId ? 'me' : ''}${p.connected ? '' : ' offline'}`}>
                <td className="left">
                  <div className="player">
                    <Dot state={dotFor(p)} pulse={p.connected && p.status === 'solving'} title={status} />
                    <div className="who">
                      <div className="name">
                        {anyRounds && <span className="rank">{i + 1}</span>}
                        <span className="text-name">{p.name}</span>
                        {p.id === room.hostId && <Crown size={12} className="host" aria-label="host" />}
                        {p.id === playerId && <span className="you">you</span>}
                      </div>
                      <div className="status">
                        {status}
                        {pods.length > 0 && <span title={`websocket served by ${pods.join(', ')}`}> · pod {pods.map(shortPod).join(', ')}</span>}
                      </div>
                    </div>
                  </div>
                </td>
                <td>{wins}</td>
                <td>{formatTime(fromApiValue(meanMs), precision)}</td>
                <td>{formatTime(fromApiValue(ao5), precision)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function cellText(r: { timeMs: number; penalty: Penalty } | undefined, precision: Precision): string {
  if (!r) return '';
  if (r.penalty === 'DNF') return 'DNF';
  return formatTime(effectiveMs(r), precision) + (r.penalty === '+2' ? '+' : '');
}

/** Rounds × players; the best time of each round in main colour. Newest round on top. */
export function ResultsGrid({ room, playerId, precision }: { room: LiveRoomState; playerId: string | null; precision: Precision }) {
  const rounds = Object.keys(room.results ?? {})
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  const order = (room.standings ?? []).map((s) => s.playerId).filter((id) => room.players.some((p) => p.id === id));
  for (const p of room.players) if (!order.includes(p.id)) order.push(p.id);
  // players who left still have results? (server removes them) — show only current players
  const players = order.map((id) => room.players.find((p) => p.id === id)!);
  if (rounds.length === 0) return null;
  return (
    <section className="race-results" aria-labelledby="results-title">
      <div className="live-section-title">
        <h3 className="h3" id="results-title">
          <Trophy /> results
        </h3>
        <span className="meta">
          {rounds.length} round{rounds.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="table-wrap">
        <table className="table race-grid">
          <thead>
            <tr>
              <th className="left">#</th>
              {players.map((p) => (
                <th key={p.id} className={p.id === playerId ? 'me' : ''} title={p.name}>
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rounds.map((n) => {
              const row = room.results[String(n)] ?? {};
              const best = Math.min(...Object.values(row).map(effectiveMs));
              const current = room.round?.n === n && room.status === 'running';
              return (
                <tr key={n} className={current ? 'current' : ''}>
                  <td className="left sub">{n}</td>
                  {players.map((p) => {
                    const r = row[p.id];
                    const isBest = r && Number.isFinite(best) && effectiveMs(r) === best;
                    let pendingLabel = '';
                    if (!r && current) pendingLabel = !p.connected ? 'offline' : p.status === 'inspecting' ? 'inspecting' : p.status === 'solving' ? 'solving…' : '·';
                    return (
                      <td key={p.id} className={`${isBest ? 'best' : ''}${r?.penalty === 'DNF' ? ' dnf' : ''}${!r ? ' pending' : ''}`}>
                        {r ? cellText(r, precision) : pendingLabel || '–'}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Room chat (≤ 200 chars) with local system lines for joins / rounds. */
export function RaceChat({
  chat,
  playerId,
  disabled,
  onSend,
}: {
  chat: ChatMessage[];
  playerId: string | null;
  disabled: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  const submit = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await onSend(t);
      setText('');
    } catch {
      /* onSend reports the error */
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="card race-card race-chat" aria-labelledby="chat-title">
      <div className="live-section-title">
        <h3 className="h3" id="chat-title">
          <MessageSquare /> chat
        </h3>
      </div>
      <ol
        className="chat-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        aria-live="polite"
      >
        {chat.length === 0 && <li className="chat-empty">no messages yet — say hi</li>}
        {chat.map((m, i) =>
          m.system ? (
            <li key={`${m.at}-${i}`} className="sys">
              {m.text}
            </li>
          ) : (
            <li key={`${m.at}-${i}`} className={m.playerId === playerId ? 'mine' : ''}>
              <span className="t">{hhmm(m.at)}</span>
              <span className="n">{m.name}</span>
              <span className="m">{m.text}</span>
            </li>
          ),
        )}
      </ol>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 200))}
          placeholder={disabled ? 'reconnecting…' : 'message'}
          maxLength={200}
          disabled={disabled}
          aria-label="chat message"
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur();
          }}
        />
        {text.length > 150 && <span className="count">{200 - text.length}</span>}
        <button className="btn-text" type="submit" disabled={disabled || !text.trim() || sending} aria-label="send">
          <Send size={16} />
        </button>
      </form>
    </section>
  );
}
