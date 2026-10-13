import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChartLine,
  Copy,
  Crown,
  Eye,
  Keyboard,
  Layers,
  List,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Timer as TimerIcon,
  Trash2,
  X,
} from 'lucide-react';
import { EVENTS, effectiveMs, formatTime, getEvent, rollingAverage, sessionStats, type Penalty } from '@cubetype/cubestats';
import { TimerDisplay } from '../timer/TimerDisplay';
import { useTimerEngine, type TimerResult, type TimerState } from '../timer/useTimerEngine';
import { useScrambleQueue } from '../timer/useScrambleQueue';
import { TwistyPreview } from '../components/TwistyPreview';
import { ConfigBar } from '../components/timer/ConfigBar';
import { ScrambleBar } from '../components/timer/ScrambleBar';
import { StatsPanel } from '../components/timer/StatsPanel';
import { SolveList } from '../components/timer/SolveList';
import { SolveModal } from '../components/timer/SolveModal';
import { AverageModal } from '../components/timer/AverageModal';
import { QuickActions } from '../components/timer/QuickActions';
import { ManualEntry } from '../components/timer/ManualEntry';
import { ConfirmModal, PromptModal } from '../components/timer/Dialogs';
import { copyText, isTouchDevice, playPbSound } from '../components/timer/feedback';
import { averageWindow, detectPbs, fmtAvg, fmtSolveShort, statNs } from '../components/timer/statsUtil';
import { noFocus } from '../components/timer/ConfigBar';
import '../components/timer/timer-page.css';
import { useAuth } from '../lib/auth';
import { paletteStore, useRegisterCommands, type Command } from '../lib/commands';
import { updateSettings, useSettings } from '../lib/settings';
import {
  addSolve,
  createSession,
  deleteSession,
  deleteSolve,
  renameSession,
  setComment,
  setPenalty,
  suggestSessionName,
  switchEvent,
  switchSession,
  useSolveState,
} from '../lib/solves';
import { useStore } from '../lib/store';
import { toast } from '../lib/toast';

type ModalState =
  | { kind: 'solve'; index: number }
  | { kind: 'avg'; n: number; which: 'current' | 'best' }
  | { kind: 'newSession' }
  | { kind: 'renameSession' }
  | { kind: 'deleteSession' }
  | { kind: 'deleteLast' }
  | { kind: 'comment'; solveId: string }
  | null;

// Chart.js is only needed below the fold: keep it out of the first-paint bundle.
const TrendChart = lazy(() => import('../components/timer/Charts').then((m) => ({ default: m.TrendChart })));
const HistogramChart = lazy(() => import('../components/timer/Charts').then((m) => ({ default: m.HistogramChart })));
const chartFallback = <div className="tp-chart-fallback" />;

