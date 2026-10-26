import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDownTrayIcon, ArrowUpRightIcon, ArrowUpTrayIcon, ArrowUturnLeftIcon, ArrowsRightLeftIcon, CubeIcon, MagnifyingGlassIcon, PlayIcon } from '@heroicons/react/24/outline';
import { CsTimerFormatError, EVENTS, parseTimerFile, toCsTimerExport, type TimerImport } from '@cubetype/cubestats';
import { Modal } from '../components/Modal';
import { csTimerFileName, skippedNotes } from '../components/social/util';
import { ConfirmModal } from '../components/timer/Dialogs';
import { playPbSound } from '../components/timer/feedback';
import { AVG_CHOICES, parseAvgKey } from '../components/timer/statsUtil';
import '../components/timer/settings-page.css';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatNumber } from '../lib/format';
import { applyVisualSettings, DEFAULT_SETTINGS, FONTS, updateSettings, useSettings, type Settings } from '../lib/settings';
import { SCHEMES, stickerColour, type Scheme } from '../lib/scrambleNet';
import { clearLocalData, exportAll, forgetUser, importSessions, localDataSummary, useSolveState } from '../lib/solves';
import { applyTheme, isLightTheme, randomTheme, THEMES, themeLabel, type Theme } from '../lib/themes';
import { toast } from '../lib/toast';

const PANES = [
  { id: 'timer', label: 'timer' },
  { id: 'display', label: 'display' },
  { id: 'stats', label: 'stats' },
  { id: 'theme', label: 'theme' },
  { id: 'data', label: 'data' },
  { id: 'shortcuts', label: 'shortcuts' },
  { id: 'danger', label: 'danger zone' },
] as const;
type PaneId = (typeof PANES)[number]['id'];

interface RowProps {
  title: string;
  children: ReactNode;
  description: ReactNode;
  /** the controls go under the text instead of beside it (long lists of choices) */
  wide?: boolean;
}

/** One setting: its name and a line on what it does, the choices on the right. */
function SettingRow({ title, description, children, wide }: RowProps) {
  const id = useId();
  return (
    <div className={`st-row${wide ? ' wide' : ''}`}>
      <div className="st-text">
        <h3 className="st-title" id={id}>
          {title}
        </h3>
        <div className="st-desc">{description}</div>
      </div>
      <div className="st-controls" role="group" aria-labelledby={id}>
        {children}
      </div>
    </div>
  );
}

/** A few settings that belong together, under a quiet lowercase label. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="st-group" aria-labelledby={id}>
      <h2 className="st-label" id={id}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The choices as text, like the timer's config bar: the chosen one in the accent colour. */
