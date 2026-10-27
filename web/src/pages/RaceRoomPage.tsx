// Race room: real-time multiplayer over Socket.IO (lib/race.ts). Any race pod can serve any
// player - room state lives in Redis and the Redis adapter relays broadcasts between pods.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeftIcon, ArrowRightStartOnRectangleIcon, FlagIcon, ForwardIcon, LinkIcon, PencilIcon, SignalSlashIcon } from '@heroicons/react/24/outline';
import { getEvent, formatTime, type Penalty } from '@cubetype/cubestats';
import { useAuth } from '../lib/auth';
import { useSettings } from '../lib/settings';
import { useRegisterCommands } from '../lib/commands';
import { toast } from '../lib/toast';
import { addSolve, ensureSession } from '../lib/solves';
import { defaultGuestName, getGuestName, inviteLink, RaceError, setGuestName, useRace } from '../lib/race';
import { Loading, Spinner } from '../components/Spinner';
import { Modal } from '../components/Modal';
import { TwistyPreview } from '../components/TwistyPreview';
import { copyText, isTypingTarget, useStoredState } from '../components/live/hooks';
import { useLiveTimer, TimerArea } from '../components/live/LiveTimer';
import { Dot, Notice, ScrambleText } from '../components/live/ui';
import { PlayersCard, RaceChat, ResultsGrid } from '../components/live/race/RaceParts';
import type { TimerResult } from '../timer/useTimerEngine';
import '../components/live/live.css';
import '../components/live/race/race.css';

interface Pending {
  round: number;
  timeMs: number;
  penalty: Penalty;
}

const shortPod = (pod: string) => {
  const parts = pod.split('-');
  return parts.length >= 3 ? parts.slice(-2).join('-') : pod;
};

