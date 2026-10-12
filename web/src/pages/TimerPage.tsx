import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EVENTS, effectiveMs, getEvent, rollingAverage, sessionStats, type Penalty, type Precision } from '@cubetype/cubestats';
import { TimerDisplay } from '../timer/TimerDisplay';
import { useTimerEngine, type TimerResult, type TimerState } from '../timer/useTimerEngine';
import { useScrambleQueue } from '../timer/useScrambleQueue';
import { ConfigBar } from '../components/timer/ConfigBar';
import { ScrambleBar } from '../components/timer/ScrambleBar';
import { StatsPanel } from '../components/timer/StatsPanel';
import { SolveList } from '../components/timer/SolveList';
import { SolveModal } from '../components/timer/SolveModal';
import { QuickActions } from '../components/timer/QuickActions';
import { ConfirmModal, PromptModal } from '../components/timer/Dialogs';
import { fmtAvg, fmtSolveShort } from '../components/timer/statsUtil';
import '../components/timer/timer-page.css';
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
import { toast } from '../lib/toast';

type ModalState =
  | { kind: 'solve'; index: number }
  | { kind: 'newSession' }
  | { kind: 'renameSession' }
  | { kind: 'deleteSession' }
  | { kind: 'deleteLast' }
  | { kind: 'comment'; solveId: string }
  | null;

const HOLD_MS = 300;
const PRECISION: Precision = 2;
const TIMER_SIZE = 7;
/** averages in the stats panel: mo3, ao5, ao12, ao100 */
const STATS_NS = [3, 5, 12, 100];
const DEFAULT_EVENT = '333';

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export default function TimerPage() {
  const st = useSolveState();

  const session = st.sessions.find((s) => s.id === st.currentSessionId) ?? null;
  const event = session?.event ?? DEFAULT_EVENT;
  const eventInfo = getEvent(event) ?? EVENTS[0];
  const scr = useScrambleQueue(event);

  const [inspection, setInspection] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);

  // ---------------------------------------------------------------- derived stats (memoised per solve change)
  const solves = st.solves;
  const last = solves.length ? solves[solves.length - 1] : null;
  const stats = useMemo(() => sessionStats(solves, STATS_NS), [solves]);
  const times = useMemo(() => solves.map(effectiveMs), [solves]);
  const ao5 = useMemo(() => rollingAverage(times, 5), [times]);
  const ao12 = useMemo(() => rollingAverage(times, 12), [times]);

  // ---------------------------------------------------------------- refs for stable callbacks
  const scrRef = useRef(scr);
  scrRef.current = scr;
  const lastRef = useRef(last);
  lastRef.current = last;

  // ---------------------------------------------------------------- recording solves
  const onSolve = useCallback((r: TimerResult) => {
    const scramble = scrRef.current.current?.text ?? '';
    addSolve({ timeMs: r.timeMs, penalty: r.penalty, scramble }).catch((e: Error) => {
      toast.error(e.message || "couldn't save the solve");
    });
    scrRef.current.next();
  }, []);

  const engineEnabled = !overlay && modal === null;
  const engine = useTimerEngine({
    enabled: engineEnabled,
    // WCA inspection only applies to events that have it (not blindfolded, not FMC)
    inspection: inspection && eventInfo.inspection,
    holdMs: HOLD_MS,
    alerts: 'beep',
    onSolve,
  });
  const { phase } = engine.state;
  const { clearResult } = engine;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

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
    toast.notice(`deleted ${fmtSolveShort(l, PRECISION)}`, { durationMs: 1500 });
  }, [clearResult]);

  const deleteLast = useCallback(() => {
    if (!lastRef.current) return;
    setModal({ kind: 'deleteLast' });
  }, []);

  const commentLast = useCallback(() => {
    const l = lastRef.current;
    if (l) setModal({ kind: 'comment', solveId: l.id });
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
    void switchEvent(ev).catch((e: Error) => toast.error(e.message));
  }, []);

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('.modal-backdrop')) return;
      const p = phaseRef.current;
      if (p !== 'idle' && p !== 'stopped') return;
      if (isTyping(e.target)) return;
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
        ArrowUp: () => cycleSession(-1),
        ArrowDown: () => cycleSession(1),
      };
      const fn = actions[e.code];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [penaltyLast, deleteLast, commentLast, cycleSession]);

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
  const onOverlayChange = useCallback((open: boolean) => setOverlay(open), []);

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
        inspection={inspection}
        onToggleInspection={() => setInspection((v) => !v)}
        onOverlayChange={onOverlayChange}
      />

      <ScrambleBar scramble={scr.current} onNext={scr.next} />

      <div className="tp-timer-area">
        <TimerDisplay state={displayState} precision={PRECISION} sizeRem={TIMER_SIZE} />
      </div>

      <div className="tp-under">
        {solves.length === 0 && st.ready ? (
          <div className="tp-hint">
            {inspection && eventInfo.inspection ? (
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
            <span>
              ao5<b>{fmtAvg(stats.averages.ao5?.current, PRECISION)}</b>
            </span>
            <span>
              ao12<b>{fmtAvg(stats.averages.ao12?.current, PRECISION)}</b>
            </span>
          </div>
        )}
        <QuickActions last={last} onPenalty={penaltyLast} onComment={commentLast} onDelete={deleteLast} />
      </div>

      <div className="tp-bottom cols-2">
        <StatsPanel stats={stats} ns={STATS_NS} solves={solves} precision={PRECISION} onOpenSolve={openSolve} />
        <SolveList solves={solves} ao5={ao5} ao12={ao12} bestIndex={stats.bestIndex} precision={PRECISION} onOpen={openSolve} />
      </div>

      {/* ------------------------------------------------------------ modals */}
      {modal?.kind === 'solve' && solves[modal.index] && (
        <SolveModal
          solve={solves[modal.index]}
          index={modal.index}
          total={solves.length}
          precision={PRECISION}
          confirmDelete
          onNavigate={(i) => i >= 0 && i < solves.length && setModal({ kind: 'solve', index: i })}
          onClose={() => setModal(null)}
        />
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
              Delete your last solve (<span className="main">{fmtSolveShort(last, PRECISION)}</span>)?
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
