import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  ArrowPathIcon,
  ArrowsPointingInIcon,
  BeakerIcon,
  CheckIcon,
  ChevronDownIcon,
  CommandLineIcon,
  ComputerDesktopIcon,
  EyeIcon,
  PencilIcon,
  PlusIcon,
  SignalSlashIcon,
  Square3Stack3DIcon,
  Squares2X2Icon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { EVENTS, getEvent, isEventReady, OTHER_EVENTS, scrambleTypesFor, type EventInfo, type ScrambleType } from '@cubr/cubestats';
import { INPUT_MODES, modeInfo, type InputMode } from '../../input/inputMode';
import type { Session } from '../../lib/types';
import { formatNumber, practiceMarker } from '../../lib/format';
import { SessionName } from '../SessionName';

/** Buttons on the timer page never take focus on click, so Space can't re-trigger them. */
export const noFocus = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() };

const shortLabel = (id: string) => (getEvent(id)?.short ?? id).toLowerCase();

/** The event dropdown's columns, in WCA order: NxN cubes, their OH / blind / FMC events, other puzzles. */
const isCube = (e: EventInfo) => /^(\d)\1\1$/.test(e.id);
const isCubeVariant = (e: EventInfo) => !isCube(e) && /^\dx\dx\d$/.test(e.puzzle ?? '');
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
  /** the current session's practice scramble type (null: the event's default) */
  scramble?: string | null;
  /** switch to a scramble type (null: the default); optional so older callers keep working */
  onScramble?: (scramble: string | null) => void;
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
  const [scrambleOpen, setScrambleOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const current = p.sessions.find((s) => s.id === p.currentSessionId) ?? null;
  // the session menu lists the sessions of this event and scramble type (pll times stay apart)
  const scramble = p.scramble ?? null;
  const eventSessions = p.sessions.filter((s) => s.event === p.event && (s.scramble ?? null) === scramble);
  const types = scrambleTypesFor(p.event);
  const scrambleType = (scramble && types.find((t) => t.id === scramble)) || types[0];
  const { onOverlayChange } = p;

  useEffect(() => {
    onOverlayChange(eventsOpen || scrambleOpen || menuOpen || inputOpen);
  }, [eventsOpen, scrambleOpen, menuOpen, inputOpen, onOverlayChange]);

  return (
    <div className="config-bar tp-config fade-on-focus">
      <div className="config-card tp-bar">
        <EventMenu open={eventsOpen} setOpen={setEventsOpen} event={p.event} sessions={p.sessions} onEvent={p.onEvent} />

        {p.onScramble && types.length > 0 && (
          <>
            <div className="divider" />
            <ScrambleMenu open={scrambleOpen} setOpen={setScrambleOpen} event={p.event} types={types} current={scrambleType} onScramble={p.onScramble} />
          </>
        )}

        <div className="divider" />
        <SessionMenu
          open={menuOpen}
          setOpen={setMenuOpen}
          current={current}
          sessions={eventSessions}
          eventLabel={scramble && scrambleType ? `${shortLabel(p.event)} ${scrambleType.label}` : shortLabel(p.event)}
          onSession={p.onSession}
          onNew={p.onNewSession}
          onRename={p.onRenameSession}
          onTogglePractice={p.onTogglePractice}
          onDelete={p.onDeleteSession}
          onMerge={p.onMergeSessions}
        />

        <div className="divider" />
        <button
          className={`btn-text tp-inspection-btn${p.inspection ? ' active' : ''}`}
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

        <SyncStatus mode={p.mode} pending={p.pending} syncError={p.syncError} />
      </div>
    </div>
  );
}

/** Closes a dropdown on a click outside `ref` or on Escape. */
/** The menu's items, in order (disabled ones left out). */
const menuItems = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])'));

/**
 * A config-bar menu's behaviour, `ref` wrapping its button and the menu: a click outside or Esc closes it
 * (focus back on the button if it was inside), and the keyboard works as a menu should: Down or Up on the
 * button opens it at the chosen item (or the last), Down, Up, Home and End move between the items, and
 * choosing one with Enter or Space puts focus back on the button.
 */