const GUEST_HINT_KEY = 'cubetype.guestHintDismissed';
const PB_KINDS_NS = [5, 12, 100];

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export default function TimerPage() {
  const settings = useSettings();
  const st = useSolveState();
  const { status: authStatus } = useAuth();
  const paletteOpen = useStore(paletteStore, (s) => s.open);

  const session = st.sessions.find((s) => s.id === st.currentSessionId) ?? null;
  const event = session?.event ?? settings.lastEvent;
  const eventInfo = getEvent(event) ?? EVENTS[0];
  const scr = useScrambleQueue(event);

  const [manual, setManual] = useState(false);
  const [editingScramble, setEditingScramble] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [pbSolveId, setPbSolveId] = useState<string | null>(null);
  const [pbKey, setPbKey] = useState(0);
  const [guestHintHidden, setGuestHintHidden] = useState(() => {
    try {
      return localStorage.getItem(GUEST_HINT_KEY) === '1';
    } catch {
      return false;
    }
  });
  const touch = useMemo(isTouchDevice, []);

  // ---------------------------------------------------------------- derived stats (memoised per solve change)
  // The timer display reads the live list; the heavier panels (stats, list, charts, preview) read
  // a deferred copy so the final time paints immediately even with 10k+ solves in a session.
  const liveSolves = st.solves;
  const last = liveSolves.length ? liveSolves[liveSolves.length - 1] : null;
  const solves = useDeferredValue(liveSolves);
  const statsKey = settings.statsShown.join(',');
  const ns = useMemo(() => statNs(settings.statsShown), [statsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const nsAll = useMemo(() => Array.from(new Set([...ns, ...PB_KINDS_NS])).sort((a, b) => a - b), [ns]);
  const stats = useMemo(() => sessionStats(solves, nsAll), [solves, nsAll]);
  const times = useMemo(() => solves.map(effectiveMs), [solves]);
  const ao5 = useMemo(() => rollingAverage(times, 5), [times]);
  const ao12 = useMemo(() => rollingAverage(times, 12), [times]);

  // ---------------------------------------------------------------- refs for stable callbacks
  const scrRef = useRef(scr);
  scrRef.current = scr;
  const lastRef = useRef(last);
  lastRef.current = last;
  const pendingPb = useRef(false);
  const lastStopAt = useRef(0);

  // ---------------------------------------------------------------- recording solves
  const record = useCallback((r: { timeMs: number; penalty: Penalty }, source: 'timer' | 'manual') => {
    const scramble = scrRef.current.current?.text ?? '';
    pendingPb.current = true;
    addSolve({ timeMs: r.timeMs, penalty: r.penalty, scramble, source }).catch((e: Error) => {
      pendingPb.current = false;
      toast.error(e.message || "couldn't save the solve");
    });
    scrRef.current.next();
  }, []);

  const onSolve = useCallback(
    (r: TimerResult) => {
      lastStopAt.current = performance.now();
      record(r, 'timer');
    },
    [record],
  );

  const engineEnabled = !manual && !editingScramble && !overlay && modal === null && !paletteOpen;
  const engine = useTimerEngine({
    enabled: engineEnabled,
    // WCA inspection only applies to events that have it (not blindfolded, not FMC)
    inspection: settings.inspection && eventInfo.inspection,
    holdMs: settings.holdMs,
    alerts: settings.inspectionAlerts,
    onSolve,
  });
  const { phase, inInspection } = engine.state;
  const { clearResult, cancel: cancelEngine } = engine;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // PB detection: compare the stats before and after a solve recorded on this page
  const prevStats = useRef<{ sid: string | null; stats: typeof stats } | null>(null);
  useEffect(() => {
    const prev = prevStats.current;
    prevStats.current = { sid: st.currentSessionId, stats };
    if (!pendingPb.current) return;
    if (!prev || prev.sid !== st.currentSessionId || stats.count !== prev.stats.count + 1) return;
    pendingPb.current = false;
    const pbs = detectPbs(prev.stats, stats);
    const newest = solves[solves.length - 1];
    if (!pbs.length || !newest) return;
    const text = pbs.map((p) => `${p.kind} ${p.kind === 'single' ? formatTime(p.value, settings.precision) : fmtAvg(p.value, settings.precision)}`).join(' · ');
    toast.pb(`new pb! ${text}`);
    setPbSolveId(newest.id);
    setPbKey((k) => k + 1);
    if (settings.pbSound) playPbSound();
  }, [stats]); // eslint-disable-line react-hooks/exhaustive-deps

  // focus mode: fade everything but the timer while inspecting / solving
  useEffect(() => {
    const active = settings.focusMode && (phase === 'running' || phase === 'inspecting' || (inInspection && (phase === 'holding' || phase === 'ready')));
    document.body.classList.toggle('focus', active);
  }, [phase, inInspection, settings.focusMode]);
  useEffect(() => () => document.body.classList.remove('focus'), []);

  // leaving manual mode / opening things: never keep a stale engine result around
  useEffect(() => {
    if (manual) cancelEngine();
  }, [manual, cancelEngine]);

  // ---------------------------------------------------------------- actions on the latest solve
  const penaltyLast = useCallback((p: Penalty) => {
    const l = lastRef.current;
    if (l) void setPenalty(l.id, p);
  }, []);

  const doDeleteLast = useCallback(() => {
    const l = lastRef.current;
    if (!l) return;
    void deleteSolve(l.id);
    clearResult();
    toast.notice(`deleted ${fmtSolveShort(l, settings.precision)}`, { durationMs: 1500 });
  }, [clearResult, settings.precision]);

  const deleteLast = useCallback(() => {
    if (!lastRef.current) return;
    if (settings.confirmDelete) setModal({ kind: 'deleteLast' });
    else doDeleteLast();
  }, [settings.confirmDelete, doDeleteLast]);

  const commentLast = useCallback(() => {
    const l = lastRef.current;
    if (l) setModal({ kind: 'comment', solveId: l.id });
  }, []);

  const copyScramble = useCallback(async () => {
    const t = scrRef.current.current?.text;
    if (t && (await copyText(t))) toast.success('scramble copied', { durationMs: 1500 });
  }, []);

  const cycleSession = useCallback(
    (dir: 1 | -1) => {
      const list = st.sessions.filter((s) => s.event === event);
      if (list.length < 2 || !session) return;
      const i = list.findIndex((s) => s.id === session.id);
      void switchSession(list[(i + dir + list.length) % list.length].id);
    },
    [st.sessions, event, session],
  );

  const changeEvent = useCallback((ev: string) => {
    setEditingScramble(false);
    void switchEvent(ev).catch((e: Error) => toast.error(e.message));
  }, []);

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    // Space must never activate a focused button on this page: drop focus before it lands
    const guardSpace = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const a = document.activeElement as HTMLElement | null;
      if (!a || a === document.body || isTyping(a) || a.closest('.modal-backdrop')) return;
      if (a.tagName === 'BUTTON' || a.tagName === 'A' || a.getAttribute('role') === 'button') a.blur();
    };
    // a touch that stopped the timer must not also "click" whatever appears under the finger
    const guardClick = (e: MouseEvent) => {
      if (performance.now() - lastStopAt.current < 450) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', guardSpace, true);
    window.addEventListener('keyup', guardSpace, true);
    window.addEventListener('click', guardClick, true);
    return () => {
      window.removeEventListener('keydown', guardSpace, true);
      window.removeEventListener('keyup', guardSpace, true);
      window.removeEventListener('click', guardClick, true);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || paletteStore.get().open || document.querySelector('.modal-backdrop')) return;
      const p = phaseRef.current;
      if (p !== 'idle' && p !== 'stopped') return;
      const inManualInput = e.target instanceof HTMLElement && e.target.hasAttribute('data-manual-entry');
      if (isTyping(e.target) && !(inManualInput && e.altKey)) return;
      if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        scrRef.current.next();
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const actions: Record<string, () => void> = {
        Digit1: () => penaltyLast('OK'),
        Digit2: () => penaltyLast('+2'),
        Digit3: () => penaltyLast('DNF'),
        Backspace: deleteLast,
        KeyZ: deleteLast,
        KeyC: commentLast,
        ArrowLeft: () => scrRef.current.prev(),
        ArrowRight: () => scrRef.current.next(),
        ArrowUp: () => cycleSession(-1),
        ArrowDown: () => cycleSession(1),
        KeyI: () => updateSettings({ inspection: !settings.inspection }),
        KeyM: () => setManual((m) => !m),
      };
      const fn = actions[e.code];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [penaltyLast, deleteLast, commentLast, cycleSession, settings.inspection]);

  // ---------------------------------------------------------------- palette commands
  useRegisterCommands(
    'timer',
    () => {
      const eventSessions = st.sessions.filter((s) => s.event === event);
      const cmds: Command[] = [
        {
          id: 'timer-event',
          label: 'Event…',
          icon: <TimerIcon />,
          keywords: ['puzzle', 'cube'],
          children: () =>
            EVENTS.map((e) => ({
              id: `timer-event-${e.id}`,
              label: `${e.short.toLowerCase()} — ${e.name}`,
              keywords: [e.id],
              active: e.id === event,
              run: () => changeEvent(e.id),
            })),
        },
        {
          id: 'timer-session',
          label: 'Session…',
          icon: <Layers />,
          children: () =>
            eventSessions.map((s) => ({
              id: `timer-session-${s.id}`,
              label: `${s.name} (${s.solveCount})`,
              active: s.id === session?.id,
              run: () => void switchSession(s.id),
            })),
        },
        { id: 'timer-new-session', label: 'New session', icon: <Plus />, run: () => setModal({ kind: 'newSession' }) },
        { id: 'timer-rename-session', label: 'Rename session', icon: <Pencil />, run: () => setModal({ kind: 'renameSession' }) },
        { id: 'timer-delete-session', label: 'Delete session', icon: <Trash2 />, run: () => setModal({ kind: 'deleteSession' }) },
        { id: 'timer-new-scramble', label: 'New scramble', icon: <RefreshCw />, keywords: ['next'], run: () => scrRef.current.next() },
        { id: 'timer-custom-scramble', label: 'Enter custom scramble', icon: <Pencil />, keywords: ['edit'], run: () => setEditingScramble(true) },
        { id: 'timer-copy-scramble', label: 'Copy scramble', icon: <Copy />, run: () => void copyScramble() },
      ];
      if (last) {
        cmds.push(
          {
            id: 'timer-penalty',
            label: 'Penalty last solve…',
            icon: <TimerIcon />,
            keywords: ['dnf', '+2', 'ok'],
            children: () =>
              (['OK', '+2', 'DNF'] as Penalty[]).map((p) => ({
                id: `timer-penalty-${p}`,
                label: p === 'OK' ? 'no penalty' : p,
                active: last.penalty === p,
                run: () => penaltyLast(p),
              })),
          },
          { id: 'timer-comment-last', label: 'Comment last solve', icon: <MessageSquare />, run: commentLast },
          { id: 'timer-delete-last', label: 'Delete last solve', icon: <Trash2 />, run: deleteLast },
        );
      }
      cmds.push(
        { id: 'timer-toggle-charts', label: settings.showCharts ? 'Hide charts' : 'Show charts', icon: <ChartLine />, keywords: ['toggle'], run: () => updateSettings({ showCharts: !settings.showCharts }) },
        { id: 'timer-toggle-list', label: settings.showSolveList ? 'Hide solve list' : 'Show solve list', icon: <List />, keywords: ['toggle'], run: () => updateSettings({ showSolveList: !settings.showSolveList }) },
        { id: 'timer-manual', label: manual ? 'Use the timer (leave manual entry)' : 'Manual entry (type times)', icon: <Keyboard />, keywords: ['typing', 'toggle'], run: () => setManual((m) => !m) },
        { id: 'timer-inspection-toggle', label: settings.inspection ? 'Turn inspection off' : 'Turn inspection on', icon: <Eye />, keywords: ['toggle', 'wca'], run: () => updateSettings({ inspection: !settings.inspection }) },
      );
      return cmds;
    },
    [st.sessions, event, session?.id, last?.id, last?.penalty, settings.showCharts, settings.showSolveList, settings.inspection, manual, deleteLast],
  );


  // ---------------------------------------------------------------- display
  // idle: show the latest solve of this session (with its current penalty), like csTimer
  const displayState: TimerState = useMemo(() => {
    const s = engine.state;
    if (s.phase === 'idle' || (s.phase === 'holding' && !s.inInspection)) {
      return { ...s, result: last ? { timeMs: last.timeMs, penalty: last.penalty } : null };
    }
    return s;
  }, [engine.state, last]);

  const openSolve = useCallback((index: number) => setModal({ kind: 'solve', index }), []);
  const openAverage = useCallback((n: number, which: 'current' | 'best') => setModal({ kind: 'avg', n, which }), []);
  const onOverlayChange = useCallback((open: boolean) => setOverlay(open), []);

  const avgModal = useMemo(() => {
    if (modal?.kind !== 'avg') return null;
    const key = modal.n === 3 ? 'mo3' : `ao${modal.n}`;
    const line = stats.averages[key] ?? sessionStats(solves, [modal.n]).averages[key];
    if (!line) return null;
    const end = modal.which === 'best' ? line.bestIndex : solves.length - 1;
    const value = modal.which === 'best' ? line.best : line.current;
    if (end === null || value === null || end < modal.n - 1) return null;
    return { label: `${modal.which} ${key}`, window: averageWindow(solves, end, modal.n, value) };
  }, [modal, stats, solves]);

  const showPreview = settings.scramblePreview !== 'off';
  const previewScramble = useDeferredValue(scr.current?.text ?? null);
  const cols = 1 + (showPreview ? 1 : 0) + (settings.showSolveList ? 1 : 0);
  const pb = !!last && last.id === pbSolveId;
  const pbKinds = pb ? 'new pb' : null;
  const guest = st.mode === 'local' && authStatus === 'guest' && !guestHintHidden;
  const isIdle = phase === 'idle' || phase === 'stopped';

  return (
    <div className="timer-page">
      <ConfigBar
        event={event}
        sessions={st.sessions}
        currentSessionId={st.currentSessionId}
        onEvent={changeEvent}
        onSession={(id) => void switchSession(id)}
        onNewSession={() => setModal({ kind: 'newSession' })}
        onRenameSession={() => setModal({ kind: 'renameSession' })}
        onDeleteSession={() => setModal({ kind: 'deleteSession' })}
        inspection={settings.inspection}
        onToggleInspection={() => updateSettings({ inspection: !settings.inspection })}
        manual={manual}
        onToggleManual={() => setManual((m) => !m)}
        onOverlayChange={onOverlayChange}
        mode={st.mode}
        pending={st.pending}
        syncError={st.syncError}
      />

      <ScrambleBar
        scramble={scr.current}
        onNext={scr.next}
        onPrev={scr.prev}
        hasPrev={scr.hasPrev}
        onCustom={scr.setCustom}
        editing={editingScramble}
        setEditing={setEditingScramble}
      />

      <div className="tp-timer-area" {...(manual ? {} : engine.touchHandlers)} aria-label={touch ? 'timer: hold to get ready, release to start' : 'timer'}>
        {manual ? (
          <ManualEntry onSubmit={(r) => record(r, 'manual')} disabled={modal !== null || paletteOpen} />
        ) : (
          <div key={pbKey}>
            <TimerDisplay state={displayState} precision={settings.precision} timerUpdate={settings.timerUpdate} sizeRem={settings.timerSize} pb={pb && isIdle} />
          </div>
        )}
      </div>

      <div className="tp-under fade-on-focus">
        {solves.length === 0 && !manual && st.ready ? (
          <div className="tp-hint">
            {touch ? (
              'hold the timer, release to start · tap anywhere to stop'
            ) : settings.inspection && eventInfo.inspection ? (
              <>
                press <kbd>space</kbd> to start inspection
              </>
            ) : (
              <>
                hold <kbd>space</kbd> until the time turns green, release to start
              </>
            )}
          </div>
        ) : (
          <div className="tp-avgline">
            {pbKinds && (
              <span className="pb-badge">
                <Crown size={14} /> {pbKinds}
              </span>
            )}
            <span>
              ao5<b>{fmtAvg(stats.averages.ao5?.current, settings.precision)}</b>
            </span>
            <span>
              ao12<b>{fmtAvg(stats.averages.ao12?.current, settings.precision)}</b>
            </span>
          </div>
        )}
        <QuickActions last={last} onPenalty={penaltyLast} onComment={commentLast} onDelete={deleteLast} />
      </div>

      <div className={`tp-bottom fade-on-focus cols-${cols}`}>
        <StatsPanel stats={stats} ns={ns} solves={solves} precision={settings.precision} onOpenAverage={openAverage} onOpenSolve={openSolve} />
        {showPreview && (
          <section className="tp-panel tp-preview" aria-label="scramble preview">
            <div className="tp-panel-title">
              <Eye size={14} /> scramble preview
            </div>
            <div className="tp-preview-box">
              {previewScramble ? (
                <TwistyPreview puzzle={eventInfo.puzzle} scramble={previewScramble} visualization={settings.scramblePreview === '3D' ? '3D' : '2D'} height={200} />
              ) : null}
            </div>
          </section>
        )}
        {settings.showSolveList && (
          <SolveList solves={solves} ao5={ao5} ao12={ao12} bestIndex={stats.bestIndex} precision={settings.precision} loading={st.loading || !st.ready} onOpen={openSolve} />
        )}
      </div>

      {settings.showCharts ? (
        solves.length >= 2 ? (
          <div className="tp-charts fade-on-focus">
            <Suspense fallback={chartFallback}>
              <TrendChart times={times} ao5={ao5} ao12={ao12} precision={settings.precision} onOpenSolve={openSolve} />
            </Suspense>
            <Suspense fallback={chartFallback}>
              <HistogramChart times={times} latest={solves.length ? effectiveMs(solves[solves.length - 1]) : null} />
            </Suspense>
          </div>
        ) : null
      ) : (
        <div className="tp-charts-toggle fade-on-focus">
          <button className="btn-text small" onClick={() => updateSettings({ showCharts: true })} {...noFocus}>
            <ChartLine size={14} /> show charts
          </button>
        </div>
      )}

      <div className="keytips tp-keytips fade-on-focus">
        <kbd>space</kbd> start / stop · <kbd>tab</kbd> new scramble · <kbd>alt</kbd>+<kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> ok / +2 / dnf ·{' '}
        <kbd>alt</kbd>+<kbd>⌫</kbd> delete last · <kbd>esc</kbd> command line
      </div>
      {guest && (
        <div className="tp-guest fade-on-focus">
          <span>
            <Link to="/login">sign in</Link> to save solves to the cloud, appear on leaderboards and race
          </span>
          <button
            className="btn-text"
            aria-label="dismiss"
            onClick={() => {
              setGuestHintHidden(true);
              try {
                localStorage.setItem(GUEST_HINT_KEY, '1');
              } catch {
                /* ignore */
              }
            }}
            {...noFocus}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------ modals */}
      {modal?.kind === 'solve' && solves[modal.index] && (
        <SolveModal
          solve={solves[modal.index]}
          index={modal.index}
          total={solves.length}
          precision={settings.precision}
          preview={settings.scramblePreview}
          confirmDelete={settings.confirmDelete}
          onNavigate={(i) => i >= 0 && i < solves.length && setModal({ kind: 'solve', index: i })}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'avg' && avgModal && (
        <AverageModal label={avgModal.label} window={avgModal.window} precision={settings.precision} onOpenSolve={openSolve} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'newSession' && (
        <PromptModal
          title="new session"
          label={`name · ${eventInfo.short.toLowerCase()}`}
          initial={suggestSessionName(event)}
          confirmLabel="create"
          onSubmit={async (name) => {
            const s = await createSession(name, event);
            await switchSession(s.id);
          }}
          validate={(v) => (v.trim().length < 1 ? 'give it a name' : null)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'renameSession' && session && (
        <PromptModal
          title="rename session"
          label="name"
          initial={session.name}
          onSubmit={(name) => renameSession(session.id, name)}
          validate={(v) => (v.trim().length < 1 ? 'give it a name' : null)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'deleteSession' && session && (
        <ConfirmModal
          title="delete session"
          message={
            <>
              Delete <span className="main">{session.name}</span>
              {session.solveCount > 0 ? ` and its ${session.solveCount} solve${session.solveCount === 1 ? '' : 's'}` : ''}? This can't be undone.
            </>
          }
          confirmLabel="delete session"
          onConfirm={() => deleteSession(session.id)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'deleteLast' && last && (
        <ConfirmModal
          title="delete solve"
          message={
            <>
              Delete your last solve (<span className="main">{fmtSolveShort(last, settings.precision)}</span>)?
            </>
          }
          confirmLabel="delete"
          onConfirm={doDeleteLast}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'comment' && (
        <PromptModal
          title="comment"
          label={`solve ${solves.findIndex((s) => s.id === modal.solveId) + 1}`}
          initial={solves.find((s) => s.id === modal.solveId)?.comment ?? ''}
          placeholder="pll skip, lockup on f2l, …"
          maxLength={500}
          onSubmit={(c) => setComment(modal.solveId, c || null)}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
