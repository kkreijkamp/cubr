import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cloud, CloudOff, Eye, HardDrive, Keyboard, Layers, Merge, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { EVENTS, getEvent } from '@cubetype/cubestats';
import { Modal } from '../Modal';
import type { Session } from '../../lib/types';
import { formatNumber } from '../../lib/format';

/** Buttons on the timer page never take focus on click, so Space can't re-trigger them. */
export const noFocus = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() };

const shortLabel = (id: string) => (getEvent(id)?.short ?? id).toLowerCase();

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

export function ConfigBar(p: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const current = p.sessions.find((s) => s.id === p.currentSessionId) ?? null;
  const eventSessions = p.sessions.filter((s) => s.event === p.event);
  const { onOverlayChange } = p;
  const barRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  // the events collapse into one button when the bar doesn't fit (measured: the font sets its width)
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    onOverlayChange(menuOpen || pickerOpen);
  }, [menuOpen, pickerOpen, onOverlayChange]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const card = cardRef.current;
    const events = eventsRef.current;
    const chip = chipRef.current;
    if (!bar || !card || !events || !chip) return;
    const check = () => {
      // width with every event inline; while compact the events stay laid out (hidden) to measure
      const inline = card.offsetWidth - chip.offsetWidth + (card.classList.contains('compact') ? events.offsetWidth : 0);
      setCompact(inline > bar.clientWidth);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(bar);
    ro.observe(events);
    void document.fonts?.ready.then(check);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="config-bar tp-config fade-on-focus" ref={barRef}>
      <div className={`config-card tp-bar${compact ? ' compact' : ''}`} ref={cardRef}>
        <div className="tp-events" role="group" aria-label="event" aria-hidden={compact || undefined} ref={eventsRef}>
          {EVENTS.map((e) => (
            <button
              key={e.id}
              className={`btn-text${e.id === p.event ? ' active' : ''}`}
              onClick={() => p.onEvent(e.id)}
              aria-pressed={e.id === p.event}
              title={e.name}
              {...noFocus}
            >
              {shortLabel(e.id)}
            </button>
          ))}
        </div>
        {/* when the events don't fit: one button that opens a picker */}
        <button className="btn-text active tp-event-chip" onClick={() => setPickerOpen(true)} aria-label="choose event" ref={chipRef} {...noFocus}>
          {shortLabel(p.event)} <ChevronDown size={14} />
        </button>

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
          onDelete={p.onDeleteSession}
          onMerge={p.onMergeSessions}
        />

        <div className="divider" />
        <button
          className={`btn-text${p.inspection ? ' active' : ''}`}
          onClick={p.onToggleInspection}
          aria-pressed={p.inspection}
          data-tip={p.inspection ? 'WCA inspection on (alt+i)' : 'WCA inspection off (alt+i)'}
          data-tip-pos="down"
          {...noFocus}
        >
          <Eye size={14} />
          <span className="tp-hide-narrow">inspection</span>
        </button>
        <button
          className={`btn-text${p.manual ? ' active' : ''}`}
          onClick={p.onToggleManual}
          aria-pressed={p.manual}
          data-tip="type times in manually (alt+m)"
          data-tip-pos="down"
          {...noFocus}
        >
          <Keyboard size={14} />
          <span className="tp-hide-narrow">typing</span>
        </button>

        <div className="divider" />
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
        className={`btn-text tp-session-btn${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={open ? undefined : 'session'}
        data-tip-pos="down"
        {...noFocus}
      >
        <Layers size={14} />
        <span className="tp-session-name">{current?.name ?? '...'}</span>
        <ChevronDown size={14} className="tp-chevron" />
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
  let icon = <HardDrive size={14} />;
  let label = 'local';
  let tip = 'guest mode: solves are saved in this browser';
  let cls = '';
  if (mode === 'cloud') {
    if (pending > 0) {
      icon = syncError ? <CloudOff size={14} /> : <RefreshCw size={14} className="tp-spin" />;
      label = `${pending} unsynced`;
      tip = syncError ? `${syncError} - retrying automatically` : 'syncing...';
      cls = syncError ? ' warn' : '';
    } else if (syncError) {
      icon = <CloudOff size={14} />;
      label = 'offline';
      tip = `${syncError} - showing cached solves`;
      cls = ' warn';
    } else {
      icon = <Cloud size={14} />;
      label = 'synced';
      tip = 'all solves are saved to your account';
    }
  } else if (syncError) {
    cls = ' warn';
    tip = syncError;
  }
  return (
    <span className={`tp-sync${cls}`} data-tip={tip} data-tip-pos="down" role="status" aria-label={tip}>
      {icon}
      <span className="tp-hide-narrow">{label}</span>
    </span>
  );
}
