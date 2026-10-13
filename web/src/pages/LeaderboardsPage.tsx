import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarRange, ChevronLeft, ChevronRight, Crown, Globe, Hash, Sigma, Sun, Timer, User, UserX } from 'lucide-react';
import { EVENTS } from '@cubetype/cubestats';
import { Modal } from '../components/Modal';
import { ErrorState, Loading, Spinner } from '../components/Spinner';
import { countryName } from '../components/social/countries';
import { addDaysKey, eventLabel, formatDayKey, friendlyError } from '../components/social/util';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useRegisterCommands, type Command } from '../lib/commands';
import { flagEmoji, formatDate, formatDuration, formatNumber, formatPercent, formatTime, timeAgo, utcDateKey } from '../lib/format';
import { useSettings } from '../lib/settings';
import type { LbKind, Leaderboard } from '../lib/types';
import { useAsync } from '../lib/useAsync';
import '../components/social/leaderboards.css';

const PAGE_SIZE = 50;

type Period = 'all' | 'weekly' | 'daily';
const PERIODS: { id: Period; label: string; icon: typeof Globe }[] = [
  { id: 'all', label: 'all-time', icon: Globe },
  { id: 'weekly', label: 'weekly', icon: CalendarRange },
  { id: 'daily', label: 'daily', icon: Sun },
];
const KINDS: { id: LbKind; icon: typeof Timer }[] = [
  { id: 'single', icon: Timer },
  { id: 'ao5', icon: Sigma },
  { id: 'ao12', icon: Sigma },
];
/** FMC results are move counts, not times, so there are no FMC leaderboards. */
const BOARD_EVENTS = EVENTS.filter((e) => e.unit === 'time');

interface Selection {
  period: Period;
  kind: LbKind;
  event: string;
  page: number;
}

function kindsFor(period: Period): LbKind[] {
  if (period === 'all') return ['single', 'ao5', 'ao12'];
  return ['single', 'ao5'];
}

function normalize(raw: Partial<Record<keyof Selection, string | number | null>>): Selection {
  const period = (PERIODS.some((p) => p.id === raw.period) ? raw.period : 'all') as Period;
  const allowedKinds = kindsFor(period);
  const kind = (allowedKinds.includes(raw.kind as LbKind) ? raw.kind : allowedKinds[0]) as LbKind;
  const event = typeof raw.event === 'string' && BOARD_EVENTS.some((e) => e.id === raw.event) ? raw.event : '333';
  const page = Math.max(1, Math.floor(Number(raw.page) || 1));
  return { period, kind, event, page };
}

function toParams(s: Selection): Record<string, string> {
  return { event: s.event, kind: s.kind, period: s.period, page: String(s.page) };
}

function boardTitle(s: Selection): string {
  const ev = eventLabel(s.event);
  const period = PERIODS.find((p) => p.id === s.period)!.label;
  return `${period} ${ev} ${s.kind} leaderboard`;
}

/** Monday..Sunday (UTC) of an ISO week key like "2026-W42"; falls back to the current week. */
function weekRange(periodKey: string | undefined): { start: string; end: string } {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(periodKey ?? '');
  let monday: Date;
  if (m) {
    const year = Number(m[1]);
    const week = Number(m[2]);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dow = (jan4.getUTCDay() + 6) % 7;
    monday = new Date(Date.UTC(year, 0, 4 - dow + (week - 1) * 7));
  } else {
    const now = new Date();
    const dow = (now.getUTCDay() + 6) % 7;
    monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow));
  }
  const start = monday.toISOString().slice(0, 10);
  return { start, end: addDaysKey(start, 6) };
}

/** ms until the next UTC midnight, or the next Monday 00:00 UTC for weekly boards. */
function msUntilReset(period: 'daily' | 'weekly'): number {
  const now = new Date();
  const days = period === 'daily' ? 1 : 7 - ((now.getUTCDay() + 6) % 7);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days) - now.getTime();
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function fetchBoard(s: Selection, signal: AbortSignal): Promise<Leaderboard> {
  return api.leaderboards.get(s.event, s.kind, { period: s.period, page: s.page, size: PAGE_SIZE }, signal);
}