function Options<T extends string | number | boolean>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="st-options">
      {options.map((o) => (
        <button key={String(o.value)} className={`btn-text${o.value === value ? ' active' : ''}`} onClick={() => onChange(o.value)} aria-pressed={o.value === value}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const onOff = [
  { value: true, label: 'on' },
  { value: false, label: 'off' },
];

function set<K extends keyof Settings>(key: K) {
  return (v: Settings[K]) => updateSettings({ [key]: v } as Partial<Settings>);
}

// csTimer's shortcuts (all of them)
const CSTIMER_KEYS: [ReactNode, string][] = [
  [<kbd key="s">space</kbd>, 'hold to get ready, release to start, any key stops'],
  [<kbd key="e">esc</kbd>, 'cancel inspection - stop as DNF while running - command line when idle'],
  [
    <>
      <kbd>alt</kbd>+<kbd>left</kbd> / <kbd>right</kbd>
    </>,
    'previous / next scramble',
  ],
  [
    <>
      <kbd>alt</kbd>+<kbd>i</kbd>
    </>,
    'type in your own scramble',
  ],
  [
    <>
      <kbd>alt</kbd>+<kbd>2</kbd> ... <kbd>7</kbd>
    </>,
    'event: 2x2 ... 7x7',
  ],
  [
    <>
      <kbd>alt</kbd>+<kbd>1</kbd> <kbd>p</kbd> <kbd>m</kbd> <kbd>c</kbd> <kbd>s</kbd>
    </>,
    'event: square-1 / pyraminx / megaminx / clock / skewb',
  ],
  [
    <>
      <kbd>ctrl</kbd>+<kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd>
    </>,
    'latest solve: no penalty / +2 / DNF',
  ],
  [
    <>
      <kbd>alt</kbd>+<kbd>z</kbd> or <kbd>ctrl</kbd>+<kbd>z</kbd>
    </>,
    'delete the latest solve (alt+backspace too)',
  ],
  [
    <>
      <kbd>alt</kbd>+<kbd>d</kbd>
    </>,
    'clear the session (delete all its solves)',
  ],
  [
    <>
      <kbd>alt</kbd>+<kbd>up</kbd> / <kbd>down</kbd>
    </>,
    'previous / next session of this event',
  ],
  [
    <>
      <kbd>ctrl</kbd>+<kbd>alt</kbd>+<kbd>t</kbd> / <kbd>i</kbd>
    </>,
    'time with the timer / type times in',
  ],
];

// cubetype's own, on keys csTimer leaves free
const OWN_KEYS: [ReactNode, string][] = [
  [
    <>
      <kbd>ctrl</kbd>+<kbd>k</kbd>
    </>,
    'command line (anywhere)',
  ],
  [<kbd key="t">tab</kbd>, 'next scramble'],
  [
    <>
      <kbd>alt</kbd>+<kbd>n</kbd>
    </>,
    'comment on the latest solve',
  ],
  [
    <>
      <kbd>alt</kbd>+<kbd>w</kbd>
    </>,
    'toggle WCA inspection',
  ],
  [
    <>
      <kbd>left</kbd> / <kbd>right</kbd>
    </>,
    'browse solves in the solve window',
  ],
];

function KeyList({ keys }: { keys: [ReactNode, string][] }) {
  return (
    <dl className="st-keys">
      {keys.map(([k, what], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{what}</dd>
        </div>
      ))}
    </dl>
  );
}

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One of the rail's sections in the list. */
function Pane({ id, children }: { id: PaneId; children: ReactNode }) {
  return (
    <div className="st-pane" id={`settings-${id}`}>
      {children}
    </div>
  );
}

/**
 * Settings: one list of every section, with a rail beside it that jumps to a section and lights
 * the one in view (?tab= opens the page on a section). No cards - groups are set apart by space
 * and small labels, and every choice is text with the chosen one in the accent colour.
 */
export default function SettingsPage() {
  const s = useSettings();
  const { status, user } = useAuth();
  const navigate = useNavigate();
  const solveState = useSolveState();
  const [confirm, setConfirm] = useState<'clear' | 'reset' | 'account' | null>(null);
  const [local, setLocal] = useState(() => localDataSummary());
  const [params] = useSearchParams();
  const asked = PANES.find((p) => p.id === params.get('tab'))?.id;
  // the section in view, lit in the rail
  const [active, setActive] = useState<PaneId>(asked ?? 'timer');
  // while a jump scrolls, the rail keeps the section it jumped to
  const jumping = useRef(false);
  const railRef = useRef<HTMLElement>(null);

  useEffect(() => setLocal(localDataSummary()), [solveState.sessions, solveState.solves]);
  // never leave a hover preview applied when navigating away
  useEffect(() => () => applyVisualSettings(), []);

  const jump = (id: PaneId, smooth = true) => {
    const el = document.getElementById(`settings-${id}`);
    if (!el) return;
    setActive(id);
    jumping.current = true;
    const done = () => {
      jumping.current = false;
      window.removeEventListener('scrollend', done);
      clearTimeout(timer);
    };
    const timer = window.setTimeout(done, 1500);
    window.addEventListener('scrollend', done);
    el.scrollIntoView({ behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto', block: 'start' });
  };

  useEffect(() => {
    let frame = 0;
    const spy = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (jumping.current) return;
        // the last section whose top has passed the top third of the window; at the very bottom
        // the last one, which is too short to get there
        const line = window.innerHeight / 3;
        let current: PaneId = PANES[0].id;
        for (const p of PANES) if ((document.getElementById(`settings-${p.id}`)?.getBoundingClientRect().top ?? Infinity) <= line) current = p.id;
        if (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = PANES[PANES.length - 1].id;
        setActive(current);
      });
    };
    window.addEventListener('scroll', spy, { passive: true });
    window.addEventListener('resize', spy);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', spy);
      window.removeEventListener('resize', spy);
    };
  }, []);

  // a link to a section opens on it - a frame late, after the layout's scroll to the top of a new page
  useEffect(() => {
    if (!asked) return;
    const frame = requestAnimationFrame(() => jump(asked, false));
    return () => cancelAnimationFrame(frame);
  }, []); // only on arriving

  // on phones the rail is a row of tabs that scrolls sideways: keep the lit one in sight
  useEffect(() => {
    const rail = railRef.current;
    const item = rail?.querySelector<HTMLElement>('.st-rail-item.active');
    if (!rail || !item || rail.scrollWidth <= rail.clientWidth) return;
    rail.scrollTo({ left: item.offsetLeft - (rail.clientWidth - item.offsetWidth) / 2, behavior: 'smooth' });
  }, [active]);

  return (
    <div className="settings-page">
      <aside className="st-side">
        <h1 className="st-label">settings</h1>
        <nav className="st-rail" aria-label="settings sections" ref={railRef}>
          {PANES.map((p) => (
            <button
              key={p.id}
              className={`st-rail-item${p.id === active ? ' active' : ''}${p.id === 'danger' ? ' danger' : ''}`}
              aria-current={p.id === active ? 'true' : undefined}
              onClick={() => jump(p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="st-list">
        <Pane id="timer">
          <Group title="timer">
            <SettingRow title="hold to start" description="How long space (or your finger) is held before the timer turns green. Stops accidental starts.">
              <Options value={s.holdMs} options={[0, 300, 550, 1000].map((v) => ({ value: v, label: v === 0 ? 'off' : `${v / 1000}s` }))} onChange={set('holdMs')} />
            </SettingRow>
            <SettingRow title="timer update" description="What the timer shows while you solve. Hiding it keeps your eyes off the clock.">
              <Options
                value={s.timerUpdate}
                options={[
                  { value: 'realtime', label: 'realtime' },
                  { value: 'tenths', label: '0.1s' },
                  { value: 'seconds', label: 'seconds' },
                  { value: 'hidden', label: 'hidden' },
                ]}
                onChange={set('timerUpdate')}
              />
            </SettingRow>
            <SettingRow title="precision" description="Decimal places for times. Singles are truncated, averages rounded like the WCA.">
              <Options
                value={s.precision}
                options={[
                  { value: 2, label: '0.01' },
                  { value: 3, label: '0.001' },
                ]}
                onChange={set('precision')}
              />
            </SettingRow>
          </Group>
          <Group title="inspection">
            <SettingRow title="WCA inspection" description="15 seconds to inspect before each solve. Starting after 15 s adds +2, after 17 s the solve is a DNF (WCA A4d).">
              <Options value={s.inspection} options={onOff} onChange={set('inspection')} />
            </SettingRow>
            <SettingRow title="inspection alerts" description="Called out at 8 and 12 seconds, like a judge at a competition.">
              <Options
                value={s.inspectionAlerts}
                options={[
                  { value: 'off', label: 'off' },
                  { value: 'beep', label: 'beep' },
                  { value: 'voice', label: 'voice' },
                ]}
                onChange={set('inspectionAlerts')}
              />
            </SettingRow>
          </Group>
        </Pane>

        <Pane id="display">
          <Group title="display">
            <SettingRow title="timer size" description="Size of the big timer.">
              <span className="st-size-preview" style={{ fontSize: `${s.timerSize * 0.24}rem` }} aria-hidden="true">
                12.34
              </span>
              <Options
                value={s.timerSize}
                options={[
                  { value: 5, label: 's' },
                  { value: 7, label: 'm' },
                  { value: 9, label: 'l' },
                  { value: 11, label: 'xl' },
                ]}
                onChange={set('timerSize')}
              />
            </SettingRow>
            <SettingRow title="focus mode" description="Fade out everything but the timer while you inspect and solve.">
              <Options value={s.focusMode} options={onOff} onChange={set('focusMode')} />
            </SettingRow>
            <SettingRow title="solve list" description="The current session's solves under the timer.">
              <Options value={s.showSolveList} options={onOff} onChange={set('showSolveList')} />
            </SettingRow>
          </Group>
          <Group title="scramble preview">
            <SettingRow title="preview" description="Draw the scrambled puzzle so you can check you scrambled it right.">
              <Options
                value={s.scramblePreview}
                options={[
                  { value: 'off', label: 'off' },
                  { value: '2D', label: '2D' },
                  { value: '3D', label: '3D' },
                ]}
                onChange={set('scramblePreview')}
              />
            </SettingRow>
            <SettingRow title="sticker colours" description="The 2D preview's colours: the standard scheme, or your own colour for each face of each puzzle. 3D always uses the standard colours.">
              <Options
                value={s.stickerColours}
                options={[
                  { value: 'default', label: 'default' },
                  { value: 'custom', label: 'custom' },
                ]}
                onChange={set('stickerColours')}
              />
            </SettingRow>
            {s.stickerColours === 'custom' && <StickerColours custom={s.customStickers} />}
          </Group>
          <Group title="app">
            <SettingRow title="font" description="One font for the whole app." wide>
              <div className="st-options">
                {FONTS.map((f) => (
                  <button
                    key={f.name}
                    className={`btn-text${s.font === f.name ? ' active' : ''}`}
                    style={{ fontFamily: f.css }}
                    aria-pressed={s.font === f.name}
                    onClick={() => updateSettings({ font: f.name })}
                  >
                    {f.name.toLowerCase()}
                  </button>
                ))}
              </div>
            </SettingRow>
          </Group>
        </Pane>

        <Pane id="stats">
          <Group title="stats">
            <SettingRow title="averages shown" description="Which averages the stats panel shows. Averages trim the best and worst 5 % (at least one each side); mo3 is a plain mean." wide>
              <div className="st-options">
                {AVG_CHOICES.map((k) => {
                  const on = s.statsShown.includes(k);
                  return (
                    <button
                      key={k}
                      className={`btn-text${on ? ' active' : ''}`}
                      aria-pressed={on}
                      onClick={() => {
                        const next = on ? s.statsShown.filter((x) => x !== k) : [...s.statsShown, k];
                        updateSettings({ statsShown: next.sort((a, b) => (parseAvgKey(a) ?? 0) - (parseAvgKey(b) ?? 0)) });
                      }}
                    >
                      {k}
                    </button>
                  );
                })}
              </div>
            </SettingRow>
          </Group>
          <Group title="solves">
            <SettingRow title="confirm delete" description="Ask before deleting a solve with alt+z (or ctrl+z, alt+backspace) or from the solve window.">
              <Options value={s.confirmDelete} options={onOff} onChange={set('confirmDelete')} />
            </SettingRow>
            <SettingRow
              title="pb sound"
              description={
                <>
                  A short chime when you set a new personal best.{' '}
                  <button className="btn-text st-inline" onClick={playPbSound}>
                    <PlayIcon width={12} height={12} /> preview
                  </button>
                </>
              }
            >
              <Options value={s.pbSound} options={onOff} onChange={set('pbSound')} />
            </SettingRow>
          </Group>
        </Pane>

        <Pane id="theme">
          <ThemePicker current={s.theme} />
        </Pane>

        <Pane id="data">
          <DataTools loggedIn={status === 'authed'} />
        </Pane>

        <Pane id="shortcuts">
          <Group title="shortcuts">
            <p className="st-note">
              All of csTimer's shortcuts work the same here, so your habits carry over. Some browsers use ctrl+1/2/3 to switch tabs and don't pass them on; the penalty buttons under the
              timer do the same job.
            </p>
            <KeyList keys={CSTIMER_KEYS} />
          </Group>
          <Group title="cubetype's own">
            <KeyList keys={OWN_KEYS} />
          </Group>
        </Pane>

        <Pane id="danger">
          <Group title="danger zone">
            <SettingRow
              title="clear guest data"
              description={
                <>
                  Delete every session and solve stored in this browser while signed out
                  {local.solves > 0 ? (
                    <>
                      {' '}
                      (<span className="main">{formatNumber(local.solves)} solves</span> in {local.sessions} session{local.sessions === 1 ? '' : 's'})
                    </>
                  ) : (
                    ' (there are none right now)'
                  )}
                  . Solves in your account are not affected. <span className="error">You can't undo this.</span>
                </>
              }
            >
              <button className="btn st-danger" onClick={() => setConfirm('clear')} disabled={local.solves === 0 && local.sessions <= 1}>
                clear guest data
              </button>
            </SettingRow>
            <SettingRow title="reset settings" description="Put every setting back to its default (your solves are kept).">
              <button className="btn st-danger" onClick={() => setConfirm('reset')}>
                reset settings
              </button>
            </SettingRow>
            {status === 'authed' && user && (
              <SettingRow
                title="delete account"
                description={
                  <>
                    Delete <span className="main">{user.username}</span> and everything in it: your solves and sessions, stats, leaderboard places, profile and settings. Export your
                    solves first (data) if you want to keep them. Guest data in this browser is not affected. <span className="error">You can't undo this.</span>
                  </>
                }
              >
                <button className="btn st-danger" onClick={() => setConfirm('account')}>
                  delete account
                </button>
              </SettingRow>
            )}
          </Group>
        </Pane>
      </div>

      {confirm === 'account' && user && (
        <DeleteAccountModal
          username={user.username}
          onDeleted={() => {
            forgetUser(user.id);
            toast.notice('your account has been deleted');
            navigate('/');
          }}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'clear' && (
        <ConfirmModal
          title="clear guest data"
          message={
            <>
              Permanently delete {formatNumber(local.solves)} solves stored in this browser? <span className="error">This can't be undone.</span>
            </>
          }
          confirmLabel="delete everything"
          onConfirm={() => {
            clearLocalData();
            setLocal(localDataSummary());
            toast.success('guest data cleared');
          }}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'reset' && (
        <ConfirmModal
          title="reset settings"
          message="Reset all settings (theme, timer, display, stats) to their defaults?"
          confirmLabel="reset"
          onConfirm={() => {
            updateSettings({ ...DEFAULT_SETTINGS, lastEvent: s.lastEvent });
            applyVisualSettings();
            toast.success('settings reset');
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

/** Deleting the account: the password is asked again, then it's gone for good. */
function DeleteAccountModal({ username, onDeleted, onClose }: { username: string; onDeleted: () => void; onClose: () => void }) {
  const { deleteAccount } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(password);
      onDeleted();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? 'wrong password' : (e as Error).message || "couldn't delete the account, try again");
      setBusy(false);
    }
  };
  return (
    <Modal title="delete account" onClose={onClose} center>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="dialog-message">
          Delete <span className="main">{username}</span> with all its solves, sessions, stats and leaderboard places? <span className="error">This can't be undone.</span>
        </div>
        <div className="field">
          <label htmlFor="delete-account-password">type your password to confirm</label>
          <input
            id="delete-account-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            maxLength={128}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
          />
          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="btn danger" disabled={!password || busy}>
            {busy ? 'deleting...' : 'delete account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** your own sticker colours: per puzzle, a swatch for each face that opens a colour picker */
function StickerColours({ custom }: { custom: Settings['customStickers'] }) {
  const save = (scheme: Scheme, faces: (string | null)[]) => {
    const next = { ...custom };
    if (faces.every((c) => c === null)) delete next[scheme.id];
    else next[scheme.id] = faces;
    updateSettings({ customStickers: next });
  };
  const pick = (scheme: Scheme, face: number, colour: string) =>
    // only the faces you changed are stored, so a later change to a default colour still reaches you
    save(
      scheme,
      scheme.faces.map((f, i) => (i === face ? (colour === f.colour ? null : colour) : (custom[scheme.id]?.[i] ?? null))),
    );

  return (
    <div className="st-stickers">
      {SCHEMES.map((scheme) => {
        const own = custom[scheme.id];
        return (
          <div key={scheme.id} className="st-sticker-row">
            <span className="st-sticker-label">{scheme.label}</span>
            <div className="st-swatches">
              {scheme.faces.map((f, i) => {
                const colour = stickerColour(f.cubing[0], scheme, own);
                return (
                  <label key={f.name} className="st-swatch" style={{ background: colour }} data-tip={f.name}>
                    <input type="color" value={colour} onChange={(e) => pick(scheme, i, e.target.value)} aria-label={`${scheme.label}: ${f.name} face colour`} />
                  </label>
                );
              })}
            </div>
            <button className="btn-text small" onClick={() => save(scheme, [])} disabled={!own} aria-label={`reset the ${scheme.label} colours`}>
              <ArrowUturnLeftIcon width={14} height={14} /> reset
            </button>
          </div>
        );
      })}
    </div>
  );
}

type ThemeFilter = 'all' | 'dark' | 'light' | 'originals';

const THEME_FILTERS: { value: ThemeFilter; label: string; test: (t: Theme) => boolean }[] = [
  { value: 'all', label: 'all', test: () => true },
  { value: 'dark', label: 'dark', test: (t) => !isLightTheme(t) },
  { value: 'light', label: 'light', test: (t) => isLightTheme(t) },
  { value: 'originals', label: 'originals', test: (t) => Boolean(t.original) },
];

/** a theme in miniature: its background with its accent, sub and text colours as dots */
function ThemeSwatch({ theme, big }: { theme: Theme; big?: boolean }) {
  return (
    <span className={`st-theme-swatch${big ? ' big' : ''}`} style={{ background: theme.bg }} aria-hidden="true">
      <i style={{ background: theme.main }} />
      <i style={{ background: theme.sub }} />
      <i style={{ background: theme.text }} />
    </span>
  );
}

/** The theme in use on top, then every theme as a name with its swatch; hovering one previews it on the whole page. */
function ThemePicker({ current }: { current: string }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ThemeFilter>('all');
  const previewing = useRef(false);
  const restore = () => {
    if (previewing.current) applyTheme(current, false);
    previewing.current = false;
  };
  const preview = (t: Theme) => {
    previewing.current = true;
    applyTheme(t.name, false);
  };
  const shown = useMemo(() => {
    const test = THEME_FILTERS.find((f) => f.value === filter)!.test;
    const q = query.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return THEMES.filter((t) => test(t) && t.name.includes(q));
  }, [query, filter]);
  const now = THEMES.find((t) => t.name === current);
  const shuffle = () => {
    // random within the current filter when it has more than the active theme
    const pool = shown.filter((t) => t.name !== current);
    const next = pool.length ? pool[Math.floor(Math.random() * pool.length)] : randomTheme(current);
    previewing.current = false;
    updateSettings({ theme: next.name });
  };
  return (
    <Group title="theme">
      {now && (
        <div className="st-theme-now">
          <ThemeSwatch theme={now} big />
          <div className="st-theme-now-text">
            <span className="name">{themeLabel(now.name)}</span>
            <span className="meta">
              {isLightTheme(now) ? 'light' : 'dark'}
              {now.original && ' - a cubetype original'}
            </span>
          </div>
          <button className="btn-text st-random" onClick={shuffle} data-tip="a random theme from the list below">
            <ArrowsRightLeftIcon width={16} height={16} /> random
          </button>
        </div>
      )}
      <div className="st-theme-tools">
        <div className="st-options" role="group" aria-label="show">
          {THEME_FILTERS.map((f) => (
            <button key={f.value} className={`btn-text${f.value === filter ? ' active' : ''}`} onClick={() => setFilter(f.value)} aria-pressed={f.value === filter}>
              {f.label}
            </button>
          ))}
        </div>
        <label className="st-theme-search">
          <MagnifyingGlassIcon width={14} height={14} aria-hidden="true" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search themes" aria-label="search themes" />
        </label>
        <span className="st-theme-count">
          {shown.length} / {THEMES.length}
        </span>
      </div>
      {shown.length === 0 ? (
        <div className="st-theme-empty">no themes match "{query}"</div>
      ) : (
        <div className="st-themes" onMouseLeave={restore} role="radiogroup" aria-label="theme">
          {shown.map((t) => (
            <button
              key={t.name}
              role="radio"
              aria-checked={t.name === current}
              className={`st-theme${t.name === current ? ' active' : ''}`}
              onMouseEnter={() => preview(t)}
              onFocus={() => preview(t)}
              onBlur={restore}
              onClick={() => {
                previewing.current = false;
                updateSettings({ theme: t.name });
              }}
            >
              <ThemeSwatch theme={t} />
              <span className="st-theme-name">{themeLabel(t.name)}</span>
              {t.original && <CubeIcon width={12} height={12} className="st-theme-original" aria-label="cubetype original" aria-hidden={false} />}
            </button>
          ))}
        </div>
      )}
    </Group>
  );
}

function DataTools({ loggedIn }: { loggedIn: boolean }) {
  const [parsed, setParsed] = useState<({ file: string } & TimerImport) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'import' | 'export' | 'export-cstimer' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const summary = useMemo(() => {
    if (!parsed) return null;
    const solves = parsed.sessions.reduce((a, x) => a + x.solves.length, 0);
    const events = Array.from(new Set(parsed.sessions.map((x) => x.event))).map((e) => EVENTS.find((ev) => ev.id === e)?.short.toLowerCase() ?? e);
    return { solves, events };
  }, [parsed]);

  const onFile = async (f: File | undefined) => {
    setError(null);
    setParsed(null);
    if (!f) return;
    try {
      // bytes, not text: DCTimer backups are SQLite files
      setParsed({ file: f.name, ...parseTimerFile(new Uint8Array(await f.arrayBuffer())) });
    } catch (e) {
      setError(e instanceof CsTimerFormatError ? e.message : 'Could not read that file.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const doImport = async () => {
    if (!parsed) return;
    setBusy('import');
    setError(null);
    try {
      const r = await importSessions(parsed.sessions);
      toast.success(`imported ${formatNumber(r.solves)} solves in ${r.sessions} session${r.sessions === 1 ? '' : 's'}`);
      setParsed(null);
    } catch (e) {
      setError((e as Error).message || 'import failed');
    } finally {
      setBusy(null);
    }
  };

  const doExport = async (format: 'json' | 'cstimer') => {
    setBusy(format === 'json' ? 'export' : 'export-cstimer');
    try {
      const data = await exportAll();
      if (format === 'json') download(`cubetype-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data));
      else download(csTimerFileName(), toCsTimerExport(data.sessions));
      const n = data.sessions.reduce((a, x) => a + x.solves.length, 0);
      toast.success(`exported ${formatNumber(n)} solves`);
    } catch (e) {
      toast.error((e as Error).message || 'export failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Group title="data">
        <SettingRow
          title="import"
          wide={parsed !== null}
          description={
            <>
              A cubetype export, or any file csTimer can import: csTimer (<span className="text">export -&gt; export to file</span>), Twisty Timer, Cubic Timer, Block Keeper,
              CubeDesk, DCTimer, mateus Cubetimer or GAN CubeStation. Each session becomes a cubetype session {loggedIn ? 'in your account' : 'in this browser'}.
            </>
          }
        >
          <div className="st-import">
            <input ref={fileRef} type="file" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
            {!parsed ? (
              <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
                <ArrowUpTrayIcon width={16} height={16} /> choose file
              </button>
            ) : (
              <div className="st-import-preview">
                <div>
                  <span className="text">{parsed.file}</span> ({parsed.format})
                  <br />
                  <span className="main">{formatNumber(summary?.solves ?? 0)} solves</span> - {parsed.sessions.length} session{parsed.sessions.length === 1 ? '' : 's'} -{' '}
                  {summary?.events.join(', ')}
                  {skippedNotes(parsed.skipped).map((note) => (
                    <span key={note}>
                      <br />
                      {note}
                    </span>
                  ))}
                </div>
                <div className="row">
                  <button className="btn" onClick={() => setParsed(null)} disabled={busy !== null}>
                    cancel
                  </button>
                  <button className="btn primary" onClick={doImport} disabled={busy !== null}>
                    {busy === 'import' ? 'importing...' : 'import'}
                  </button>
                </div>
              </div>
            )}
            {error && <div className="error small">{error}</div>}
          </div>
        </SettingRow>
        <SettingRow
          title="export"
          description={
            <>
              Every session and solve. JSON re-imports here or on another cubetype server; the csTimer file goes into csTimer with{' '}
              <span className="text">export -&gt; import session(s) from other timers</span>, which adds sessions without replacing yours.
            </>
          }
        >
          <button className="btn" onClick={() => void doExport('json')} disabled={busy !== null}>
            <ArrowDownTrayIcon width={16} height={16} /> {busy === 'export' ? 'exporting...' : 'json'}
          </button>
          <button className="btn" onClick={() => void doExport('cstimer')} disabled={busy !== null}>
            <ArrowDownTrayIcon width={16} height={16} /> {busy === 'export-cstimer' ? 'exporting...' : 'csTimer'}
          </button>
        </SettingRow>
      </Group>
      <Group title="account">
        <SettingRow
          title={loggedIn ? 'account page' : 'sync and leaderboards'}
          description={loggedIn ? 'Profile, PB history, activity and more data tools live on your account page.' : 'Sync your solves across devices, get on the leaderboards and race others.'}
        >
          <Link className="btn" to={loggedIn ? '/account' : '/login'}>
            {loggedIn ? 'open account' : 'sign in'} <ArrowUpRightIcon width={16} height={16} />
          </Link>
        </SettingRow>
      </Group>
    </>
  );
}
