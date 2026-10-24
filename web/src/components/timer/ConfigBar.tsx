import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Eye, Keyboard, Layers, Merge, Pencil, Plus, Trash2 } from 'lucide-react';
import { EVENTS, getEvent, type EventInfo } from '@cubetype/cubestats';
import { Modal } from '../Modal';
import type { Session } from '../../lib/types';
import { formatNumber } from '../../lib/format';

/** Buttons on the timer page never take focus on click, so Space can't re-trigger them. */
export const noFocus = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() };

const shortLabel = (id: string) => (getEvent(id)?.short ?? id).toLowerCase();

/** The event rail's groups, in WCA order: NxN cubes, their variants (OH / BLD / FMC), other puzzles. */
const isCube = (e: EventInfo) => /^(\d)\1\1$/.test(e.id);
const GROUPS: EventInfo[][] = [
  EVENTS.filter(isCube),
  EVENTS.filter((e) => !isCube(e) && /^\dx\dx\d$/.test(e.puzzle)),
  EVENTS.filter((e) => !/^\dx\dx\d$/.test(e.puzzle)),
];

interface Props {
  event: string;
  sessions: Session[];
  currentSessionId: string | null;
  onEvent: (event: string) => void;
  onSession: (id: string) => void;
  onNewSession: () => void;
  onRenameSession: () => void;
  onDeleteSession: () => void;
  /** "merge sessions..." (optional so older callers keep working) */
  onMergeSessions?: () => void;
  inspection: boolean;
  onToggleInspection: () => void;
  manual: boolean;
  onToggleManual: () => void;
  /** a popover/menu is open (the timer is paused meanwhile) */
  onOverlayChange: (open: boolean) => void;
  mode: 'local' | 'cloud';
  pending: number;
  syncError: string | null;
}

/**
 * Two quiet tiers above the scramble: an event rail (a capsule whose highlight glides to the
 * chosen event; one chip + picker on narrow screens) and, below it in small type, the session,
 * the inspection / typing switches and the sync status.
 */