function isTyping(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

// ------------------------------------------------------------------------------------------ parts

function Subtitle({ sel, periodKey }: { sel: Selection; periodKey: string | undefined }) {
  const now = useNow(30_000);
  void now; // re-render for the countdowns
  const tz = 'all times utc';
  if (sel.period === 'all') {
    return (
      <div className="lb-subtitle">
        <span>best results from every session, ever</span>
      </div>
    );
  }
  if (sel.period === 'weekly') {
    const { start, end } = weekRange(periodKey);
    return (
      <div className="lb-subtitle">
        <span data-tip={tz}>
          {formatDayKey(start).toLowerCase()} – {formatDayKey(end).toLowerCase()}
        </span>
        <span className="lb-pipe" aria-hidden="true" />
        <span>resets in {formatDuration(msUntilReset('weekly'))}</span>
      </div>
    );
  }
  const day = periodKey && /^\d{4}-\d{2}-\d{2}$/.test(periodKey) ? periodKey : utcDateKey();
  return (
    <div className="lb-subtitle">
      <span data-tip={tz}>{formatDayKey(day).toLowerCase()}</span>
      <span className="lb-pipe" aria-hidden="true" />
      <span>resets in {formatDuration(msUntilReset('daily'))}</span>
    </div>
  );
}

function MeCard({ board, sel, precision, onJump }: { board: Leaderboard | undefined; sel: Selection; precision: 2 | 3; onJump: () => void }) {
  const { status, user } = useAuth();
  if (status === 'guest') {
    return (
      <div className="lb-me lb-me-empty">
        <User size={20} />
        <span>
          <Link to={`/login?next=${encodeURIComponent('/leaderboards')}`}>sign in</Link> to save your solves and see where you rank.
        </span>
        <span />
      </div>
    );
  }
  if (status !== 'authed' || !user || !board) return null;
  const me = board.me;
  if (!me) {
    const how =
      sel.period === 'all'
        ? `set a ${eventLabel(sel.event)} ${sel.kind} on the timer to get ranked.`
        : `solve some ${eventLabel(sel.event)} ${sel.period === 'daily' ? 'today' : 'this week'} to get ranked.`;
    return (
      <div className="lb-me lb-me-empty">
        <UserX size={20} />
        <span>
          you are not on this leaderboard yet. {how} <Link to="/">open the timer</Link>
        </span>
        <span />
      </div>
    );
  }
  const top = board.total > 0 ? (me.rank / board.total) * 100 : 100;
  return (
    <div className="lb-me" aria-label="your rank">
      <div className="lb-me-rank">{me.rank === 1 ? <Crown size={22} aria-label="first place" /> : `#${formatNumber(me.rank)}`}</div>
      <div className="lb-me-who">
        <span className="name">{user.username}</span>
        <span className="sub">{me.rank === 1 ? 'goat — nobody is faster' : `you · top ${formatPercent(top)} of ${formatNumber(board.total)}`}</span>
      </div>
      <div className="lb-me-value">{formatTime(me.valueMs, precision)}</div>
      <button className="btn small lb-me-jump" onClick={onJump} data-tip="jump to my page">
        <User /> my page
      </button>
    </div>
  );
}

function GoToPageModal({ pages, current, onGo, onClose }: { pages: number; current: number; onGo: (p: number) => void; onClose: () => void }) {
  const [value, setValue] = useState(String(current));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  const n = Math.floor(Number(value));
  const valid = Number.isFinite(n) && n >= 1 && n <= pages;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onGo(n);
    onClose();
  };
  return (
    <Modal title="go to page" onClose={onClose} center>
      <form className="stack" onSubmit={submit}>
        <div className="lb-goto">
          <input
            ref={inputRef}
            type="number"
            min={1}
            max={pages}
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`page number, 1 to ${pages}`}
          />
          <button type="submit" className="btn" disabled={!valid}>
            go
          </button>
        </div>
        <span className="sub small">
          {pages === 1 ? 'there is only one page' : `1 – ${formatNumber(pages)}`}
        </span>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------ page

export default function LeaderboardsPage() {
  const { user } = useAuth();
  const { precision } = useSettings();
  const [params, setParams] = useSearchParams();
  const sel = useMemo(
    () =>
      normalize({
        period: params.get('period'),
        kind: params.get('kind'),
        event: params.get('event'),
        page: params.get('page'),
      }),
    [params],
  );
  const [gotoOpen, setGotoOpen] = useState(false);
  const scrollToMe = useRef(false);

  const update = useCallback(
    (patch: Partial<Selection>) => {
      const selectionChanged = ['period', 'kind', 'event'].some((k) => k in patch);
      const next = normalize({ ...sel, page: selectionChanged ? 1 : sel.page, ...patch });
      setParams(toParams(next), { replace: true });
    },
    [sel, setParams],
  );

  // keep the canonical selection visible in the URL (?event=333&kind=single&period=all&page=1)
  useEffect(() => {
    const canonical = new URLSearchParams(toParams(sel)).toString();
    if (canonical !== params.toString()) setParams(toParams(sel), { replace: true });
  }, [sel, params, setParams]);

  const board = useAsync((signal) => fetchBoard(sel, signal), [sel.event, sel.kind, sel.period, sel.page, user?.id]);
  const data = board.data;
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (data?.size || PAGE_SIZE)));
  const stale = board.loading && data !== undefined;
  const me = data?.me ?? null;
  const myPage = me ? Math.ceil(me.rank / PAGE_SIZE) : null;

  useEffect(() => {
    document.title = `${boardTitle(sel)} | cubetype`;
    return () => {
      document.title = 'cubetype';
    };
  }, [sel]);

  // clamp pages past the end (e.g. a stale link)
  useEffect(() => {
    if (!board.loading && data && total > 0 && sel.page > pages) update({ page: pages });
  }, [board.loading, data, total, sel.page, pages, update]);

  const goPage = useCallback((p: number) => update({ page: Math.min(Math.max(1, p), pages) }), [pages, update]);
  const jumpToMe = useCallback(() => {
    if (!myPage) return;
    scrollToMe.current = true;
    if (myPage === sel.page) {
      scrollToMyRow();
      scrollToMe.current = false;
    } else update({ page: myPage });
  }, [myPage, sel.page, update]);

  useEffect(() => {
    if (!board.loading && scrollToMe.current) {
      scrollToMe.current = false;
      requestAnimationFrame(scrollToMyRow);
    }
  }, [board.loading]);

  // ← / → flip pages
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
      if (document.querySelector('.modal-backdrop')) return;
      if (e.key === 'ArrowRight' && sel.page < pages) goPage(sel.page + 1);
      else if (e.key === 'ArrowLeft' && sel.page > 1) goPage(sel.page - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel.page, pages, goPage]);

  useRegisterCommands(
    'leaderboards',
    () => {
      const cmds: Command[] = [
        {
          id: 'lb-period',
          label: 'Leaderboard period…',
          icon: <Crown />,
          children: () => PERIODS.map((p) => ({ id: `lb-period-${p.id}`, label: p.label, active: sel.period === p.id, run: () => update({ period: p.id }) })),
        },
        {
          id: 'lb-event',
          label: 'Leaderboard event…',
          icon: <Crown />,
          children: () =>
            BOARD_EVENTS.map((e) => ({
              id: `lb-event-${e.id}`,
              label: eventLabel(e.id),
              keywords: [e.name],
              active: sel.event === e.id,
              run: () => update({ event: e.id }),
            })),
        },
        {
          id: 'lb-kind',
          label: 'Leaderboard type…',
          icon: <Crown />,
          keywords: ['single', 'average'],
          children: () => kindsFor(sel.period).map((k) => ({ id: `lb-kind-${k}`, label: k, active: sel.kind === k, run: () => update({ kind: k }) })),
        },
      ];
      if (sel.page < pages) cmds.push({ id: 'lb-next', label: 'Leaderboard: next page', icon: <ChevronRight />, run: () => goPage(sel.page + 1) });
      if (sel.page > 1) cmds.push({ id: 'lb-prev', label: 'Leaderboard: previous page', icon: <ChevronLeft />, run: () => goPage(sel.page - 1) });
      if (myPage) cmds.push({ id: 'lb-me', label: 'Leaderboard: jump to my page', icon: <User />, run: jumpToMe });
      return cmds;
    },
    [sel, pages, myPage, update, goPage, jumpToMe],
  );

  const from = total === 0 ? 0 : (sel.page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, sel.page * PAGE_SIZE);

  return (
    <div className="lb">
      <aside className="lb-side" aria-label="leaderboard filters">
        <div className="lb-group lb-periods" role="group" aria-label="period">
          {PERIODS.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`btn${sel.period === id ? ' active' : ''}`} aria-pressed={sel.period === id} onClick={() => update({ period: id })}>
              <Icon /> {label}
            </button>
          ))}
        </div>
        <div className="lb-group lb-kinds" role="group" aria-label="result type">
          {KINDS.filter((k) => kindsFor(sel.period).includes(k.id)).map(({ id, icon: Icon }) => (
            <button key={id} className={`btn${sel.kind === id ? ' active' : ''}`} aria-pressed={sel.kind === id} onClick={() => update({ kind: id })}>
              <Icon /> {id}
            </button>
          ))}
        </div>
        <div className="lb-group lb-events" role="group" aria-label="event">
          {BOARD_EVENTS.map((e) => (
            <button
              key={e.id}
              className={`btn${sel.event === e.id ? ' active' : ''}`}
              aria-pressed={sel.event === e.id}
              onClick={() => update({ event: e.id })}
              title={e.name}
            >
              {eventLabel(e.id)}
            </button>
          ))}
        </div>
      </aside>

      <section className="lb-main" aria-live="polite" aria-busy={board.loading}>
        <div className="lb-head">
          <h1 className="lb-title">{boardTitle(sel)}</h1>
          <Subtitle sel={sel} periodKey={data?.periodKey} />
        </div>

        <MeCard board={data} sel={sel} precision={precision} onJump={jumpToMe} />

        {board.error && !data ? (
          <ErrorState error={new Error(friendlyError(board.error, 'the leaderboard service'))} onRetry={board.reload} />
        ) : !data ? (
          <Loading />
        ) : total === 0 || data.entries.length === 0 ? (
          <div className="lb-empty">
            <div className="shrug">no entries yet ¯\_(ツ)_/¯</div>
            <div className="small">
              be the first to set a {eventLabel(sel.event)} {sel.kind} — <Link to="/">open the timer</Link>
            </div>
          </div>
        ) : (
          <>
            <div className="lb-toolbar">
              <span className="lb-count">
                {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)} {total === 1 ? 'cuber' : 'cubers'}
                {board.loading && <Spinner size={14} />}
              </span>
              <nav className="lb-pager" aria-label="pagination">
                <button className="btn" onClick={() => goPage(1)} disabled={sel.page === 1} data-tip="first page" aria-label="first page">
                  <Crown />
                </button>
                <button className="btn" onClick={jumpToMe} disabled={!myPage} data-tip="jump to my page" aria-label="jump to my page">
                  <User />
                </button>
                <button className="btn" onClick={() => goPage(sel.page - 1)} disabled={sel.page === 1} data-tip="previous page ←" aria-label="previous page">
                  <ChevronLeft />
                </button>
                <button className="btn" onClick={() => setGotoOpen(true)} data-tip="go to page" aria-label={`page ${sel.page} of ${pages}, go to page`}>
                  {sel.page} / {pages}
                </button>
                <button className="btn" onClick={() => goPage(sel.page + 1)} disabled={sel.page >= pages} data-tip="next page →" aria-label="next page">
                  <ChevronRight />
                </button>
              </nav>
            </div>
            <div className="table-wrap">
              <table className={`table lb-table${stale ? ' stale' : ''}`}>
                <thead>
                  <tr>
                    <th className="rank">
                      <Hash aria-label="rank" />
                    </th>
                    <th className="name">name</th>
                    <th>{data.kind || sel.kind}</th>
                    <th className="date">date</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => {
                    const mine = user?.id === e.userId;
                    return (
                      <tr key={`${e.rank}-${e.userId}`} className={mine ? 'me' : undefined}>
                        <td className="rank">{e.rank === 1 ? <Crown size={18} aria-label="1" /> : formatNumber(e.rank)}</td>
                        <td className="name">
                          <Link to={`/profile/${encodeURIComponent(e.username)}`} className="lb-user">
                            {e.username}
                          </Link>
                          {e.country && flagEmoji(e.country) && (
                            <span className="flag" title={countryName(e.country)} aria-label={countryName(e.country)}>
                              {flagEmoji(e.country)}
                            </span>
                          )}
                        </td>
                        <td className="value">{formatTime(e.valueMs, precision)}</td>
                        <td className="date" title={e.achievedAt ? timeAgo(e.achievedAt) : undefined}>
                          {formatDate(e.achievedAt)}
                          {e.achievedAt && (
                            <span className="secondary">
                              {new Date(e.achievedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {board.error && <div className="error small center">{friendlyError(board.error, 'the leaderboard service')} — showing the last loaded page.</div>}
          </>
        )}
      </section>
      {gotoOpen && <GoToPageModal pages={pages} current={sel.page} onGo={goPage} onClose={() => setGotoOpen(false)} />}
    </div>
  );
}

function scrollToMyRow() {
  const row = document.querySelector<HTMLTableRowElement>('table.lb-table tr.me');
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('flash');
  void row.offsetWidth; // restart the animation
  row.classList.add('flash');
}