function NicknameModal({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(getGuestName());
  return (
    <Modal title="nickname" onClose={onClose} center>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(name);
        }}
      >
        <div className="field">
          <label htmlFor="race-nick">how other racers see you (guests only)</label>
          <input id="race-nick" autoFocus value={name} maxLength={20} placeholder={defaultGuestName()} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn-text" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="btn primary">
            save &amp; rejoin
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function RaceRoomPage() {
  const { roomId = '' } = useParams();
  const id = roomId.toLowerCase();
  const navigate = useNavigate();
  const { state, conn } = useRace(id);
  const { user, status: authStatus } = useAuth();
  const settings = useSettings();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [nickOpen, setNickOpen] = useState(false);
  const [saveSolves, setSaveSolves] = useStoredState<boolean>('cubetype.race.saveSolves', false);
  const solveRound = useRef<number | null>(null);
  const saveWarned = useRef(false);

  const room = state.room;
  const connected = state.connection === 'connected' && !!room;
  const round = room?.round ?? null;
  const event = getEvent(room?.event ?? '333');
  const isHost = !!room && !!state.playerId && room.hostId === state.playerId;
  const myResult = round && state.playerId ? room?.results?.[String(round.n)]?.[state.playerId] : undefined;
  const canStart = connected && room!.status === 'running' && !!round && !myResult && !pending;

  // toast when the websocket moves to another pod (pod deleted / drained during a rollout)
  const lastPod = useRef<string | null>(null);
  useEffect(() => {
    if (state.servedBy && lastPod.current && state.servedBy !== lastPod.current) {
      toast.notice(`reconnected via pod ${state.servedBy} (was ${lastPod.current})`, { title: 'race' });
    }
    if (state.servedBy) lastPod.current = state.servedBy;
  }, [state.servedBy]);

  const submit = useCallback(
    (p: Pending) => {
      if (!conn) return;
      setPending(p);
      conn
        .submitResult(p.round, p.timeMs, p.penalty)
        .then(() => setPending((cur) => (cur === p ? null : cur)))
        .catch((e: RaceError) => {
          if (e.code === 'OFFLINE' || e.code === 'TIMEOUT') return; // retried after reconnect
          setPending((cur) => (cur === p ? null : cur));
          if (e.code !== 'CONFLICT') toast.error(e.message, { title: 'result not counted' });
        });
    },
    [conn],
  );

  // retry a result that could not be sent while disconnected
  useEffect(() => {
    if (!pending || !connected || !room) return;
    const mine = state.playerId ? room.results?.[String(pending.round)]?.[state.playerId] : undefined;
    if (mine) {
      setPending(null);
      return;
    }
    if (room.round?.n !== pending.round) {
      setPending(null);
      toast.notice('the round moved on while you were offline - that time was not counted');
      return;
    }
    const t = setTimeout(() => submit(pending), 300);
    return () => clearTimeout(t);
  }, [connected, pending, room, state.playerId, submit]);

  const onSolve = (r: TimerResult) => {
    const n = solveRound.current ?? round?.n ?? null;
    solveRound.current = null;
    if (n === null) return;
    submit({ round: n, timeMs: r.timeMs, penalty: r.penalty });
    if (saveSolves && round && room) {
      const scramble = round.scramble;
      ensureSession(room.event, { counts: true })
        .then((s) => addSolve({ timeMs: r.timeMs, penalty: r.penalty, scramble, source: 'race', sessionId: s.id }))
        .catch(() => {
          if (!saveWarned.current) toast.error('could not save the race solve to your session');
          saveWarned.current = true;
        });
    }
  };

  const engine = useLiveTimer({
    canStart,
    inspection: settings.inspection && (event?.inspection ?? true),
    onSolve,
    onInspectionStart: () => {
      solveRound.current = round?.n ?? null;
      conn?.setStatus('inspecting').catch(() => undefined);
    },
    onStart: () => {
      solveRound.current ??= round?.n ?? null;
      conn?.setStatus('solving').catch(() => undefined);
    },
    onCancel: () => {
      solveRound.current = null;
      conn?.setStatus('idle').catch(() => undefined);
    },
  });

  // a new round resets the display
  const roundN = round?.n ?? 0;
  const { cancel, clearResult } = engine;
  useEffect(() => {
    cancel();
    clearResult();
  }, [roundN, cancel, clearResult]);

  const nextRound = useCallback(async () => {
    if (!conn || !isHost || busy) return;
    setBusy(true);
    try {
      await conn.nextRound();
    } catch (e) {
      toast.error((e as Error).message, { title: 'next round' });
    } finally {
      setBusy(false);
    }
  }, [conn, isHost, busy]);

  const copyInvite = useCallback(async () => {
    if (await copyText(inviteLink(id))) toast.success('invite link copied');
    else toast.error('could not copy - the link is ' + inviteLink(id));
  }, [id]);

  const leave = useCallback(async () => {
    await conn?.leave();
    navigate('/race');
  }, [conn, navigate]);

  // host: N / Enter starts the next round
  const phase = engine.state.phase;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target) || document.querySelector('.modal-backdrop')) return;
      if (e.key !== 'n' && e.key !== 'N' && e.key !== 'Enter') return;
      // Enter on a focused button/link keeps its normal meaning
      if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target.closest('button, a')) return;
      if (!isHost || !connected || phase !== 'idle') return;
      e.preventDefault();
      void nextRound();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isHost, connected, phase, nextRound]);

  useRegisterCommands(
    'race-room',
    () => [
      ...(isHost ? [{ id: 'race-next', label: 'Next race round', icon: <ForwardIcon />, run: () => void nextRound() }] : []),
      { id: 'race-invite', label: 'Copy race invite link', icon: <LinkIcon />, run: () => void copyInvite() },
      { id: 'race-leave', label: 'Leave race room', icon: <ArrowRightStartOnRectangleIcon />, run: () => void leave() },
      ...(authStatus !== 'authed' ? [{ id: 'race-nick', label: 'Change race nickname', icon: <PencilIcon />, run: () => setNickOpen(true) }] : []),
    ],
    [isHost, nextRound, copyInvite, leave, authStatus],
  );

  // ---- fatal / loading states ----------------------------------------------------------------
  if (state.joinError) {
    const notFound = state.joinError.code === 'NOT_FOUND' || state.joinError.code === 'BAD_REQUEST';
    return (
      <div className="empty stack race-gone" style={{ justifyItems: 'center', paddingTop: '3rem' }}>
        <FlagIcon width={40} height={40} className="sub" />
        <div className="h2">{notFound ? 'room not found' : 'cannot join this room'}</div>
        <div className="sub">{notFound ? 'it may have expired (rooms close after 2 hours without activity).' : state.joinError.message}</div>
        <Link to="/race" className="btn">
          <ArrowLeftIcon width={16} height={16} /> back to the lobby
        </Link>
      </div>
    );
  }
  if (!room) {
    return (
      <div className="stack" style={{ justifyItems: 'center', paddingTop: '3rem' }}>
        {state.connection === 'connecting' && !state.lastError ? (
          <Loading label="joining room..." />
        ) : (
          <Notice
            tone="error"
            icon={<SignalSlashIcon />}
            action={
              <Link to="/race" className="btn small">
                lobby
              </Link>
            }
          >
            can't reach the race service{state.lastError ? ` (${state.lastError})` : ''} - retrying{state.attempt ? ` - attempt ${state.attempt}` : ''}...
          </Notice>
        )}
      </div>
    );
  }

  const players = room.players;
  const done = round ? Object.keys(room.results?.[String(round.n)] ?? {}).length : 0;
  const waitingList = round ? players.filter((p) => p.connected && !room.results?.[String(round.n)]?.[p.id]) : [];
  const waitingFor = waitingList.length;
  const waitingNames = waitingFor <= 3 ? waitingList.map((p) => p.name).join(', ') : `${waitingFor} players`;
  const host = players.find((p) => p.id === room.hostId);
  const myName = user?.username ?? state.name ?? (getGuestName() || defaultGuestName());

  let roundLine: string;
  if (!round) roundLine = isHost ? 'you are the host - start the first round when everyone is here' : `waiting for ${host?.name ?? 'the host'} to start the first round`;
  else if (pending) roundLine = connected ? 'sending your time...' : 'offline - your time will be sent when you reconnect';
  else if (room.status === 'finished') roundLine = isHost ? 'round finished - start the next one' : `round finished - waiting for ${host?.name ?? 'the host'}`;
  else if (myResult) roundLine = `you're done - waiting for ${waitingNames}`;
  else if (phase === 'running') roundLine = 'solving...';
  else roundLine = settings.inspection && event?.inspection ? 'press space to inspect' : 'hold space, release to start';

  return (
    <div className="race-room stack live-page">
      <div className="live-head fade-on-focus">
        <div className="titles">
          <Link to="/race" className="btn-text race-back">
            <ArrowLeftIcon width={14} height={14} /> race lobby
          </Link>
          <h1 className="h2 race-title">
            {room.name}
            <span className="pill">{event?.short ?? room.event}</span>
            {room.isPrivate && <span className="pill">private</span>}
          </h1>
          <div className="subtitle race-conn">
            <span className={`via ${connected ? 'on' : 'off'}`} data-tip={'your websocket is served by this race pod.\nother players may be on other pods -\nthe redis adapter relays broadcasts.'} data-tip-pos="down">
              <Dot state={connected ? 'up' : 'down'} pulse={connected} />
              {connected ? 'connected via pod ' : 'reconnecting... last pod '}
              <b>{state.servedBy ? shortPod(state.servedBy) : '...'}</b>
            </span>
            {state.previousPods.length > 0 && <span className="moved">moved from {shortPod(state.previousPods[0])}</span>}
            <span>
              playing as <b>{myName}</b>
              {authStatus !== 'authed' && (
                <button className="btn-text inline" onClick={() => setNickOpen(true)} aria-label="change nickname">
                  <PencilIcon width={12} height={12} />
                </button>
              )}
            </span>
          </div>
        </div>
        <div className="tools">
          <button className="btn small" onClick={() => void copyInvite()}>
            <LinkIcon /> copy invite link
          </button>
          <button className="btn small" onClick={() => void leave()}>
            <ArrowRightStartOnRectangleIcon /> leave
          </button>
        </div>
      </div>

      {!connected && (
        <Notice tone="error" icon={<SignalSlashIcon />}>
          connection lost - reconnecting{state.attempt ? ` (attempt ${state.attempt})` : ''}...{pending ? ' your time is saved and will be sent once you are back.' : ' the room keeps going without you.'}
        </Notice>
      )}

      <div className="race-layout">
        <div className="race-main">
          <div className="race-round fade-on-focus">
            <span className="round-n">{round ? `round ${round.n}` : 'lobby'}</span>
            <span className="round-line">{roundLine}</span>
            {round && (
              <span className="round-count mono-nums">
                {done}/{players.filter((p) => p.connected || room.results?.[String(round.n)]?.[p.id]).length} done
              </span>
            )}
          </div>

          {round ? (
            <div className="fade-on-focus">
              <ScrambleText scramble={round.scramble} event={room.event} muted={!!myResult} />
              {round.scrambleSource === 'fallback' && <div className="center tiny sub">offline scramble (scramble service unavailable)</div>}
            </div>
          ) : (
            <div className="race-invite fade-on-focus">
              <div className="sub small">invite friends with this link</div>
              <button className="invite-link" onClick={() => void copyInvite()} title="click to copy">
                {inviteLink(id)}
              </button>
            </div>
          )}

          <TimerArea engine={engine} scale={0.8} idleDim={!canStart && !myResult}>
            {myResult && phase === 'idle' && (
              <div className="race-submitted">
                submitted {formatTime(myResult.penalty === 'DNF' ? -1 : myResult.timeMs + (myResult.penalty === '+2' ? 2000 : 0), settings.precision)}
                {myResult.penalty === '+2' ? '+' : ''}
              </div>
            )}
            {pending && (
              <div className="race-submitted">
                <Spinner size={14} /> {connected ? 'sending...' : 'waiting for connection...'}
              </div>
            )}
          </TimerArea>

          <div className="race-actions fade-on-focus">
            {isHost ? (
              <button
                className={`btn ${!round || room.status === 'finished' ? 'primary' : ''}`}
                onClick={(e) => {
                  (e.currentTarget as HTMLButtonElement).blur();
                  void nextRound();
                }}
                disabled={!connected || busy || phase !== 'idle'}
              >
                {busy ? <Spinner size={16} /> : <ForwardIcon />}
                {!round ? 'start round 1' : room.status === 'running' && waitingFor > 0 ? 'skip to next round' : 'next round'}
                <kbd>n</kbd>
              </button>
            ) : (
              <span className="sub small">only the host ({host?.name ?? '...'}) can start rounds</span>
            )}
          </div>

          <div className="live-keytips fade-on-focus">
            <kbd>space</kbd> start / stop - <kbd>esc</kbd> while solving = DNF{isHost ? ' - ' : ''}
            {isHost && (
              <>
                <kbd>n</kbd> next round
              </>
            )}
          </div>

          <div className="fade-on-focus">
            <ResultsGrid room={room} playerId={state.playerId} precision={settings.precision} />
          </div>
        </div>

        <aside className="race-side fade-on-focus">
          <PlayersCard room={room} playerId={state.playerId} precision={settings.precision} />
          {round && settings.scramblePreview !== 'off' && event && (
            <section className="card race-card race-preview" aria-label="scramble preview">
              <TwistyPreview puzzle={event.puzzle} scramble={round.scramble} visualization={settings.scramblePreview === '3D' ? '3D' : '2D'} height={150} />
            </section>
          )}
          <RaceChat
            chat={state.chat}
            playerId={state.playerId}
            disabled={!connected}
            onSend={async (text) => {
              try {
                await conn?.sendChat(text);
              } catch (e) {
                toast.error((e as Error).message, { title: 'chat' });
                throw e;
              }
            }}
          />
          <label className="live-checkbox">
            <input type="checkbox" checked={saveSolves} onChange={(e) => setSaveSolves(e.target.checked)} />
            save my race solves to my {event?.short ?? room.event} session
          </label>
        </aside>
      </div>

      {nickOpen && (
        <NicknameModal
          onClose={() => setNickOpen(false)}
          onSave={(name) => {
            setGuestName(name);
            setNickOpen(false);
            conn?.reconnect();
          }}
        />
      )}
    </div>
  );
}
