import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  ArrowPathIcon,
  ArrowsPointingInIcon,
  BeakerIcon,
  CheckIcon,
  ChevronDownIcon,
  CloudIcon,
  CommandLineIcon,
  ComputerDesktopIcon,
  EyeIcon,
  PencilIcon,
  PlusIcon,
  SignalSlashIcon,
  Square3Stack3DIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { EVENTS, getEvent, type EventInfo } from '@cubetype/cubestats';
import { INPUT_MODES, modeInfo, type InputMode } from '../../input/inputMode';
import type { Session } from '../../lib/types';
import { formatNumber } from '../../lib/format';

/** Buttons on the timer page never take focus on click, so Space can't re-trigger them. */
export const noFocus = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() };

const shortLabel = (id: string) => (getEvent(id)?.short ?? id).toLowerCase();

/** The event dropdown's columns, in WCA order: NxN cubes, their OH / blind / FMC events, other puzzles. */
const isCube = (e: EventInfo) => /^(\d)\1\1$/.test(e.id);
const isCubeVariant = (e: EventInfo) => !isCube(e) && /^\dx\dx\d$/.test(e.puzzle);
const EVENT_GROUPS = [
  { title: 'cubes', events: EVENTS.filter(isCube) },
  { title: 'variants', events: EVENTS.filter(isCubeVariant) },
  { title: 'other', events: EVENTS.filter((e) => !isCube(e) && !isCubeVariant(e)) },
];

interface Props {
  event: string;
  sessions: Session[];
  currentSessionId: string | null;
  onEvent: (event: string) => void;
  onSession: (id: string) => void;
  onNewSession: () => void;
  onRenameSession: () => void;
  /** a practice session counts for no pb or leaderboard (optional so older callers keep working) */
  onTogglePractice?: () => void;
  onDeleteSession: () => void;
  /** "merge sessions..." (optional so older callers keep working) */
  onMergeSessions?: () => void;
  inspection: boolean;
  onToggleInspection: () => void;
  /** how times are entered, and the ways this page offers */
  input: InputMode;
  inputs: InputMode[];
  onInput: (m: InputMode) => void;
  /** a popover/menu is open (the timer is paused meanwhile) */
  onOverlayChange: (open: boolean) => void;
  mode: 'local' | 'cloud';
  pending: number;
  syncError: string | null;
}

export function ConfigBar(p: Props) {
  const [eventsOpen, setEventsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const current = p.sessions.find((s) => s.id === p.currentSessionId) ?? null;
  const eventSessions = p.sessions.filter((s) => s.event === p.event);
  const { onOverlayChange } = p;

  useEffect(() => {
    onOverlayChange(eventsOpen || menuOpen || inputOpen);
  }, [eventsOpen, menuOpen, inputOpen, onOverlayChange]);

  return (
    <div className="config-bar tp-config fade-on-focus">
      <div className="config-card tp-bar">
        <EventMenu open={eventsOpen} setOpen={setEventsOpen} event={p.event} sessions={p.sessions} onEvent={p.onEvent} />

        <div className="divider" />
        <SessionMenu
          open={menuOpen}
          setOpen={setMenuOpen}
          current={current}
          sessions={eventSessions}
          eventLabel={shortLabel(p.event)}
          onSession={p.onSession}
          onNew={p.onNewSession}
          onRename={p.onRenameSession}
          onTogglePractice={p.onTogglePractice}
          onDelete={p.onDeleteSession}
          onMerge={p.onMergeSessions}
        />

        <div className="divider" />
        <button
          className={`btn-text${p.inspection ? ' active' : ''}`}
          onClick={p.onToggleInspection}
          aria-pressed={p.inspection}
          data-tip={p.inspection ? 'WCA inspection on (alt+w)' : 'WCA inspection off (alt+w)'}
          data-tip-pos="down"
          {...noFocus}
        >
          <EyeIcon width={14} height={14} />
          <span className="tp-hide-narrow">inspection</span>
        </button>
        <InputMenu open={inputOpen} setOpen={setInputOpen} value={p.input} options={p.inputs} onChange={p.onInput} />

        <div className="divider" />
        <SyncStatus mode={p.mode} pending={p.pending} syncError={p.syncError} />
      </div>
    </div>
  );
}

/** Closes a dropdown on a click outside `ref` or on Escape. */
function useDismiss(open: boolean, setOpen: (o: boolean) => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, setOpen, ref]);
}

