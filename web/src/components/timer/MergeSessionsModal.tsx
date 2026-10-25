import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowsMergeIcon, CheckIcon, StackIcon } from '@phosphor-icons/react';
import { formatTime, getEvent, sessionStats, type Penalty, type Precision } from '@cubetype/cubestats';
import { Modal } from '../Modal';
import { Spinner } from '../Spinner';
import { api } from '../../lib/api';
import { formatDate, formatNumber } from '../../lib/format';
import { getLoadedSolves, mergeSessions } from '../../lib/solves';
import { toast } from '../../lib/toast';
import type { Session, Solve } from '../../lib/types';
import { fmtAvg } from './statsUtil';
import './dialogs.css';
import './merge-sessions.css';

interface Props {
  /** every session of the store (filtered to the event here) */
  sessions: Session[];
  currentSessionId: string | null;
  event: string;
  mode: 'local' | 'cloud';
  /** logged-in user (cloud mode): used to fetch date ranges from the stats read model */
  userId: string | null;
  precision: Precision;
  onClose: () => void;
}

/** a solve reduced to what the preview needs; t = epoch ms */
interface Entry {
  t: number;
  timeMs: number;
  penalty: Penalty;
}
interface Range {
  first: string;
  last: string;
}
interface Series {
  ranges: Map<string, Range>;
  /** per-session solves from the stats series, only when it covers the whole event */
  entries: Map<string, Entry[]> | null;
}

/** above this many solves the preview is skipped (keeps the dialog snappy) */
const PREVIEW_MAX = 150_000;
/** cloud: at most this many series rows are fetched for the preview */
const SERIES_LIMIT = 5000;

const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;

function fromSolves(list: Solve[]): Entry[] {
  return list.map((s) => ({ t: Date.parse(s.createdAt) || 0, timeMs: s.timeMs, penalty: s.penalty }));
}

function rangeLabel(r: Range | undefined): string | null {
  if (!r) return null;
  const a = formatDate(r.first);
  const b = formatDate(r.last);
  if (a === '-' || b === '-') return null;
  if (a === b) return a;
  // "03 Mar - 14 Oct 2026" when both ends are in the same year
  return a.slice(-4) === b.slice(-4) ? `${a.slice(0, -5)} - ${b}` : `${a} - ${b}`;
}

/**
 * "merge sessions": pick a target (defaults to the current session) and any number of other
 * sessions of the same event; their solves move into the target and the sessions disappear.
 */
