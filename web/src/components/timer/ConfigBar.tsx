import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cloud, CloudOff, Eye, HardDrive, Layers, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { EVENTS, getEvent } from '@cubetype/cubestats';
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
  inspection: boolean;
  onToggleInspection: () => void;
  /** a popover/menu is open (the timer is paused meanwhile) */
  onOverlayChange: (open: boolean) => void;
  mode: 'local' | 'cloud';
  pending: number;
  syncError: string | null;
}

export function ConfigBar(p: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const current = p.sessions.find((s) => s.id === p.currentSessionId) ?? null;
  const eventSessions = p.sessions.filter((s) => s.event === p.event);
  const { onOverlayChange } = p;

  useEffect(() => {
    onOverlayChange(menuOpen);
  }, [menuOpen, onOverlayChange]);

  return (
    <div className="config-bar tp-config">
      <div className="config-card tp-events-full" role="group" aria-label="event">
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

      <div className="config-card tp-session-card">
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
        />
      </div>

      <div className="config-card tp-toggles">
        <button
          className={`btn-text${p.inspection ? ' active' : ''}`}
          onClick={p.onToggleInspection}
          aria-pressed={p.inspection}
          data-tip={p.inspection ? 'WCA inspection on' : 'WCA inspection off'}
          data-tip-pos="down"
          {...noFocus}
        >
          <Eye size={14} />
          <span>inspection</span>
        </button>
      </div>

      <SyncStatus mode={p.mode} pending={p.pending} syncError={p.syncError} />
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
}

function SessionMenu({ open, setOpen, current, sessions, eventLabel, onSession, onNew, onRename, onDelete }: MenuProps) {
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
        <span className="tp-session-name">{current?.name ?? '…'}</span>
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
      tip = syncError ? `${syncError} — retrying automatically` : 'syncing…';
      cls = syncError ? ' warn' : '';
    } else if (syncError) {
      icon = <CloudOff size={14} />;
      label = 'offline';
      tip = `${syncError} — showing cached solves`;
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
    <div className={`config-card tp-sync${cls}`} data-tip={tip} data-tip-pos="down" role="status" aria-label={tip}>
      {icon}
      <span>{label}</span>
    </div>
  );
}
