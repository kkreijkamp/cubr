// Race lobby: public rooms (polled every 5 s), create a room, join by code / invite link.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconArrowRight, IconDoorEnter, IconHash, IconPlus, IconRefresh, IconSwords, IconUser } from '@tabler/icons-react';
import { EVENTS, getEvent } from '@cubetype/cubestats';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useRegisterCommands } from '../lib/commands';
import { timeAgo } from '../lib/format';
import { defaultGuestName, getGuestName, parseRoomCode, setGuestName } from '../lib/race';
import type { RaceRoomSummary } from '../lib/types';
import { ErrorState, Loading, Spinner } from '../components/Spinner';
import { useInterval, usePageVisible, useStoredState } from '../components/live/hooks';
import '../components/live/live.css';
import '../components/live/race/race.css';

function RoomsTable({ onJoin }: { onJoin: (id: string) => void }) {
  const [rooms, setRooms] = useState<RaceRoomSummary[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const visible = usePageVisible();
  const inFlight = useRef<AbortController | null>(null);

  const load = () => {
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    setLoading(true);
    api.race
      .rooms(ctrl.signal)
      .then((r) => {
        setRooms(Array.isArray(r.rooms) ? r.rooms : []);
        setError(null);
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e);
      })
      .finally(() => {
        if (inFlight.current === ctrl) setLoading(false);
      });
  };
  useEffect(() => {
    load();
    return () => inFlight.current?.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useInterval(load, visible ? 5000 : null);

  return (
    <section className="card race-rooms" aria-labelledby="rooms-title">
      <div className="live-section-title">
        <h3 className="h3" id="rooms-title">
          <IconSwords /> public rooms
        </h3>
        <button className="btn-text small" onClick={load} aria-label="refresh" style={{ padding: 0 }}>
          {loading ? <Spinner size={14} /> : <IconRefresh size={14} />} {rooms ? `${rooms.length} open` : ''}
        </button>
      </div>
      {error && !rooms ? (
        <ErrorState error={error instanceof ApiError && error.isUnavailable ? new Error('the race service is unavailable right now') : error} onRetry={load} />
      ) : !rooms ? (
        <Loading />
      ) : rooms.length === 0 ? (
        <div className="empty">no public rooms right now - create one and invite a friend.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="left">room</th>
                <th className="left">event</th>
                <th>players</th>
                <th className="center">status</th>
                <th className="hide-sm">created</th>
                <th className="hide-sm" aria-label="join" />
              </tr>
            </thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => onJoin(r.id)}>
                  <td className="left room-name">{r.name}</td>
                  <td className="left">{getEvent(r.event)?.short ?? r.event}</td>
                  <td>{r.players}</td>
                  <td className="center">
                    <span className={`pill${r.status === 'running' ? ' main' : ''}`}>{r.status === 'lobby' ? 'waiting' : r.status}</span>
                  </td>
                  <td className="secondary hide-sm">{timeAgo(r.createdAt)}</td>
                  <td className="hide-sm">
                    <IconArrowRight size={16} aria-label="join" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && rooms && <div className="tiny error">refresh failed: {error.message}</div>}
    </section>
  );
}

export default function RaceLobbyPage() {
  const navigate = useNavigate();
  const { user, status } = useAuth();
  const [nick, setNick] = useState(getGuestName());
  const [name, setName] = useState('');
  const [event, setEvent] = useStoredState<string>('cubetype.race.event', '333');
  const [isPrivate, setIsPrivate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const displayName = user?.username ?? (nick.trim() || defaultGuestName());
  const placeholder = `${displayName}'s room`;

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      if (status !== 'authed') setGuestName(nick);
      const res = await api.race.createRoom({ name: (name.trim() || placeholder).slice(0, 40), event, isPrivate });
      navigate(`/race/${res.room.id}`);
    } catch (e) {
      const err = e as ApiError;
      setCreateError(err.isUnavailable ? 'the race service is unavailable - try again in a moment' : err.message);
      setCreating(false);
    }
  };

  const join = (raw: string) => {
    const id = parseRoomCode(raw);
    if (!id) {
      setCodeError('that is not a room code or invite link');
      return;
    }
    if (status !== 'authed') setGuestName(nick);
    navigate(`/race/${id}`);
  };

  useRegisterCommands(
    'race-lobby',
    () => [
      { id: 'race-create', label: 'Create race room', icon: <IconPlus />, run: () => nameRef.current?.focus() },
      { id: 'race-join-code', label: 'Join race room by code', icon: <IconHash />, run: () => codeRef.current?.focus() },
    ],
    [],
  );

  return (
    <div className="stack lg race-lobby live-page">
      <div className="live-head">
        <div className="titles">
          <h1 className="h2">
            <IconSwords /> race
          </h1>
          <div className="subtitle">
            real-time races with friends - same scramble, live status, results per round. rooms live in redis and websockets are spread across all
            race pods.
          </div>
        </div>
      </div>

      <div className="race-lobby-grid">
        <RoomsTable onJoin={(id) => join(id)} />

        <div className="stack">
          <section className="card race-card" aria-labelledby="you-title">
            <div className="live-section-title">
              <h3 className="h3" id="you-title">
                <IconUser /> you
              </h3>
            </div>
            {status === 'authed' && user ? (
              <div className="small">
                racing as <span className="main">{user.username}</span>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="nick">guest nickname</label>
                <input
                  id="nick"
                  value={nick}
                  maxLength={20}
                  placeholder={defaultGuestName()}
                  onChange={(e) => setNick(e.target.value)}
                  onBlur={() => setGuestName(nick)}
                />
                <span className="tiny sub">sign in to race under your account and keep your times.</span>
              </div>
            )}
          </section>

          <section className="card race-card" aria-labelledby="create-title">
            <div className="live-section-title">
              <h3 className="h3" id="create-title">
                <IconPlus /> create room
              </h3>
            </div>
            <form
              className="stack race-form"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <div className="field">
                <label htmlFor="room-name">name</label>
                <input id="room-name" ref={nameRef} value={name} maxLength={40} placeholder={placeholder} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="room-event">event</label>
                <select id="room-event" value={event} onChange={(e) => setEvent(e.target.value)}>
                  {EVENTS.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.short} - {ev.name}
                    </option>
                  ))}
                </select>
              </div>
              <label className="live-checkbox">
                <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
                private - only people with the link can join
              </label>
              {createError && <div className="small error">{createError}</div>}
              <button className="btn primary block" type="submit" disabled={creating}>
                {creating ? <Spinner size={16} /> : <IconDoorEnter />} create &amp; join
              </button>
            </form>
          </section>

          <section className="card race-card" aria-labelledby="join-title">
            <div className="live-section-title">
              <h3 className="h3" id="join-title">
                <IconHash /> join by code
              </h3>
            </div>
            <form
              className="row race-join"
              onSubmit={(e) => {
                e.preventDefault();
                join(code);
              }}
            >
              <input
                ref={codeRef}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setCodeError(null);
                }}
                placeholder="code or invite link"
                aria-label="room code or invite link"
                className={codeError ? 'shake' : ''}
              />
              <button className="btn" type="submit" disabled={!code.trim()}>
                join
              </button>
            </form>
            {codeError && <div className="small error" style={{ marginTop: '0.5rem' }}>{codeError}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}
