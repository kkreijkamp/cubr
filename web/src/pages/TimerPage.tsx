import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowPathIcon,
  ArrowsPointingInIcon,
  BeakerIcon,
  ChatBubbleLeftIcon,
  ClockIcon,
  CommandLineIcon,
  EyeIcon,
  ListBulletIcon,
  PencilIcon,
  PlusIcon,
  Square2StackIcon,
  Square3Stack3DIcon,
  TrashIcon,
  TrophyIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { EVENTS, effectiveMs, formatTime, getEvent, rollingAverage, sessionStats, type Penalty } from '@cubr/cubestats';
import { TimerDisplay } from '../timer/TimerDisplay';
import { useTimerEngine, type TimerResult, type TimerState } from '../timer/useTimerEngine';
import { useScrambleQueue } from '../timer/useScrambleQueue';
import { shortcutFor, type ShortcutAction } from '../timer/shortcuts';
import { TwistyPreview } from '../components/TwistyPreview';
import { ConfigBar } from '../components/timer/ConfigBar';
import { ScrambleBar } from '../components/timer/ScrambleBar';
import { StatsPanel } from '../components/timer/StatsPanel';
import { SolveList } from '../components/timer/SolveList';
import { SolveModal } from '../components/timer/SolveModal';
import { AverageModal } from '../components/timer/AverageModal';
import { QuickActions } from '../components/timer/QuickActions';
import { ManualEntry } from '../components/timer/ManualEntry';
import { VirtualInput } from '../components/timer/inputs/VirtualInput';
import { StackmatInput } from '../components/timer/inputs/StackmatInput';
import { BtTimerInput } from '../components/timer/inputs/BtTimerInput';
import { SmartCubeInput } from '../components/timer/inputs/SmartCubeInput';
import type { ScrambleHint } from '../input/bluetooth/smartSession';
import { AVAILABLE_INPUTS, INPUT_MODES, modeInfo, updateInput, useInputState, type InputMode } from '../input/inputMode';
import { ConfirmModal, PromptModal } from '../components/timer/Dialogs';
import { MergeSessionsModal } from '../components/timer/MergeSessionsModal';
import { copyText, isTouchDevice, playPbSound } from '../components/timer/feedback';
import { averageWindow, detectPbs, fmtAvg, fmtSolveShort, pbFlags, statNs } from '../components/timer/statsUtil';
import { noFocus } from '../components/timer/ConfigBar';
import '../components/timer/timer-page.css';
import { useAuth } from '../lib/auth';
import { paletteStore, useRegisterCommands, type Command } from '../lib/commands';
import { updateSettings, useSettings } from '../lib/settings';
import {
  addSolve,
  clearSession,
  createSession,
  deleteSession,
  deleteSolve,
  renameSession,
  setComment,
  setPenalty,
  setSessionPractice,
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
  | { kind: 'clearSession' }
  | { kind: 'mergeSessions' }
  | { kind: 'deleteLast' }
  | { kind: 'comment'; solveId: string }
  | null;

const GUEST_HINT_KEY = 'cubr.guestHintDismissed';
const IDLE: TimerState = { phase: 'idle', inInspection: false, startedAt: null, inspectionStartedAt: null, result: null };
const AVAILABLE = AVAILABLE_INPUTS;
const PB_KINDS_NS = [5, 12, 100];

/**
 * The scramble preview is drawn as tall as its box: on wide screens the bottom panels share the
 * height left under the timer, so the page fits the window without scrolling.
 */
function usePreviewHeight(ref: RefObject<HTMLDivElement>, on: boolean): number {
  const [h, setH] = useState(200);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const inner = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      // whole pixels, and only real changes, so the preview never resizes in a loop
      setH((prev) => {
        const next = Math.max(110, Math.min(320, Math.floor(inner)));
        return Math.abs(next - prev) >= 2 ? next : prev;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, on]);
  return h;
}

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export default function TimerPage() {
  const settings = useSettings();
  const st = useSolveState();
  const { status: authStatus, user } = useAuth();
  const paletteOpen = useStore(paletteStore, (s) => s.open);

  const session = st.sessions.find((s) => s.id === st.currentSessionId) ?? null;
  const event = session?.event ?? settings.lastEvent;
  const eventInfo = getEvent(event) ?? EVENTS[0];
  const scr = useScrambleQueue(event);

  const device = useInputState();
  const input: InputMode = AVAILABLE.includes(device.mode) ? device.mode : 'timer';
  const manual = input === 'typing';
  const setInput = useCallback((mode: InputMode) => updateInput({ mode }), []);
  /** what a timer other than the keyboard one is doing (virtual puzzle, stackmat, ...) */
  const [altState, setAltState] = useState<TimerState>(IDLE);
  /** a smart cube's progress along the scramble */
  const [smartHint, setSmartHint] = useState<ScrambleHint | null>(null);
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
  // every session pb as it was set, for the solve list
  const pbs = useMemo(() => ({ single: pbFlags(times), ao5: pbFlags(ao5), ao12: pbFlags(ao12) }), [times, ao5, ao12]);

  // ---------------------------------------------------------------- refs for stable callbacks
  const scrRef = useRef(scr);
  scrRef.current = scr;
  const lastRef = useRef(last);
  lastRef.current = last;
  const pendingPb = useRef(false);
  const lastStopAt = useRef(0);

  // ---------------------------------------------------------------- recording solves
  const record = useCallback((r: { timeMs: number; penalty: Penalty }, source: 'timer' | 'manual', own?: string) => {
    const scramble = own ?? scrRef.current.current?.text ?? '';
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

  const inputsEnabled = !editingScramble && !overlay && modal === null && !paletteOpen;
  const engineEnabled = input === 'timer' && inputsEnabled;
  const engine = useTimerEngine({
    enabled: engineEnabled,
    // WCA inspection only applies to events that have it (not blindfolded, not FMC)
    inspection: settings.inspection && eventInfo.inspection,
    holdMs: settings.holdMs,
    alerts: settings.inspectionAlerts,
    onSolve,
  });
  const active = input === 'timer' ? engine.state : input === 'typing' ? IDLE : altState;
  const { phase, inInspection } = active;
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
    const text = pbs.map((p) => `${p.kind} ${p.kind === 'single' ? formatTime(p.value, settings.precision) : fmtAvg(p.value, settings.precision)}`).join(' - ');
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

  // leaving the timer for another input: never keep a stale engine result around
  useEffect(() => {
    if (input !== 'timer') cancelEngine();
    setAltState(IDLE);
  }, [input, cancelEngine]);

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
      // in the typing box, alt / ctrl+alt shortcuts and ctrl+1/2/3 still work (ctrl+z stays undo there)
      if (isTyping(e.target) && !(inManualInput && (e.altKey || (e.ctrlKey && /^Digit[123]$/.test(e.code))))) return;
      if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        scrRef.current.next();
        return;
      }
      const action = shortcutFor(e);
      if (!action) return;
      e.preventDefault();
      runShortcut(action);
    };
    const runShortcut = (a: ShortcutAction) => {
      switch (a.kind) {
        case 'event':
          if (a.event !== event) changeEvent(a.event);
          return;
        case 'penalty':
          return penaltyLast(a.penalty);
        case 'deleteLast':
          return deleteLast();
        case 'clearSession':
          if (session && session.solveCount > 0) setModal({ kind: 'clearSession' });
          return;
        case 'session':
          return cycleSession(a.dir);
        case 'scramble':
          return a.dir < 0 ? scrRef.current.prev() : scrRef.current.next();
        case 'customScramble':
          return setEditingScramble(true);
        case 'input':
          if (AVAILABLE.includes(a.input)) {
            setInput(a.input);
            toast.notice(`entering times with: ${modeInfo(a.input).label}`, { durationMs: 1500 });
          } else toast.notice(`cubr has no ${modeInfo(a.input).label} input yet`);
          return;
        case 'missingInput':
          toast.notice(`cubr has no ${a.name} input`);
          return;
        case 'comment':
          return commentLast();
        case 'inspection':
          return updateSettings({ inspection: !settings.inspection });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [penaltyLast, deleteLast, commentLast, cycleSession, changeEvent, event, session, settings.inspection, setInput]);

  // a practice session: its solves count for no pb on the profile and no leaderboard
  const togglePractice = useCallback(() => {
    if (!session) return;
    const on = !session.practice;
    void setSessionPractice(session.id, on);
    toast.notice(on ? `${session.name} is a practice session: no pbs or leaderboards` : `${session.name} counts for pbs and leaderboards again`, { durationMs: 2500 });
  }, [session]);

  // ---------------------------------------------------------------- palette commands
  useRegisterCommands(
    'timer',
    () => {
      const eventSessions = st.sessions.filter((s) => s.event === event);
      const cmds: Command[] = [
        {
          id: 'timer-event',
          label: 'Event...',
          icon: <ClockIcon />,
          keywords: ['puzzle', 'cube'],
          children: () =>
            EVENTS.map((e) => ({
              id: `timer-event-${e.id}`,
              label: `${e.short.toLowerCase()} - ${e.name}`,
              keywords: [e.id],
              active: e.id === event,
              run: () => changeEvent(e.id),
            })),
        },
        {
          id: 'timer-session',
          label: 'Session...',
          icon: <Square3Stack3DIcon />,
          children: () =>
            eventSessions.map((s) => ({
              id: `timer-session-${s.id}`,
              label: `${s.name} (${s.solveCount})`,
              active: s.id === session?.id,
              run: () => void switchSession(s.id),
            })),
        },
        { id: 'timer-new-session', label: 'New session', icon: <PlusIcon />, run: () => setModal({ kind: 'newSession' }) },
        { id: 'timer-rename-session', label: 'Rename session', icon: <PencilIcon />, run: () => setModal({ kind: 'renameSession' }) },
        {
          id: 'timer-practice-session',
          label: session?.practice ? 'Count session for pbs and leaderboards' : 'Make session a practice session',
          icon: <BeakerIcon />,
          keywords: ['practice', 'pb', 'leaderboard', 'unranked', 'casual', 'session'],
          run: togglePractice,
        },
        {
          id: 'timer-merge-sessions',
          label: 'Merge sessions...',
          icon: <ArrowsPointingInIcon />,
          keywords: ['combine', 'join', 'session'],
          run: () => setModal({ kind: 'mergeSessions' }),
        },
        { id: 'timer-delete-session', label: 'Delete session', icon: <TrashIcon />, run: () => setModal({ kind: 'deleteSession' }) },
        { id: 'timer-new-scramble', label: 'New scramble', icon: <ArrowPathIcon />, keywords: ['next'], run: () => scrRef.current.next() },
        { id: 'timer-custom-scramble', label: 'Enter custom scramble', icon: <PencilIcon />, keywords: ['edit'], run: () => setEditingScramble(true) },
        { id: 'timer-copy-scramble', label: 'Copy scramble', icon: <Square2StackIcon />, run: () => void copyScramble() },
      ];
      if (last) {
        cmds.push(
          {
            id: 'timer-penalty',
            label: 'Penalty last solve...',
            icon: <ClockIcon />,
            keywords: ['dnf', '+2', 'ok'],
            children: () =>
              (['OK', '+2', 'DNF'] as Penalty[]).map((p) => ({
                id: `timer-penalty-${p}`,
                label: p === 'OK' ? 'no penalty' : p,
                active: last.penalty === p,
                run: () => penaltyLast(p),
              })),
          },
          { id: 'timer-comment-last', label: 'Comment last solve', icon: <ChatBubbleLeftIcon />, run: commentLast },
          { id: 'timer-delete-last', label: 'Delete last solve', icon: <TrashIcon />, run: deleteLast },
          { id: 'timer-clear-session', label: 'Clear session (delete all its solves)', icon: <TrashIcon />, keywords: ['reset', 'empty'], run: () => setModal({ kind: 'clearSession' }) },
        );
      }
      cmds.push(
        { id: 'timer-toggle-list', label: settings.showSolveList ? 'Hide solve list' : 'Show solve list', icon: <ListBulletIcon />, keywords: ['toggle'], run: () => updateSettings({ showSolveList: !settings.showSolveList }) },
        {
          id: 'timer-input',
          label: 'Enter times with...',
          icon: <CommandLineIcon />,
          keywords: ['input', 'typing', 'manual', 'stackmat', 'virtual', 'bluetooth', 'smart cube', 'qcube'],
          children: () =>
            INPUT_MODES.filter((m) => AVAILABLE.includes(m.id)).map((m) => ({
              id: `timer-input-${m.id}`,
              label: m.label,
              active: m.id === input,
              run: () => setInput(m.id),
            })),
        },
        { id: 'timer-inspection-toggle', label: settings.inspection ? 'Turn inspection off' : 'Turn inspection on', icon: <EyeIcon />, keywords: ['toggle', 'wca'], run: () => updateSettings({ inspection: !settings.inspection }) },
      );
      return cmds;
    },
    [st.sessions, event, session?.id, session?.practice, togglePractice, last?.id, last?.penalty, settings.showSolveList, settings.inspection, input, deleteLast],
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

  // the latest solve as a stable value (inputs show it while idle)
  const lastResult = useMemo(() => (last ? { timeMs: last.timeMs, penalty: last.penalty } : null), [last?.timeMs, last?.penalty]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const previewHeight = usePreviewHeight(previewBoxRef, showPreview);
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
        onTogglePractice={togglePractice}
        onDeleteSession={() => setModal({ kind: 'deleteSession' })}
        onMergeSessions={() => setModal({ kind: 'mergeSessions' })}
        inspection={settings.inspection}
        onToggleInspection={() => updateSettings({ inspection: !settings.inspection })}
        input={input}
        inputs={AVAILABLE}
        onInput={setInput}
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
        hint={input === 'smartcube' ? smartHint : null}
      />

      <div className={`tp-timer-area input-${input}`} {...(input === 'timer' ? engine.touchHandlers : {})} aria-label={input !== 'timer' ? undefined : touch ? 'timer: hold to get ready, release to start' : 'timer'}>
        {manual ? (
          <ManualEntry onSubmit={(r) => record(r, 'manual')} disabled={modal !== null || paletteOpen} />
        ) : input === 'stackmat' || input === 'moyu' ? (
          <StackmatInput
            key={input}
            kind={input}
            enabled={inputsEnabled}
            inspection={settings.inspection && eventInfo.inspection}
            alerts={settings.inspectionAlerts}
            useStatus={settings.stackmatStatus}
            last={lastResult}
            precision={settings.precision}
            timerUpdate={settings.timerUpdate}
            sizeRem={settings.timerSize}
            pb={pb && isIdle}
            onState={setAltState}
            onSolve={(r) => {
              lastStopAt.current = performance.now();
              record(r, 'timer');
            }}
          />
        ) : input === 'bttimer' ? (
          <BtTimerInput
            enabled={inputsEnabled}
            inspection={settings.inspection && eventInfo.inspection}
            alerts={settings.inspectionAlerts}
            last={lastResult}
            precision={settings.precision}
            timerUpdate={settings.timerUpdate}
            sizeRem={settings.timerSize}
            pb={pb && isIdle}
            onState={setAltState}
            onSolve={(r) => {
              lastStopAt.current = performance.now();
              record(r, 'timer');
            }}
          />
        ) : input === 'smartcube' ? (
          <SmartCubeInput
            event={event}
            scramble={scr.current?.text ?? null}
            enabled={inputsEnabled}
            inspection={settings.inspection && eventInfo.inspection}
            alerts={settings.inspectionAlerts}
            last={lastResult}
            precision={settings.precision}
            timerUpdate={settings.timerUpdate}
            sizeRem={settings.timerSize}
            pb={pb && isIdle}
            settings={settings}
            onState={setAltState}
            onSolve={(r, own) => {
              lastStopAt.current = performance.now();
              record(r, 'timer', own);
            }}
            onScramble={scr.setFromCube}
            onHint={setSmartHint}
          />
        ) : input === 'virtual' || input === 'qcube' ? (
          <VirtualInput
            key={input}
            event={event}
            flat={input === 'qcube'}
            scramble={scr.current?.text ?? null}
            enabled={inputsEnabled}
            inspection={settings.inspection && eventInfo.inspection}
            alerts={settings.inspectionAlerts}
            last={lastResult}
            precision={settings.precision}
            timerUpdate={settings.timerUpdate}
            sizeRem={settings.timerSize}
            pb={pb && isIdle}
            settings={settings}
            onState={setAltState}
            onSolve={(r) => {
              lastStopAt.current = performance.now();
              record(r, 'timer');
            }}
          />
        ) : (
          <div key={pbKey}>
            <TimerDisplay state={displayState} precision={settings.precision} timerUpdate={settings.timerUpdate} sizeRem={settings.timerSize} pb={pb && isIdle} />
          </div>
        )}
      </div>

      <div className="tp-under fade-on-focus">
        {solves.length === 0 && input === 'timer' && st.ready ? (
          <div className="tp-hint">
            {touch ? (
              'hold the timer, release to start - tap anywhere to stop'
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
                <TrophyIcon width={14} height={14} /> {pbKinds}
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
              <EyeIcon width={14} height={14} /> scramble preview
            </div>
            <div className="tp-preview-box" ref={previewBoxRef}>
              {previewScramble ? (
                <TwistyPreview puzzle={eventInfo.puzzle} scramble={previewScramble} visualization={settings.scramblePreview === '3D' ? '3D' : '2D'} height={previewHeight} />
              ) : null}
            </div>
          </section>
        )}
        {settings.showSolveList && (
          <SolveList solves={solves} ao5={ao5} ao12={ao12} pbs={pbs} bestIndex={stats.bestIndex} precision={settings.precision} loading={st.loading || !st.ready} onOpen={openSolve} />
        )}
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
            <XMarkIcon width={12} height={12} />
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
          label={`name - ${eventInfo.short.toLowerCase()}`}
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
      {modal?.kind === 'clearSession' && session && (
        <ConfirmModal
          title="clear session"
          message={
            <>
              Delete all {session.solveCount} solve{session.solveCount === 1 ? '' : 's'} in <span className="main">{session.name}</span>? The session stays. This can't be undone.
            </>
          }
          confirmLabel="clear session"
          onConfirm={async () => {
            await clearSession(session.id);
            clearResult();
            toast.notice(`cleared ${session.name}`, { durationMs: 1500 });
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'mergeSessions' && (
        <MergeSessionsModal
          sessions={st.sessions}
          currentSessionId={st.currentSessionId}
          event={event}
          mode={st.mode}
          userId={st.mode === 'cloud' ? (user?.id ?? null) : null}
          precision={settings.precision}
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
          placeholder="pll skip, lockup on f2l, ..."
          maxLength={500}
          onSubmit={(c) => setComment(modal.solveId, c || null)}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
