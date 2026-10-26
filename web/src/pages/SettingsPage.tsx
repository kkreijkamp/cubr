import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AdjustmentsHorizontalIcon,
  ArrowDownTrayIcon,
  ArrowUpRightIcon,
  ArrowUpTrayIcon,
  ArrowUturnLeftIcon,
  ArrowsPointingOutIcon,
  ArrowsRightLeftIcon,
  BellIcon,
  BoldIcon,
  CalculatorIcon,
  CircleStackIcon,
  ClockIcon,
  CommandLineIcon,
  CubeIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  HandRaisedIcon,
  HashtagIcon,
  ListBulletIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  SpeakerWaveIcon,
  SwatchIcon,
  TrashIcon,
  UserMinusIcon,
} from '@heroicons/react/24/outline';
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

const SECTIONS = [
  { id: 'timer', label: 'timer', icon: ClockIcon },
  { id: 'inspection', label: 'inspection', icon: EyeIcon },
  { id: 'display', label: 'display', icon: ArrowsPointingOutIcon },
  { id: 'stats', label: 'stats', icon: CalculatorIcon },
  { id: 'theme', label: 'theme', icon: SwatchIcon },
  { id: 'data', label: 'data', icon: CircleStackIcon },
  { id: 'shortcuts', label: 'shortcuts', icon: CommandLineIcon },
  { id: 'danger', label: 'danger zone', icon: ExclamationTriangleIcon },
] as const;

interface RowProps {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  description: ReactNode;
  wide?: boolean;
}

/** Monkeytype setting row: title + description on the left, controls on the right. */
function SettingRow({ icon, title, description, children, wide }: RowProps) {
  return (
    <div className={`st-row${wide ? ' wide' : ''}`}>
      <div className="st-text">
        <h3 className="h3">
          {icon}
          {title}
        </h3>
        <div className="st-desc">{description}</div>
      </div>
      <div className="st-controls">{children}</div>
    </div>
  );
}