export function MergeSessionsModal({ sessions, currentSessionId, event, mode, userId, precision, onClose }: Props) {
  const liveSessions = useMemo(() => sessions.filter((s) => s.event === event), [sessions, event]);
  // while a merge runs the store already shows its result (sources gone): keep rendering the
  // list the user confirmed until the dialog closes, instead of flashing "nothing to merge"
  const [frozen, setFrozen] = useState<Session[] | null>(null);
  const eventSessions = frozen ?? liveSessions;
  const eventLabel = (getEvent(event)?.short ?? event).toLowerCase();
  const [targetId, setTargetId] = useState<string | null>(() =>
    eventSessions.some((s) => s.id === currentSessionId) ? currentSessionId : (eventSessions[0]?.id ?? null),
  );
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [series, setSeries] = useState<Series | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);

  const target = eventSessions.find((s) => s.id === targetId) ?? eventSessions[0] ?? null;
  const candidates = useMemo(() => eventSessions.filter((s) => s.id !== target?.id), [eventSessions, target?.id]);
  const chosen = candidates.filter((s) => selected.has(s.id));
  const chosenSolves = chosen.reduce((n, s) => n + s.solveCount, 0);
  const allChosen = candidates.length > 0 && chosen.length === candidates.length;

  // cloud: date ranges (and, for small histories, the solves) of every session of the event come
  // from the stats read model in one request - never needed in guest mode, where all is in memory
  useEffect(() => {
    if (mode !== 'cloud' || !userId || eventSessions.length < 2) return;
    const ctrl = new AbortController();
    api.stats
      .solves(userId, event, ctrl.signal, { limit: SERIES_LIMIT })
      .then((r) => {
        const ids = r.sessions ?? [];
        const ranges = new Map(ids.map((s) => [s.id, { first: s.firstAt, last: s.lastAt }]));
        let entries: Map<string, Entry[]> | null = null;
        if (!r.truncated) {
          entries = new Map(ids.map((s) => [s.id, [] as Entry[]]));
          for (const [t, timeMs, eff, idx] of r.solves) {
            const id = idx !== undefined ? ids[idx]?.id : undefined;
            if (!id) continue;
            entries.get(id)!.push({ t: t * 1000, timeMs, penalty: eff === null ? 'DNF' : eff > timeMs ? '+2' : 'OK' });
          }
        }
        setSeries({ ranges, entries });
      })
      .catch(() => {
        /* stats service down: the dialog simply shows no dates / preview */
      });
    return () => ctrl.abort();
  }, [mode, userId, event, eventSessions.length]);

  /** solves of a session for the preview - null when unknown or obviously stale */
  const entriesFor = useMemo(() => {
    const cache = new Map<string, Entry[] | null>();
    return (s: Session): Entry[] | null => {
      if (cache.has(s.id)) return cache.get(s.id)!;
      const local = getLoadedSolves(s.id);
      let out: Entry[] | null = local ? fromSolves(local) : (series?.entries?.get(s.id) ?? (series?.entries ? [] : null));
      if (out && out.length !== s.solveCount) out = null; // read model lagging behind: don't guess
      cache.set(s.id, out);
      return out;
    };
  }, [series]);

  // "first - last solve" per session: from memory when loaded, else from the stats read model
  const ranges = useMemo(() => {
    const out = new Map<string, string | null>();
    for (const s of eventSessions) {
      const local = getLoadedSolves(s.id);
      out.set(
        s.id,
        local && local.length ? rangeLabel({ first: local[0].createdAt, last: local[local.length - 1].createdAt }) : rangeLabel(series?.ranges.get(s.id)),
      );
    }
    return out;
  }, [eventSessions, series]);
  const rangeFor = (s: Session): string | null => ranges.get(s.id) ?? null;

  // preview of the merged session's bests (only from data that is already in memory)
  const deferredChosen = useDeferredValue(chosen.map((s) => s.id).join(','));
  const preview = useMemo(() => {
    if (!target || !deferredChosen) return null;
    const ids = deferredChosen.split(',');
    const parts = [target, ...ids.map((id) => candidates.find((s) => s.id === id)).filter((s): s is Session => !!s)].map(entriesFor);
    if (parts.some((p) => p === null)) return null;
    const total = parts.reduce((n, p) => n + p!.length, 0);
    if (total === 0 || total > PREVIEW_MAX) return null;
    const before = sessionStats(parts[0]!, [5, 12]);
    const after = sessionStats((parts as Entry[][]).flat().sort((a, b) => a.t - b.t), [5, 12]);
    return {
      count: after.count,
      hadSolves: before.count > 0,
      single: { now: after.best, was: before.best },
      ao5: { now: after.averages.ao5?.best ?? null, was: before.averages.ao5?.best ?? null },
      ao12: { now: after.averages.ao12?.best ?? null, was: before.averages.ao12?.best ?? null },
    };
  }, [target, deferredChosen, candidates, entriesFor]);

  const close = () => {
    if (!busy) onClose();
  };

  const toggle = (id: string) => {
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pickTarget = (id: string) => {
    setTargetId(id);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setPicking(false);
    setError(null);
    // the focused picker row unmounts: continue on the checklist (keyboard users)
    requestAnimationFrame(() => (listRef.current?.querySelector('input') ?? changeRef.current)?.focus());
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !target || chosen.length === 0) return;
    setBusy(true);
    setFrozen(eventSessions);
    setError(null);
    try {
      const r = await mergeSessions(target.id, chosen.map((s) => s.id));
      onClose();
      toast.success(`merged ${plural(r.sessions, 'session')} - ${plural(r.solves, 'solve')}`);
    } catch (err) {
      setError((err as Error).message || 'the merge failed');
      setFrozen(null);
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    // Enter on a checkbox confirms (buttons handle Enter themselves)
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'checkbox') {
      e.preventDefault();
      void submit();
    }
  };

  if (!target || candidates.length === 0) {
    return (
      <Modal title="merge sessions" onClose={onClose} center>
        <div className="dialog-message">
          {target ? (
            <>
              <span className="main">{target.name}</span> is your only {eventLabel} session, so there is nothing to merge yet.
            </>
          ) : (
            <>you have no {eventLabel} sessions yet.</>
          )}{' '}
          <span className="sub">merging combines several sessions of the same event into one.</span>
          {/* e.g. a 404 refresh just removed the last candidate */}
          {error && (
            <div className="merge-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose} autoFocus>
            ok
          </button>
        </div>
      </Modal>
    );
  }

  const targetRange = rangeFor(target);

  return (
    // top-aligned (not centred): the dialog grows when the picker / preview appear, and a
    // re-centring jump would move rows under the pointer between two clicks
    <Modal title="merge sessions" onClose={close}>
      <form className="merge" onSubmit={submit} onKeyDown={onKeyDown} aria-busy={busy}>
        <div className="merge-section">
          <div className="merge-label">into</div>
          <div className="merge-target">
            <StackIcon size={16} className="merge-target-icon" />
            <div className="merge-target-text">
              <div className="merge-target-name">{target.name}</div>
              <div className="merge-target-meta">
                {eventLabel} - {plural(target.solveCount, 'solve')}
                {targetRange ? ` - ${targetRange}` : ''}
              </div>
            </div>
            <button ref={changeRef} type="button" className="btn-text small" onClick={() => setPicking((p) => !p)} aria-expanded={picking} disabled={busy}>
              {picking ? 'keep' : 'change'}
            </button>
          </div>
          {picking && (
            <div className="merge-list merge-picker" role="group" aria-label="merge into">
              {eventSessions.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  className={`merge-pick${s.id === target.id ? ' active' : ''}`}
                  aria-pressed={s.id === target.id}
                  onClick={() => pickTarget(s.id)}
                  autoFocus={s.id === target.id || (i === 0 && !eventSessions.some((x) => x.id === target.id))}
                >
                  <span className="merge-pick-check">{s.id === target.id && <CheckIcon size={14} />}</span>
                  <span className="merge-name">{s.name}</span>
                  <span className="merge-count">{formatNumber(s.solveCount)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="merge-section">
          <div className="merge-head">
            <span className="merge-label">
              merge these {eventLabel} sessions <span className="merge-label-n">({chosen.length}/{candidates.length})</span>
            </span>
            <button
              type="button"
              className="btn-text small"
              disabled={busy}
              onClick={() => {
                setError(null);
                setSelected(allChosen ? new Set() : new Set(candidates.map((s) => s.id)));
              }}
            >
              {allChosen ? 'select none' : 'select all'}
            </button>
          </div>
          <div className="merge-list" role="group" aria-label="sessions to merge" ref={listRef}>
            {candidates.map((s, i) => {
              const checked = selected.has(s.id);
              const range = rangeFor(s);
              return (
                <label key={s.id} className={`merge-row${checked ? ' checked' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(s.id)} disabled={busy} autoFocus={i === 0 && !picking} />
                  <span className="merge-name">{s.name}</span>
                  <span className="merge-count">{plural(s.solveCount, 'solve')}</span>
                  {range && <span className="merge-range">{range}</span>}
                </label>
              );
            })}
          </div>
        </div>

        {preview && (
          <div className="merge-preview" aria-label="the merged session">
            <div className="merge-label merge-preview-title">after merging</div>
            <PreviewStat label="solves" now={formatNumber(preview.count)} />
            <PreviewStat label="best single" now={formatTime(preview.single.now, precision)} was={preview.hadSolves ? formatTime(preview.single.was, precision) : undefined} />
            <PreviewStat label="best ao5" now={fmtAvg(preview.ao5.now, precision)} was={preview.hadSolves ? fmtAvg(preview.ao5.was, precision) : undefined} />
            <PreviewStat label="best ao12" now={fmtAvg(preview.ao12.now, precision)} was={preview.hadSolves ? fmtAvg(preview.ao12.was, precision) : undefined} />
          </div>
        )}

        <div className="merge-summary" role="status">
          {chosen.length === 0 ? (
            <>
              select the sessions to merge into <b>{target.name}</b>
            </>
          ) : (
            <>
              merge <b>{plural(chosen.length, 'session')}</b> - <b>{plural(chosenSolves, 'solve')}</b> into <b>{target.name}</b>
            </>
          )}
        </div>
        <div className="merge-note">
          the merged sessions will be removed; all their solves are kept. averages and pbs are recalculated for the merged session.
        </div>
        {error && (
          <div className="merge-error" role="alert">
            {error}
          </div>
        )}

        <div className="dialog-actions">
          <span className="keytips merge-keytips">
            <kbd>space</kbd> select - <kbd>enter</kbd> merge
          </span>
          <button type="button" className="btn" onClick={close} disabled={busy}>
            cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || chosen.length === 0}>
            {busy ? <Spinner size={16} /> : <ArrowsMergeIcon size={16} />} {busy ? 'merging...' : 'merge'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PreviewStat({ label, now, was }: { label: string; now: string; was?: string }) {
  const changed = was !== undefined && was !== '-' && was !== now;
  return (
    <div className="merge-stat">
      <div className="merge-stat-label">{label}</div>
      <div className="merge-stat-value">{now}</div>
      {changed && <div className="merge-stat-was">was {was}</div>}
    </div>
  );
}