interface EventMenuProps {
  open: boolean;
  setOpen: (o: boolean) => void;
  event: string;
  /** every session (all events), for the solve count next to each event */
  sessions: Session[];
  onEvent: (event: string) => void;
}

/** The chosen event (main colour); opens every event in three columns, with its solve count. */
function EventMenu({ open, setOpen, event, sessions, onEvent }: EventMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, ref);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) m.set(s.event, (m.get(s.event) ?? 0) + s.solveCount);
    return m;
  }, [sessions]);

  return (
    <div className="tp-event-menu" ref={ref}>
      <button
        className={`btn-text active tp-event-btn${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`event: ${getEvent(event)?.name ?? event}`}
        {...noFocus}
      >
        {shortLabel(event)}
        <ChevronDownIcon width={14} height={14} className="tp-chevron" />
      </button>
      {open && (
        <div className="tp-menu tp-events-menu" role="menu" aria-label="event">
          {EVENT_GROUPS.map((g) => (
            <div key={g.title} role="group" aria-label={g.title}>
              <div className="tp-menu-title">{g.title}</div>
              {g.events.map((e) => {
                const n = counts.get(e.id) ?? 0;
                return (
                  <button
                    key={e.id}
                    role="menuitemradio"
                    aria-checked={e.id === event}
                    className={`tp-menu-item${e.id === event ? ' active' : ''}`}
                    onClick={() => {
                      setOpen(false);
                      if (e.id !== event) onEvent(e.id);
                    }}
                    aria-label={e.name}
                    {...noFocus}
                  >
                    <span className="tp-menu-check">{e.id === event && <CheckIcon width={14} height={14} />}</span>
                    <span className="tp-menu-label">{shortLabel(e.id)}</span>
                    <span className="tp-menu-count">{n > 0 ? formatNumber(n) : ''}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface MenuProps {
  open: boolean;
  setOpen: (o: boolean) => void;
  current: Session | null;
  sessions: Session[];
  eventLabel: string;
  onSession: (id: string) => void;
  onNew: () => void;
  onRename: () => void;
  onTogglePractice?: () => void;
  onDelete: () => void;
  onMerge?: () => void;
}

const PRACTICE_TIP = 'practice session: no pbs or leaderboards';

function SessionMenu({ open, setOpen, current, sessions, eventLabel, onSession, onNew, onRename, onTogglePractice, onDelete, onMerge }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(open, setOpen, ref);

  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="tp-session" ref={ref}>
      <button
        className={`btn-text tp-session-btn${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`session: ${current?.name ?? 'none'}${current?.practice ? ' (practice)' : ''}`}
        data-tip={current?.practice && !open ? PRACTICE_TIP : undefined}
        data-tip-pos="down"
        {...noFocus}
      >
        {current?.practice ? <BeakerIcon width={14} height={14} /> : <Square3Stack3DIcon width={14} height={14} />}
        <span className="tp-session-name">{current?.name ?? '...'}</span>
        <ChevronDownIcon width={14} height={14} className="tp-chevron" />
      </button>
      {open && (
        <div className="tp-menu" role="menu">
          <div className="tp-menu-title">{eventLabel} sessions</div>
          <div className="tp-menu-list">
            {sessions.map((s) => (
              <button
                key={s.id}
                role="menuitemradio"
                aria-checked={s.id === current?.id}
                className={`tp-menu-item${s.id === current?.id ? ' active' : ''}`}
                onClick={act(() => onSession(s.id))}
                {...noFocus}
              >
                <span className="tp-menu-check">{s.id === current?.id && <CheckIcon width={14} height={14} />}</span>
                <span className="tp-menu-label">
                  {s.name}
                  {s.practice && <span className="tp-menu-tag">practice</span>}
                </span>
                <span className="tp-menu-count">{formatNumber(s.solveCount)}</span>
              </button>
            ))}
          </div>
          <div className="tp-menu-sep" />
          <button role="menuitem" className="tp-menu-item" onClick={act(onNew)} {...noFocus}>
            <span className="tp-menu-check">
              <PlusIcon width={14} height={14} />
            </span>
            <span className="tp-menu-label">new session</span>
          </button>
          <button role="menuitem" className="tp-menu-item" onClick={act(onRename)} disabled={!current} {...noFocus}>
            <span className="tp-menu-check">
              <PencilIcon width={14} height={14} />
            </span>
            <span className="tp-menu-label">rename</span>
          </button>
          {onTogglePractice && (
            <button
              role="menuitemcheckbox"
              aria-checked={!!current?.practice}
              className={`tp-menu-item${current?.practice ? ' active' : ''}`}
              onClick={act(onTogglePractice)}
              disabled={!current}
              {...noFocus}
            >
              <span className="tp-menu-check">
                <BeakerIcon width={14} height={14} />
              </span>
              <span className="tp-menu-label">practice session</span>
              <span className="tp-menu-hint">no pbs or leaderboards</span>
            </button>
          )}
          {onMerge && (
            <button
              role="menuitem"
              className="tp-menu-item"
              onClick={act(onMerge)}
              disabled={!current || sessions.length < 2}
              aria-label={sessions.length < 2 ? `merge sessions (you only have one ${eventLabel} session)` : undefined}
              {...noFocus}
            >
              <span className="tp-menu-check">
                <ArrowsPointingInIcon width={14} height={14} />
              </span>
              <span className="tp-menu-label">merge sessions...</span>
              {sessions.length < 2 && <span className="tp-menu-hint">needs another {eventLabel} session</span>}
            </button>
          )}
          <button role="menuitem" className="tp-menu-item danger" onClick={act(onDelete)} disabled={!current} {...noFocus}>
            <span className="tp-menu-check">
              <TrashIcon width={14} height={14} />
            </span>
            <span className="tp-menu-label">delete</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** How times are entered: the timer, typing, or a stackmat / bluetooth / virtual puzzle (csTimer's inputs). */
function InputMenu({ open, setOpen, value, options, onChange }: { open: boolean; setOpen: (o: boolean) => void; value: InputMode; options: InputMode[]; onChange: (m: InputMode) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, ref);
  const info = modeInfo(value);
  return (
    <div className="tp-session tp-input" ref={ref}>
      <button
        className={`btn-text tp-session-btn${value !== 'timer' ? ' active' : ''}${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`input: ${info.label}`}
        data-tip={open ? undefined : 'how times are entered'}
        data-tip-pos="down"
        {...noFocus}
      >
        <CommandLineIcon width={14} height={14} />
        <span className="tp-hide-narrow">{info.label}</span>
        <ChevronDownIcon width={14} height={14} className="tp-chevron" />
      </button>
      {open && (
        <div className="tp-menu tp-input-menu" role="menu" aria-label="input">
          <div className="tp-menu-title">enter times with</div>
          {INPUT_MODES.filter((m) => options.includes(m.id)).map((m) => (
            <button
              key={m.id}
              role="menuitemradio"
              aria-checked={m.id === value}
              className={`tp-menu-item${m.id === value ? ' active' : ''}`}
              onClick={() => {
                setOpen(false);
                if (m.id !== value) onChange(m.id);
              }}
              {...noFocus}
            >
              <span className="tp-menu-check">{m.id === value && <CheckIcon width={14} height={14} />}</span>
              <span className="tp-menu-label">{m.label}</span>
              <span className="tp-menu-count">
                <kbd>ctrl</kbd>+<kbd>alt</kbd>+<kbd>{m.key}</kbd>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SyncStatus({ mode, pending, syncError }: { mode: 'local' | 'cloud'; pending: number; syncError: string | null }) {
  let icon = <ComputerDesktopIcon width={14} height={14} />;
  /** null = icon only (the calm "synced" state) */
  let label: string | null = 'local';
  let tip = 'guest mode: solves are saved in this browser';
  let cls = '';
  if (mode === 'cloud') {
    if (pending > 0) {
      icon = syncError ? <SignalSlashIcon width={14} height={14} /> : <ArrowPathIcon width={14} height={14} className="tp-spin" />;
      label = `${pending} unsynced`;
      tip = syncError ? `${syncError} - retrying automatically` : 'syncing...';
      cls = syncError ? ' warn' : '';
    } else if (syncError) {
      icon = <SignalSlashIcon width={14} height={14} />;
      label = 'offline';
      tip = `${syncError} - showing cached solves`;
      cls = ' warn';
    } else {
      icon = <CloudIcon width={14} height={14} />;
      label = null;
      tip = 'all solves are saved to your account';
    }
  } else if (syncError) {
    cls = ' warn';
    tip = syncError;
  }
  return (
    <span className={`tp-sync${cls}`} data-tip={tip} data-tip-pos="down" role="status" aria-label={tip}>
      {icon}
      {label && <span className="tp-hide-narrow">{label}</span>}
    </span>
  );
}