export function ConfigBar(p: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const current = p.sessions.find((s) => s.id === p.currentSessionId) ?? null;
  const eventSessions = p.sessions.filter((s) => s.event === p.event);
  const { onOverlayChange } = p;
  const barRef = useRef<HTMLDivElement>(null);
  // the rail collapses into the chip when it doesn't fit (measured: the chosen font sets its width)
  const [fits, setFits] = useState(true);

  useEffect(() => {
    onOverlayChange(menuOpen || pickerOpen);
  }, [menuOpen, pickerOpen, onOverlayChange]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const rail = bar?.querySelector<HTMLElement>('.cb-rail');
    if (!bar || !rail) return;
    const check = () => setFits(rail.offsetWidth <= bar.clientWidth);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(bar);
    ro.observe(rail);
    void document.fonts?.ready.then(check);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={`cb fade-on-focus${fits ? '' : ' compact'}`} ref={barRef}>
      <EventRail event={p.event} onEvent={p.onEvent} hidden={!fits} />
      {/* narrow screens: one chip that opens a picker */}
      <button className="btn-text cb-chip" onClick={() => setPickerOpen(true)} aria-label={`event: ${shortLabel(p.event)} - choose event`} {...noFocus}>
        {shortLabel(p.event)} <ChevronDown size={14} />
      </button>

      <div className="cb-meta">
        <SessionMenu
          open={menuOpen}
          setOpen={setMenuOpen}
          current={current}
          sessions={eventSessions}
          eventLabel={shortLabel(p.event)}
          onSession={p.onSession}
          onNew={p.onNewSession}
          onRename={p.onRenameSession}
          onDelete={p.onDeleteSession}
          onMerge={p.onMergeSessions}
        />
        <span className="cb-rule" aria-hidden="true" />
        <Switch
          on={p.inspection}
          onToggle={p.onToggleInspection}
          icon={<Eye size={13} />}
          label="inspection"
          tip={p.inspection ? 'WCA inspection on (alt+i)' : 'WCA inspection off (alt+i)'}
        />
        <Switch on={p.manual} onToggle={p.onToggleManual} icon={<Keyboard size={13} />} label="typing" tip="type times in manually (alt+m)" />
        <span className="cb-rule" aria-hidden="true" />
        <SyncStatus mode={p.mode} pending={p.pending} syncError={p.syncError} />
      </div>

      {pickerOpen && (
        <Modal title="event" onClose={() => setPickerOpen(false)} center>
          <div className="tp-event-grid">
            {EVENTS.map((e) => (
              <button
                key={e.id}
                className={`btn${e.id === p.event ? ' active' : ''}`}
                onClick={() => {
                  setPickerOpen(false);
                  p.onEvent(e.id);
                }}
              >
                <span>{shortLabel(e.id)}</span>
                <span className="tp-event-grid-name">{e.name}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Every event inline, grouped; a tinted pill glides to the chosen one. */
function EventRail({ event, onEvent, hidden }: { event: string; onEvent: (event: string) => void; hidden: boolean }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [glide, setGlide] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // the first placement (and the first after the rail reappears) jumps; later changes glide
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const measure = () => {
      const btn = rail.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!btn) {
        setGlide(null);
        setAnimate(false);
        return;
      }
      setGlide({ x: btn.offsetLeft, y: btn.offsetTop, w: btn.offsetWidth, h: btn.offsetHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(rail);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [event]);

  useEffect(() => {
    if (!glide || animate) return;
    const raf = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(raf);
  }, [glide, animate]);

  return (
    // when hidden it stays laid out (invisible) so the bar can tell when it fits again
    <div className="cb-rail" ref={railRef} role="group" aria-label="event" aria-hidden={hidden || undefined}>
      {glide && (
        <span
          className={`cb-glide${animate ? ' animate' : ''}`}
          style={{ width: glide.w, height: glide.h, transform: `translate(${glide.x}px, ${glide.y}px)` }}
          aria-hidden="true"
        />
      )}
      {GROUPS.map((group, g) => (
        <div className="cb-group" key={g}>
          {group.map((e) => (
            <button
              key={e.id}
              className={`btn-text cb-event${e.id === event ? ' active' : ''}`}
              onClick={() => onEvent(e.id)}
              aria-pressed={e.id === event}
              title={e.name}
              {...noFocus}
            >
              {shortLabel(e.id)}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function Switch({ on, onToggle, icon, label, tip }: { on: boolean; onToggle: () => void; icon: React.ReactNode; label: string; tip: string }) {
  return (
    <button className="btn-text cb-toggle" onClick={onToggle} aria-pressed={on} aria-label={label} data-tip={tip} data-tip-pos="down" {...noFocus}>
      {icon}
      <span className="cb-label">{label}</span>
      <span className="cb-switch" aria-hidden="true" />
    </button>
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
  onDelete: () => void;
  onMerge?: () => void;
}

function SessionMenu({ open, setOpen, current, sessions, eventLabel, onSession, onNew, onRename, onDelete, onMerge }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);

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
  }, [open, setOpen]);

  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="tp-session" ref={ref}>
      <button
        className={`btn-text cb-session-btn${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={open ? undefined : 'session'}
        data-tip-pos="down"
        {...noFocus}
      >
        <Layers size={13} />
        <span className="tp-session-name">{current?.name ?? '...'}</span>
        <ChevronDown size={13} className="tp-chevron" />
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
                <span className="tp-menu-check">{s.id === current?.id && <Check size={14} />}</span>
                <span className="tp-menu-label">{s.name}</span>
                <span className="tp-menu-count">{formatNumber(s.solveCount)}</span>
              </button>
            ))}
          </div>
          <div className="tp-menu-sep" />
          <button role="menuitem" className="tp-menu-item" onClick={act(onNew)} {...noFocus}>
            <span className="tp-menu-check">
              <Plus size={14} />
            </span>
            <span className="tp-menu-label">new session</span>
          </button>
          <button role="menuitem" className="tp-menu-item" onClick={act(onRename)} disabled={!current} {...noFocus}>
            <span className="tp-menu-check">
              <Pencil size={14} />
            </span>
            <span className="tp-menu-label">rename</span>
          </button>
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
                <Merge size={14} />
              </span>
              <span className="tp-menu-label">merge sessions...</span>
              {sessions.length < 2 && <span className="tp-menu-hint">needs another {eventLabel} session</span>}
            </button>
          )}
          <button role="menuitem" className="tp-menu-item danger" onClick={act(onDelete)} disabled={!current} {...noFocus}>
            <span className="tp-menu-check">
              <Trash2 size={14} />
            </span>
            <span className="tp-menu-label">delete</span>
          </button>
        </div>
      )}
    </div>
  );
}

function SyncStatus({ mode, pending, syncError }: { mode: 'local' | 'cloud'; pending: number; syncError: string | null }) {
  // dot: hollow = this browser only, filled = saved to the account, pulsing = syncing, red = trouble
  let state = 'local';
  let label = 'local';
  let tip = 'guest mode: solves are saved in this browser';
  if (mode === 'cloud') {
    if (pending > 0) {
      state = syncError ? 'warn' : 'syncing';
      label = `${pending} unsynced`;
      tip = syncError ? `${syncError} - retrying automatically` : 'syncing...';
    } else if (syncError) {
      state = 'warn';
      label = 'offline';
      tip = `${syncError} - showing cached solves`;
    } else {
      state = 'synced';
      label = 'synced';
      tip = 'all solves are saved to your account';
    }
  } else if (syncError) {
    state = 'local warn';
    tip = syncError;
  }
  return (
    <div className={`cb-sync ${state}`} data-tip={tip} data-tip-pos="down" role="status" aria-label={tip}>
      <span className="cb-dot" aria-hidden="true" />
      <span className="cb-label">{label}</span>
    </div>
  );
}
