// Daily challenge: 5 scrambles per event per UTC day, identical for everyone, ranked by ao5.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightEndOnRectangleIcon, ArrowUturnLeftIcon, CalendarDaysIcon, SignalSlashIcon } from '@heroicons/react/24/outline';
import { averageOfN, DAILY_EVENTS, effectiveMs, formatSolve, formatTime, getEvent, type Penalty } from '@cubr/cubestats';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSettings } from '../lib/settings';
import { useRegisterCommands } from '../lib/commands';
import { toast } from '../lib/toast';
import { utcDateKey } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { addSolve, ensureSession, solveStore } from '../lib/solves';
import { ErrorState, Loading, Spinner } from '../components/Spinner';
import { TwistyPreview } from '../components/TwistyPreview';
import { formatCountdown, useNow, useStoredState } from '../components/live/hooks';
import { TimerArea, useLiveTimer } from '../components/live/LiveTimer';
import { EventPicker, Notice, ScrambleText, Segmented } from '../components/live/ui';
import { DailyBoard } from '../components/live/daily/DailyBoard';
import { uuid } from '../timer/storeUtils';
import type { TimerResult } from '../timer/useTimerEngine';
import '../components/live/live.css';
import '../components/live/daily/daily.css';

const ATTEMPTS = 5;
const PRACTICE_KEY = 'cubr.daily.practice';

interface Attempt {
  index: number;
  timeMs: number;
  penalty: Penalty;
  /** saved = on the server; saving = in flight; failed = needs retry; practice = guest, local only */
  state: 'saved' | 'saving' | 'failed' | 'practice';
  error?: string;
}

type PracticeStore = Record<string, Attempt[]>;