function Options<T extends string | number | boolean>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="option-group">
      {options.map((o) => (
        <button key={String(o.value)} className={`btn${o.value === value ? ' active' : ''}`} onClick={() => onChange(o.value)} aria-pressed={o.value === value}>
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

// csTimer's shortcuts (all of them), then cubetype's own on keys csTimer leaves free
const SHORTCUTS: [ReactNode, string][] = [
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

export default function SettingsPage() {
  const s = useSettings();
  const { status, user } = useAuth();
  const navigate = useNavigate();
  const solveState = useSolveState();
  const [confirm, setConfirm] = useState<'clear' | 'reset' | 'account' | null>(null);
  const [local, setLocal] = useState(() => localDataSummary());

  useEffect(() => setLocal(localDataSummary()), [solveState.sessions, solveState.solves]);
  // never leave a hover preview applied when navigating away
  useEffect(() => () => applyVisualSettings(), []);

  return (
    <div className="settings-page">
      <nav className="st-quicknav" aria-label="settings sections">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button key={id} className="btn-text" onClick={() => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            <Icon width={14} height={14} /> {label}
          </button>
        ))}
      </nav>

      <Section id="timer" title="timer">
        <SettingRow icon={<HandRaisedIcon width={16} height={16} />} title="hold to start" description="How long space (or your finger) must be held before the timer turns green and is ready to start. Stops accidental starts.">
          <Options value={s.holdMs} options={[0, 300, 550, 1000].map((v) => ({ value: v, label: v === 0 ? 'off' : `${v / 1000}s` }))} onChange={set('holdMs')} />
        </SettingRow>
        <SettingRow icon={<AdjustmentsHorizontalIcon width={16} height={16} />} title="timer update" description="What the timer shows while you solve. Hiding the time helps you stay relaxed instead of watching the clock.">
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
        <SettingRow icon={<HashtagIcon width={16} height={16} />} title="precision" description="Decimal places for times and averages. Singles are truncated, averages rounded like the WCA.">
          <Options
            value={s.precision}
            options={[
              { value: 2, label: '0.01' },
              { value: 3, label: '0.001' },
            ]}
            onChange={set('precision')}
          />
        </SettingRow>
        <SettingRow icon={<ArrowsPointingOutIcon width={16} height={16} />} title="timer size" description="Size of the big timer on the timer page.">
          <div className="st-size">
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
            <div className="st-size-preview" style={{ fontSize: `${s.timerSize * 0.38}rem` }}>
              12.34
            </div>
          </div>
        </SettingRow>
        <SettingRow icon={<EyeIcon width={16} height={16} />} title="focus mode" description="Fade out everything except the timer while you inspect and solve.">
          <Options value={s.focusMode} options={onOff} onChange={set('focusMode')} />
        </SettingRow>
      </Section>

      <Section id="inspection" title="inspection">
        <SettingRow icon={<ClockIcon width={16} height={16} />} title="WCA inspection" description="15 seconds of inspection before each solve. Starting after 15 s adds +2, after 17 s the solve is a DNF (WCA A4d).">
          <Options
            value={s.inspection}
            options={[
              { value: true, label: 'on' },
              { value: false, label: 'off' },
            ]}
            onChange={set('inspection')}
          />
        </SettingRow>
        <SettingRow icon={<BellIcon width={16} height={16} />} title="inspection alerts" description="Called out at 8 and 12 seconds, like a judge at a competition.">
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
      </Section>

      <Section id="display" title="display">
        <SettingRow icon={<EyeIcon width={16} height={16} />} title="scramble preview" description="Draw the scrambled puzzle next to your stats so you can check you scrambled correctly.">
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
        <SettingRow
          icon={<SwatchIcon width={16} height={16} />}
          title="sticker colours"
          description="The colours of the 2D scramble preview: the standard colour scheme, or your own colour for each face of each puzzle. The 3D preview always uses the standard colours."
        >
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
        <SettingRow icon={<ListBulletIcon width={16} height={16} />} title="solve list" description="Show the list of solves in the current session on the timer page.">
          <Options value={s.showSolveList} options={onOff} onChange={set('showSolveList')} />
        </SettingRow>
        <SettingRow icon={<BoldIcon width={16} height={16} />} title="font" description="One font for the whole app." wide>
          <div className="option-group wide st-fonts">
            {FONTS.map((f) => (
              <button
                key={f.name}
                className={`btn${s.font === f.name ? ' active' : ''}`}
                style={{ fontFamily: f.css }}
                onClick={() => updateSettings({ font: f.name })}
              >
                {f.name.toLowerCase()}
              </button>
            ))}
          </div>
        </SettingRow>
      </Section>

      <Section id="stats" title="stats">
        <SettingRow icon={<CalculatorIcon width={16} height={16} />} title="averages shown" description="Which averages appear in the stats panel. Averages trim the best and worst 5 % (at least one each side); mo3 is a plain mean.">
          <div className="st-chips">
            {AVG_CHOICES.map((k) => {
              const on = s.statsShown.includes(k);
              return (
                <button
                  key={k}
                  className={`btn${on ? ' active' : ''}`}
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
        <SettingRow icon={<TrashIcon width={16} height={16} />} title="confirm delete" description="Ask before deleting a solve with alt+z (or ctrl+z, alt+backspace) or from the solve window.">
          <Options value={s.confirmDelete} options={onOff} onChange={set('confirmDelete')} />
        </SettingRow>
        <SettingRow
          icon={<SpeakerWaveIcon width={16} height={16} />}
          title="pb sound"
          description={
            <>
              Play a short chime when you set a new personal best.{' '}
              <button className="btn-text st-inline" onClick={playPbSound}>
                <PlayIcon width={12} height={12} /> preview
              </button>
            </>
          }
        >
          <Options value={s.pbSound} options={onOff} onChange={set('pbSound')} />
        </SettingRow>
      </Section>

      <Section id="theme" title="theme">
        <ThemeGrid current={s.theme} />
      </Section>

      <Section id="data" title="data">
        <DataTools loggedIn={status === 'authed'} />
      </Section>

      <Section id="shortcuts" title="keyboard shortcuts">
        <div className="st-desc">
          All of csTimer's shortcuts work the same here, so your habits carry over. The last five are cubetype's own. Some browsers use ctrl+1/2/3 to switch tabs and don't pass them on; the penalty buttons under the timer do the same job.
        </div>
        <div className="st-shortcuts">
          {SHORTCUTS.map(([keys, label], i) => (
            <div key={i} className="st-shortcut">
              <span className="keys">{keys}</span>
              <span className="what">{label}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id="danger" title="danger zone">
        <SettingRow
          icon={<TrashIcon width={16} height={16} />}
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
          <button className="btn danger" onClick={() => setConfirm('clear')} disabled={local.solves === 0 && local.sessions <= 1}>
            clear guest data
          </button>
        </SettingRow>
        <SettingRow icon={<ArrowUturnLeftIcon width={16} height={16} />} title="reset settings" description="Put every setting on this page back to its default (your solves are kept).">
          <button className="btn danger" onClick={() => setConfirm('reset')}>
            reset settings
          </button>
        </SettingRow>
        {status === 'authed' && user && (
          <SettingRow
            icon={<UserMinusIcon width={16} height={16} />}
            title="delete account"
            description={
              <>
                Delete <span className="main">{user.username}</span> and everything in it: your solves and sessions, stats, leaderboard places, profile and settings. Export your
                solves first (data, above) if you want to keep them. Guest data in this browser is not affected. <span className="error">You can't undo this.</span>
              </>
            }
          >
            <button className="btn danger" onClick={() => setConfirm('account')}>
              delete account
            </button>
          </SettingRow>
        )}
      </Section>

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

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="st-section" id={`settings-${id}`} aria-labelledby={`settings-${id}-title`}>
      <h2 className="st-section-title" id={`settings-${id}-title`}>
        {title}
      </h2>
      <div className="st-section-body">{children}</div>
    </section>
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

function ThemeGrid({ current }: { current: string }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ThemeFilter>('all');
  const previewing = useRef(false);
  const restore = () => {
    if (previewing.current) applyTheme(current, false);
    previewing.current = false;
  };
  const shown = useMemo(() => {
    const test = THEME_FILTERS.find((f) => f.value === filter)!.test;
    const q = query.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return THEMES.filter((t) => test(t) && t.name.includes(q));
  }, [query, filter]);
  const shuffle = () => {
    // random within the current filter when it has more than the active theme
    const pool = shown.filter((t) => t.name !== current);
    const next = pool.length ? pool[Math.floor(Math.random() * pool.length)] : randomTheme(current);
    previewing.current = false;
    updateSettings({ theme: next.name });
  };
  return (
    <div className="st-theme-picker">
      <div className="st-theme-tools">
        <label className="st-theme-search">
          <MagnifyingGlassIcon width={14} height={14} aria-hidden="true" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search themes" aria-label="search themes" />
        </label>
        <div className="st-theme-filters">
          {THEME_FILTERS.map((f) => (
            <button key={f.value} className={`btn${f.value === filter ? ' active' : ''}`} onClick={() => setFilter(f.value)} aria-pressed={f.value === filter}>
              {f.value === 'originals' && <CubeIcon width={14} height={14} />}
              {f.label}
            </button>
          ))}
        </div>
        <button className="btn" onClick={shuffle} data-tip="pick a random theme from this list">
          <ArrowsRightLeftIcon width={14} height={14} /> random
        </button>
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
              style={{ background: t.bg, color: t.text }}
              onMouseEnter={() => {
                previewing.current = true;
                applyTheme(t.name, false);
              }}
              onFocus={() => {
                previewing.current = true;
                applyTheme(t.name, false);
              }}
              onBlur={restore}
              onClick={() => {
                previewing.current = false;
                updateSettings({ theme: t.name });
              }}
            >
              <span className="st-theme-name">
                {t.original && <CubeIcon width={11} height={11} className="st-theme-original" style={{ color: t.main }} aria-label="cubetype original" aria-hidden={false} />}
                {themeLabel(t.name)}
              </span>
              <span className="st-theme-dots" aria-hidden="true">
                <i style={{ background: t.main }} />
                <i style={{ background: t.sub }} />
                <i style={{ background: t.text }} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
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
      <SettingRow
        icon={<ArrowUpTrayIcon width={16} height={16} />}
        title="import solves"
        description={
          <>
            A cubetype export, or any file csTimer can import: csTimer (<span className="text">export -&gt; export to file</span>), Twisty Timer, Cubic Timer,
            Block Keeper, CubeDesk, DCTimer, mateus Cubetimer or GAN CubeStation. Each session becomes a cubetype session{' '}
            {loggedIn ? 'in your account' : 'in this browser'}.
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
              <div className="small">
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
        icon={<ArrowDownTrayIcon width={16} height={16} />}
        title="export"
        description={
          <>
            Every session and solve. JSON re-imports here or on another cubetype server; the csTimer file goes into csTimer with{' '}
            <span className="text">export -&gt; import session(s) from other timers</span>, which adds sessions without replacing yours.
          </>
        }
      >
        <div className="row">
          <button className="btn" onClick={() => void doExport('json')} disabled={busy !== null}>
            <ArrowDownTrayIcon width={16} height={16} /> {busy === 'export' ? 'exporting...' : 'export json'}
          </button>
          <button className="btn" onClick={() => void doExport('cstimer')} disabled={busy !== null}>
            <ArrowDownTrayIcon width={16} height={16} /> {busy === 'export-cstimer' ? 'exporting...' : 'export for csTimer'}
          </button>
        </div>
      </SettingRow>
      <SettingRow
        icon={<CircleStackIcon width={16} height={16} />}
        title="account"
        description={loggedIn ? 'Profile, PB history, activity and more data tools live on your account page.' : 'Sign in to sync your solves across devices, get on the leaderboards and race others.'}
      >
        <Link className="btn" to={loggedIn ? '/account' : '/login'}>
          {loggedIn ? 'open account' : 'sign in'} <ArrowUpRightIcon width={16} height={16} />
        </Link>
      </SettingRow>
    </>
  );
}