function useDismiss(open: boolean, setOpen: (o: boolean) => void, ref: RefObject<HTMLElement | null>) {
  const focusOnOpen = useRef<'chosen' | 'last' | null>(null);
  const trigger = () => ref.current?.querySelector<HTMLElement>('[aria-haspopup]') ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const wasInside = ref.current?.contains(document.activeElement) ?? false;
        setOpen(false);
        if (wasInside) trigger()?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, setOpen, ref]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const list = menuItems(el);
      const active = document.activeElement as HTMLElement | null;
      const at = active ? list.indexOf(active) : -1;
      if ((e.key === 'Enter' || e.key === ' ') && at >= 0) {
        requestAnimationFrame(() => trigger()?.focus()); // after the item's click has closed the menu
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); // also keeps the timer page's shortcuts out of it
      if (!list.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          focusOnOpen.current = e.key === 'ArrowUp' ? 'last' : 'chosen';
          setOpen(true);
        }
        return;
      }
      const chosen = Math.max(
        0,
        list.findIndex((x) => x.getAttribute('aria-checked') === 'true'),
      );
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? list.length - 1
            : e.key === 'ArrowDown'
              ? at < 0
                ? chosen
                : (at + 1) % list.length
              : at < 0
                ? list.length - 1
                : (at - 1 + list.length) % list.length;
      list[next].focus();
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [ref, setOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // opened with an arrow key: focus goes to the chosen item (or the first), or the last
  useEffect(() => {
    const el = ref.current;
    if (!open || !el || !focusOnOpen.current) return;
    const list = menuItems(el);
    const where = focusOnOpen.current;
    focusOnOpen.current = null;
    if (!list.length) return;
    const chosen = Math.max(
      0,
      list.findIndex((x) => x.getAttribute('aria-checked') === 'true'),
    );
    list[where === 'last' ? list.length - 1 : chosen].focus();
  }, [open, ref]);
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
  const pick = (id: string) => {
    setOpen(false);
    if (id !== event) onEvent(id);
  };

  return (
    <div className="tp-event-menu" ref={ref}>
      <button
        className={`btn-text active tp-event-btn${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${shortLabel(event)}: event, ${getEvent(event)?.name ?? event}`}
        {...noFocus}
      >
        <span className="tp-event-label">{shortLabel(event)}</span>
        <ChevronDownIcon width={14} height={14} className="tp-chevron" />
      </button>
      {open && (
        <div className="tp-menu tp-events-menu" role="menu" aria-label="event">
          {EVENT_GROUPS.map((g) => (
            <div key={g.title} role="group" aria-label={g.title}>
              <div className="tp-menu-title">{g.title}</div>
              {g.events.map((e) => (
                <EventItem key={e.id} e={e} event={event} count={counts.get(e.id) ?? 0} pick={pick} />
              ))}
            </div>
          ))}
          {/* csTimer's other puzzles and the relays, under the WCA events, in three columns */}
          <div className="tp-events-other" role="group" aria-label="other events">
            <div className="tp-menu-sep" />
            <div className="tp-menu-title">other events</div>
            <div className="tp-events-other-list">
              {OTHER_EVENTS.map((e) => (
                <EventItem key={e.id} e={e} event={event} count={counts.get(e.id) ?? 0} pick={pick} soon={!isEventReady(e.id)} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** One event in the event menu: its short name and solve count; `soon`: listed, not scrambled yet. */
function EventItem({ e, event, count, pick, soon = false }: { e: EventInfo; event: string; count: number; pick: (id: string) => void; soon?: boolean }) {
  return (
    <button
      role="menuitemradio"
      aria-checked={e.id === event}
      className={`tp-menu-item${e.id === event ? ' active' : ''}`}
      onClick={() => pick(e.id)}
      disabled={soon}
      aria-label={soon ? `${e.name} (coming soon)` : e.name}
      {...noFocus}
    >
      <span className="tp-menu-check">{e.id === event && <CheckIcon width={14} height={14} />}</span>
      <span className="tp-menu-label">{shortLabel(e.id)}</span>
      <span className="tp-menu-count">{soon ? 'soon' : count > 0 ? formatNumber(count) : ''}</span>
    </button>
  );
}

/** what the scramble menu says about counting, for WCA events and the others */
const countsHint = (event: string) => (getEvent(event)?.kind === 'wca' ? 'counts for pbs and leaderboards' : 'counts for pbs');

interface ScrambleMenuProps {
  open: boolean;
  setOpen: (o: boolean) => void;
  event: string;
  /** the event's scramble types, its default first */
  types: ScrambleType[];
  current: ScrambleType;
  onScramble: (scramble: string | null) => void;
}

/**
 * The kind of scramble (csTimer's second scramble menu): the event's default, which alone counts
 * for pbs and leaderboards, then its practice types, each with its own practice session.
 */
function ScrambleMenu({ open, setOpen, event, types, current, onScramble }: ScrambleMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, ref);
  const def = types[0];
  const practice = current.id !== def.id;
  const groups = useMemo(() => {
    const out: { title: string; types: ScrambleType[] }[] = [];
    for (const t of types.slice(1)) {
      const title = t.group ?? 'practice';
      let g = out.find((x) => x.title === title);
      if (!g) out.push((g = { title, types: [] }));
      g.types.push(t);
    }
    return out;
  }, [types]);
  const choose = (t: ScrambleType) => {
    setOpen(false);
    if (t.id !== current.id) onScramble(t.id === def.id ? null : t.id);
  };
  const item = (t: ScrambleType, hint?: string) => (
    <button
      key={t.id}
      role="menuitemradio"
      aria-checked={t.id === current.id}
      className={`tp-menu-item${t.id === current.id ? ' active' : ''}`}
      onClick={() => choose(t)}
      disabled={t.pending}
      {...noFocus}
    >
      <span className="tp-menu-check">{t.id === current.id && <CheckIcon width={14} height={14} />}</span>
      <span className="tp-menu-label">{t.label}</span>
      <span className="tp-menu-count">{t.pending ? 'soon' : ''}</span>
      {hint && <span className="tp-menu-hint">{hint}</span>}
    </button>
  );
  return (
    <div className="tp-session tp-scramble-menu" ref={ref}>
      <button
        className={`btn-text tp-session-btn${practice ? ' active practice' : ''}${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`scramble: ${current.label}${practice ? ' (practice: no pbs or leaderboards)' : ''}`}
        data-tip={open ? undefined : practice ? 'practice scramble: no pbs or leaderboards' : 'scramble type'}
        data-tip-pos="down"
        {...noFocus}
      >
        {practice ? <BeakerIcon width={14} height={14} /> : <Squares2X2Icon width={14} height={14} />}
        <span className="tp-scramble-label">{current.label}</span>
        <ChevronDownIcon width={14} height={14} className="tp-chevron" />
      </button>
      {open && (
        <div className="tp-menu tp-scramble-types" role="menu" aria-label="scramble type">
          <div className="tp-menu-title">{shortLabel(event)} scrambles</div>
          {item(def, countsHint(event))}
          {groups.length > 0 && (
            <>
              <div className="tp-menu-sep" />
              <div className="tp-menu-note">practice scrambles: no pbs or leaderboards</div>
              <div className="tp-menu-list">
                {groups.map((g) => (
                  <div key={g.title} role="group" aria-label={g.title}>
                    <div className="tp-menu-title">{g.title}</div>
                    {g.types.map((t) => item(t))}
                  </div>
                ))}
              </div>
            </>
          )}
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
        className={`btn-text tp-session-btn${current?.practice ? ' practice' : ''}${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`session: ${current?.name ?? 'none'}${practiceMarker(current?.name, current?.practice, ' (practice)')}`}
        data-tip={current?.practice && !open ? PRACTICE_TIP : undefined}
        data-tip-pos="down"
        {...noFocus}
      >
        <Square3Stack3DIcon width={14} height={14} className="tp-session-icon" />
        <span className="tp-session-name">{current ? <SessionName name={current.name} practice={current.practice} /> : '...'}</span>
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
                  <SessionName name={s.name} practice={s.practice} />
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
              disabled={!current || !!current.scramble}
              {...noFocus}
            >
              <span className="tp-menu-check">
                <BeakerIcon width={14} height={14} />
              </span>
              <span className="tp-menu-label">practice session</span>
              <span className="tp-menu-hint">{current?.scramble ? 'always, with a practice scramble' : 'no pbs or leaderboards'}</span>
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
function InputMenu({
  open,
  setOpen,
  value,
  options,
  onChange,
}: {
  open: boolean;
  setOpen: (o: boolean) => void;
  value: InputMode;
  options: InputMode[];
  onChange: (m: InputMode) => void;
}) {
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

/**
 * Guest mode, unsynced solves or offline, with its own divider. A signed-in user whose solves are
 * all saved sees nothing here.
 */
function SyncStatus({ mode, pending, syncError }: { mode: 'local' | 'cloud'; pending: number; syncError: string | null }) {
  let icon = <ComputerDesktopIcon width={14} height={14} />;
  let label = 'local';
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
      return null;
    }
  } else if (syncError) {
    cls = ' warn';
    tip = syncError;
  }
  return (
    <>
      <div className="divider" />
      <span className={`tp-sync${cls}`} data-tip={tip} data-tip-pos="down" role="status" aria-label={tip}>
        {icon}
        <span className="tp-hide-narrow">{label}</span>
      </span>
    </>
  );
}