function loadPractice(): PracticeStore {
  try {
    const raw = JSON.parse(localStorage.getItem(PRACTICE_KEY) ?? '{}') as PracticeStore;
    // keep only the last 8 days
    const cutoff = utcDateKey(new Date(Date.now() - 8 * 86_400_000));
    return Object.fromEntries(Object.entries(raw).filter(([k]) => k.slice(0, 10) >= cutoff));
  } catch {
    return {};
  }
}
function savePractice(p: PracticeStore): void {
  try {
    localStorage.setItem(PRACTICE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function dayLabel(date: string, today: string): string {
  if (date === today) return 'today';
  const d = new Date(`${date}T00:00:00Z`);
  const diff = Math.round((new Date(`${today}T00:00:00Z`).getTime() - d.getTime()) / 86_400_000);
  if (diff === 1) return 'yesterday';
  return `${['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getUTCDay()]} ${d.getUTCDate()}`;
}

/** Session for the solve-service fallback path (store unavailable): first session of the event. */
const directSessions = new Map<string, string>();
async function directSessionId(event: string): Promise<string> {
  const cached = directSessions.get(event);
  if (cached) return cached;
  const { sessions } = await api.sessions.list();
  let s = sessions.find((x) => x.event === event);
  if (!s) s = (await api.sessions.create({ id: uuid(), name: getEvent(event)?.short ?? event, event })).session;
  directSessions.set(event, s.id);
  return s.id;
}

/** Submit through the solve store (optimistic + retry queue); fall back to the API directly. */
async function submitDaily(event: string, date: string, index: number, r: TimerResult, scramble: string): Promise<void> {
  const body = { timeMs: r.timeMs, penalty: r.penalty, scramble, source: 'daily' as const, daily: { date, index } };
  if (solveStore.get().mode === 'cloud') {
    try {
      const session = await ensureSession(event, { counts: true });
      await addSolve({ ...body, sessionId: session.id });
      return;
    } catch (e) {
      if (e instanceof ApiError) throw e; // a real server answer - don't double-submit
      // store not ready / not implemented -> direct API below
    }
  }
  await api.solves.create({ id: uuid(), sessionId: await directSessionId(event), ...body });
}

function ao5Of(attempts: Attempt[]): number | null {
  if (attempts.length < ATTEMPTS) return null;
  return averageOfN(attempts.map(effectiveMs), ATTEMPTS);
}

export default function DailyPage() {
  const { user, status } = useAuth();
  const settings = useSettings();
  const now = useNow(1000);
  const today = utcDateKey(new Date(now));
  const [date, setDate] = useState(today);
  const [event, setEvent] = useStoredState<string>('cubr.daily.event', '333');
  const [local, setLocal] = useState<Record<string, Attempt[]>>({});
  const [practice, setPractice] = useState<PracticeStore>(loadPractice);
  const [boardKey, setBoardKey] = useState(0);
  const [me, setMe] = useState<{ rank: number; valueMs: number; total: number } | null>(null);
  const [ranking, setRanking] = useState(false);
  const authed = status === 'authed' && !!user;
  const isToday = date === today;
  const key = `${date}|${event}`;
  const ev = getEvent(event) ?? getEvent('333')!;

  // follow the UTC rollover while looking at "today"
  const prevToday = useRef(today);
  useEffect(() => {
    if (prevToday.current !== today) {
      if (date === prevToday.current) setDate(today);
      prevToday.current = today;
    }
  }, [today, date]);

  const scr = useAsync(() => api.scrambles.daily(date), [date]);
  const progress = useAsync(() => (authed ? api.solves.daily(date) : Promise.resolve(null)), [date, authed, user?.id]);

  const scrambles: string[] | null = scr.data && scr.data.date === date ? (scr.data.events?.[event] ?? null) : null;

  // merge: server progress (source of truth) + optimistic local attempts
  const attempts: Attempt[] = useMemo(() => {
    if (!authed) return (practice[key] ?? []).slice().sort((a, b) => a.index - b.index);
    const byIndex = new Map<number, Attempt>();
    const server = progress.data?.events?.[event]?.solves ?? [];
    for (const s of server) {
      const idx = typeof s.dailyIndex === 'number' ? s.dailyIndex : null;
      if (idx !== null && idx >= 0 && idx < ATTEMPTS && (s.dailyDate ?? date) === date) byIndex.set(idx, { index: idx, timeMs: s.timeMs, penalty: s.penalty, state: 'saved' });
    }
    for (const a of local[key] ?? []) if (!byIndex.has(a.index) || a.state !== 'saved') byIndex.set(a.index, byIndex.get(a.index)?.state === 'saved' ? byIndex.get(a.index)! : a);
    return [...byIndex.values()].sort((a, b) => a.index - b.index);
  }, [authed, practice, key, progress.data, event, date, local]);

  const nextIndex = useMemo(() => {
    for (let i = 0; i < ATTEMPTS; i++) if (!attempts.some((a) => a.index === i)) return i;
    return null;
  }, [attempts]);
  const done = nextIndex === null;
  const progressReady = !authed || (!!progress.data && !progress.error);
  const canStart = isToday && !!scrambles && progressReady && !done;
  const scramble = scrambles && nextIndex !== null ? scrambles[nextIndex] ?? null : null;

  const setLocalAttempt = useCallback((k: string, a: Attempt) => {
    setLocal((m) => ({ ...m, [k]: [...(m[k] ?? []).filter((x) => x.index !== a.index), a] }));
  }, []);

  const send = useCallback(
    (k: string, ev2: string, d: string, a: Attempt, scr2: string) => {
      setLocalAttempt(k, { ...a, state: 'saving', error: undefined });
      submitDaily(ev2, d, a.index, { timeMs: a.timeMs, penalty: a.penalty }, scr2)
        .then(() => {
          setLocalAttempt(k, { ...a, state: 'saved' });
          if (a.index === ATTEMPTS - 1) {
            // the board is updated asynchronously from the daily.completed event
            setRanking(true);
            [1500, 4000, 9000].forEach((ms) => setTimeout(() => setBoardKey((x) => x + 1), ms));
            setTimeout(() => setRanking(false), 10_000);
          }
        })
        .catch((e: Error) => {
          if (e instanceof ApiError && e.status === 409) {
            // already submitted (e.g. from another tab) - the server copy wins
            progress.reload();
            setLocal((m) => ({ ...m, [k]: (m[k] ?? []).filter((x) => x.index !== a.index) }));
            toast.notice(`attempt ${a.index + 1} was already submitted`);
            return;
          }
          setLocalAttempt(k, { ...a, state: 'failed', error: e.message });
          toast.error(`attempt ${a.index + 1} not saved: ${e.message}`);
        });
    },
    [setLocalAttempt, progress],
  );

  const onSolve = (r: TimerResult) => {
    if (nextIndex === null || !scramble) return;
    const a: Attempt = { index: nextIndex, timeMs: r.timeMs, penalty: r.penalty, state: authed ? 'saving' : 'practice' };
    if (!authed) {
      setPractice((p) => {
        const next = { ...p, [key]: [...(p[key] ?? []).filter((x) => x.index !== a.index), a] };
        savePractice(next);
        return next;
      });
      return;
    }
    send(key, event, date, a, scramble);
  };

  const engine = useLiveTimer({ canStart, inspection: settings.inspection && ev.inspection, onSolve });
  const { cancel, clearResult } = engine;
  useEffect(() => {
    cancel();
    clearResult();
    setMe(null);
  }, [event, date, cancel, clearResult]);

  const retry = (a: Attempt) => scrambles && send(key, event, date, a, scrambles[a.index] ?? '');

  const resetPractice = () => {
    setPractice((p) => {
      const next = { ...p };
      delete next[key];
      savePractice(next);
      return next;
    });
    clearResult();
  };

  useRegisterCommands(
    'daily',
    () => [
      {
        id: 'daily-event',
        label: 'Daily challenge event...',
        icon: <CalendarDaysIcon />,
        children: () => DAILY_EVENTS.map((id) => ({ id: `daily-event-${id}`, label: getEvent(id)?.name ?? id, active: id === event, run: () => setEvent(id) })),
      },
    ],
    [event],
  );

  // countdown to the next UTC midnight
  const d = new Date(now);
  const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const days = Array.from({ length: 7 }, (_, i) => utcDateKey(new Date(Date.parse(`${today}T12:00:00Z`) - i * 86_400_000)));

  const ao5 = ao5Of(attempts);
  const finite = attempts.map(effectiveMs).filter((t) => Number.isFinite(t));
  const best = finite.length ? Math.min(...finite) : null;
  const effs = attempts.map(effectiveMs);
  const bestIdx = done ? effs.indexOf(Math.min(...effs)) : -1;
  const worstIdx = done ? effs.lastIndexOf(Math.max(...effs)) : -1;
  const mean = finite.length === ATTEMPTS ? Math.round(finite.reduce((x, y) => x + y, 0) / ATTEMPTS) : null;

  const scrError = scr.error && !scrambles;
  const unavailable = scr.error instanceof ApiError && scr.error.isUnavailable;

  return (
    <div className="stack lg daily-page live-page">
      <div className="live-head fade-on-focus">
        <div className="titles">
          <h1 className="h2">
            <CalendarDaysIcon /> daily challenge
          </h1>
          <div className="subtitle">5 scrambles - the same for everyone - ranked by ao5 - resets at 00:00 UTC</div>
        </div>
        <div className="daily-countdown" title={`next challenge at ${new Date(nextMidnight).toLocaleString()}`}>
          <span className="label">next challenge in</span>
          <span className="value mono-nums">{formatCountdown(nextMidnight - now)}</span>
        </div>
      </div>

      <div className="daily-config fade-on-focus">
        <EventPicker events={DAILY_EVENTS} value={event} onChange={setEvent} />
        <Segmented label="day" className="scroll" value={date} onChange={setDate} options={days.map((k) => ({ value: k, label: dayLabel(k, today), tip: k }))} />
      </div>

      {!authed && status !== 'loading' && isToday && (
        <Notice
          icon={<ArrowRightEndOnRectangleIcon />}
          action={
            <Link to="/login?next=/daily" className="btn small">
              sign in
            </Link>
          }
        >
          practice mode - sign in to submit your times to today's leaderboard.
        </Notice>
      )}

      <div className="daily-layout">
        <div className="daily-main">
          {!isToday && (
            <div className="daily-past sub small fade-on-focus">
              viewing {date} (UTC) - past challenges are closed, leaderboard only.
            </div>
          )}

          <ol className="daily-strip fade-on-focus" aria-label="attempts">
            {Array.from({ length: ATTEMPTS }, (_, i) => {
              const a = attempts.find((x) => x.index === i);
              const current = isToday && i === nextIndex;
              const paren = done && (i === bestIdx || i === worstIdx);
              return (
                <li key={i} className={`${current ? 'current' : ''}${a ? ' filled' : ''}${a?.state === 'failed' ? ' failed' : ''}`}>
                  <span className="n">{i + 1}</span>
                  <span className={`t${a?.penalty === 'DNF' ? ' dnf' : ''}`}>
                    {a ? (
                      <>
                        {paren ? '(' : ''}
                        {formatSolve(a.timeMs, a.penalty, settings.precision)}
                        {paren ? ')' : ''}
                      </>
                    ) : current ? (
                      'now'
                    ) : (
                      '-'
                    )}
                  </span>
                  <span className="s">
                    {a?.state === 'saving' && <Spinner size={12} />}
                    {a?.state === 'failed' && (
                      <button className="btn-text" onClick={() => retry(a)} aria-label="retry" data-tip={a.error ?? 'retry'}>
                        <ArrowUturnLeftIcon width={12} height={12} />
                      </button>
                    )}
                    {a?.state === 'failed' && <SignalSlashIcon width={12} height={12} />}
                  </span>
                </li>
              );
            })}
          </ol>

          {authed && progress.error && (
            <ErrorState error={new Error(`couldn't load your progress (${progress.error.message}) - retry before solving`)} onRetry={progress.reload} />
          )}

          {scrError ? (
            <ErrorState
              error={new Error(unavailable ? 'the scramble service is unavailable - the daily challenge needs its official scrambles' : scr.error!.message)}
              onRetry={scr.reload}
            />
          ) : !scrambles ? (
            scr.loading ? (
              <Loading label="loading scrambles..." />
            ) : (
              <div className="empty">no daily scrambles for {ev.name} on this day.</div>
            )
          ) : done ? (
            <div className="daily-result">
              <div className="stat lg">
                <span className="label">ao5</span>
                <span className="value">{formatTime(ao5, settings.precision)}</span>
              </div>
              <div className="daily-result-stats">
                <div className="stat">
                  <span className="label">mean</span>
                  <span className="value text">{formatTime(mean, settings.precision)}</span>
                </div>
                <div className="stat">
                  <span className="label">best</span>
                  <span className="value text">{formatTime(best, settings.precision)}</span>
                </div>
                {authed ? (
                  <div className="stat">
                    <span className="label">rank {isToday ? 'today' : ''}</span>
                    <span className={`value ${me ? '' : 'text small-value'}`}>
                      {me ? `#${me.rank}` : !attempts.every((a) => a.state === 'saved') ? 'saving...' : ranking ? 'ranking...' : 'unranked'}
                    </span>
                    {me && <span className="hint">of {me.total.toLocaleString('en-US')}</span>}
                    {!me && !ranking && attempts.every((a) => a.state === 'saved') && <span className="hint">not on the board (yet)</span>}
                  </div>
                ) : (
                  <div className="stat">
                    <span className="label">mode</span>
                    <span className="value text small-value">practice</span>
                  </div>
                )}
              </div>
              {!authed && isToday && (
                <div className="row wrap" style={{ justifyContent: 'center' }}>
                  <button className="btn small" onClick={resetPractice}>
                    <ArrowUturnLeftIcon /> practise again
                  </button>
                  <Link to="/login?next=/daily" className="btn small primary">
                    <ArrowRightEndOnRectangleIcon /> sign in to compete
                  </Link>
                </div>
              )}
              {isToday && <div className="sub small center">come back in {formatCountdown(nextMidnight - now)} for new scrambles.</div>}
            </div>
          ) : isToday ? (
            <>
              <div className="daily-scramble-label fade-on-focus">
                scramble <span className="main">{(nextIndex ?? 0) + 1}</span>/{ATTEMPTS}
              </div>
              <div className="fade-on-focus">
                <ScrambleText scramble={scramble} event={event} />
              </div>
              <TimerArea engine={engine} idleDim={!canStart} />
              <div className="live-keytips fade-on-focus">
                {settings.inspection && ev.inspection ? (
                  <>
                    <kbd>space</kbd> inspect, then hold <kbd>space</kbd> to start
                  </>
                ) : (
                  <>
                    hold <kbd>space</kbd>, release to start
                  </>
                )}{' '}
                - <kbd>esc</kbd> while solving = DNF - one try per scramble
              </div>
              {settings.scramblePreview !== 'off' && scramble && (
                <div className="daily-preview fade-on-focus">
                  <TwistyPreview puzzle={ev.puzzle} scramble={scramble} visualization={settings.scramblePreview === '3D' ? '3D' : '2D'} height={160} />
                </div>
              )}
            </>
          ) : (
            <details className="daily-scrambles card">
              <summary className="sub small">show this day's scrambles</summary>
              <ol>
                {scrambles.map((s, i) => (
                  <li key={i}>
                    <span className="sub">{i + 1}.</span> {s}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>

        <aside className="daily-side fade-on-focus">
          <DailyBoard
            event={event}
            date={date}
            refreshKey={boardKey}
            userId={user?.id ?? null}
            username={user?.username ?? null}
            precision={settings.precision}
            onMe={setMe}
          />
        </aside>
      </div>
    </div>
  );
}
