import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUpRightIcon,
  ArrowUpTrayIcon,
  ArrowUturnLeftIcon,
  ArrowsRightLeftIcon,
  MagnifyingGlassIcon,
  PlayIcon,
} from '@heroicons/react/24/outline';
import { CsTimerFormatError, getEvent, parseTimerFile, toCsTimerExport, type TimerImport } from '@cubr/cubestats';
import { Modal } from '../components/Modal';
import { csTimerFileName, prefersReducedMotion, skippedNotes } from '../components/social/util';
import { ConfirmModal } from '../components/timer/Dialogs';
import { playPbSound } from '../components/timer/feedback';
import { AVG_CHOICES, parseAvgKey } from '../components/timer/statsUtil';
import '../components/timer/settings-page.css';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePageMeta } from '../lib/usePageMeta';
import { formatNumber } from '../lib/format';
import { useKeyboardLayout } from '../lib/keyboardLayout';
import { applyUpdate, checkForUpdate, installHint, promptInstall, usePwa } from '../lib/pwa';
import {
  activeTheme,
  applyVisualSettings,
  chooseRandomTheme,
  chooseTheme,
  DEFAULT_SETTINGS,
  FONTS,
  setAutoSwitchTheme,
  themeWaitsNote,
  updateSettings,
  useDeviceIsDark,
  useSettings,
  type Settings,
} from '../lib/settings';
import { SCHEMES, stickerColour, type Scheme } from '../lib/scrambleNet';
import { clearLocalData, exportAll, forgetUser, importSessions, localDataSummary, useSolveState } from '../lib/solves';
import { applyTheme, getTheme, isLightTheme, THEMES, themeLabel, type Theme } from '../lib/themes';
import { toast } from '../lib/toast';
import { AVAILABLE_INPUTS, INPUT_MODES, updateInput, useInputState } from '../input/inputMode';
import { actionOf, bind, BINDABLE, controls, KEY_PUZZLES, keyLabel, keyOf, type KeyPuzzle } from '../input/virtual/keymap';
import { modelFor, newModel, type PolyModel } from '../input/virtual/models';
import { puzzlePalette } from '../input/virtual/palette';
import { drawPoly } from '../input/virtual/render3d';
import { baseCamera } from '../components/timer/inputs/VirtualInput';

const PANES = [
  { id: 'timer', label: 'timer' },
  { id: 'display', label: 'display' },
  { id: 'stats', label: 'stats' },
  { id: 'theme', label: 'theme' },
  { id: 'data', label: 'data' },
  { id: 'app', label: 'app' },
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
function Options<T extends string | number | boolean>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="st-options">
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={`btn-text${o.value === value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
        >
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
      <kbd>ctrl</kbd>+<kbd>alt</kbd>+<kbd>t</kbd> <kbd>i</kbd> <kbd>s</kbd> <kbd>m</kbd>
    </>,
    'enter times with: the timer / typing / a stackmat / a moyu timer',
  ],
  [
    <>
      <kbd>ctrl</kbd>+<kbd>alt</kbd>+<kbd>v</kbd> <kbd>q</kbd> <kbd>g</kbd> <kbd>b</kbd>
    </>,
    'enter times with: a virtual puzzle / qcube / a smart cube / a bluetooth timer',
  ],
];

// cubr's own, on keys csTimer leaves free
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
  usePageMeta({ title: 'settings | cubr' });
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
    rail.scrollTo({ left: item.offsetLeft - (rail.clientWidth - item.offsetWidth) / 2, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
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
              <Options
                value={s.holdMs}
                options={[0, 300, 550, 1000].map((v) => ({ value: v, label: v === 0 ? 'off' : `${v / 1000}s` }))}
                onChange={set('holdMs')}
              />
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
          <InputGroup />
          <Group title="inspection">
            <SettingRow
              title="WCA inspection"
              description="15 seconds to inspect before each solve. Starting after 15 s adds +2, after 17 s the solve is a DNF (WCA A4d)."
            >
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
            <SettingRow
              title="sticker colours"
              description="The 2D preview's colours: the standard scheme, or your own colour for each face of each puzzle. 3D always uses the standard colours."
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
            <SettingRow
              title="averages shown"
              description="Which averages the stats panel shows. Averages trim the best and worst 5 % (at least one each side); mo3 is a plain mean."
              wide
            >
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
          <ThemePicker settings={s} />
        </Pane>

        <Pane id="data">
          <DataTools loggedIn={status === 'authed'} />
        </Pane>

        <Pane id="app">
          <AppGroup />
        </Pane>

        <Pane id="shortcuts">
          <Group title="shortcuts">
            <p className="st-note">
              All of csTimer's shortcuts work the same here, so your habits carry over. Some browsers use ctrl+1/2/3 to switch tabs and don't pass them on; the
              penalty buttons under the timer do the same job.
            </p>
            <KeyList keys={CSTIMER_KEYS} />
          </Group>
          <Group title="cubr's own">
            <KeyList keys={OWN_KEYS} />
          </Group>
          <VirtualKeys maps={s.virtualKeys} />
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
                    Delete <span className="main">{user.username}</span> and everything in it: your solves and sessions, stats, leaderboard places, profile and
                    settings. Export your solves first (data) if you want to keep them. Guest data in this browser is not affected.{' '}
                    <span className="error">You can't undo this.</span>
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

/** How times are entered (kept on this device), and the virtual puzzle's options. */
function InputGroup() {
  const s = useSettings();
  const device = useInputState();
  return (
    <>
      <Group title="input">
        <SettingRow
          title="enter times with"
          description="Kept on this device: a stackmat or a bluetooth cube belongs to one computer. Ctrl+alt and a letter switches on the timer page, as on csTimer."
          wide
        >
          <Options
            value={AVAILABLE_INPUTS.includes(device.mode) ? device.mode : 'timer'}
            options={INPUT_MODES.filter((m) => AVAILABLE_INPUTS.includes(m.id)).map((m) => ({ value: m.id, label: m.label }))}
            onChange={(mode) => updateInput({ mode })}
          />
        </SettingRow>
        <SettingRow
          title="stackmat status"
          description="Use the stackmat's status signals: hands on the mat, the green light. Off, a solve is the time counting up and stopping (csTimer's option, for timers that send no status)."
        >
          <Options value={s.stackmatStatus} options={onOff} onChange={set('stackmatStatus')} />
        </SettingRow>
        <SettingRow
          title="virtual turn speed"
          description="How long each turn of the virtual puzzle takes to animate (csTimer's base speed). Queued turns go quicker."
        >
          <Options
            value={s.virtualSpeed}
            options={[
              { value: 0, label: 'instant' },
              { value: 50, label: '20 tps' },
              { value: 100, label: '10 tps' },
              { value: 200, label: '5 tps' },
              { value: 500, label: '2 tps' },
            ]}
            onChange={set('virtualSpeed')}
          />
        </SettingRow>
        <SettingRow
          title="virtual cube view"
          description="Look at the top and front faces, or at the top front right corner. The arrow keys turn the view while you solve."
        >
          <Options
            value={s.virtualView}
            options={[
              { value: 'UF', label: 'top, front' },
              { value: 'URF', label: 'corner' },
            ]}
            onChange={set('virtualView')}
          />
        </SettingRow>
        <SettingRow
          title="floating stickers"
          description="The virtual and smart cubes drawn as csTimer draws them: stickers floating off a hollow cube, the far side seen through the gaps. Further right they float further apart; all the way left, a solid cube."
        >
          <CubePreview settings={s} />
          <Slider label="floating stickers" value={s.virtualFloat} zero="solid" onChange={set('virtualFloat')} />
        </SettingRow>
        <SettingRow
          title="sticker outline"
          description="The dark edge round each sticker of the virtual and smart cubes. Halfway is the cube's own; further right it's thicker, all the way left there's none."
        >
          <CubePreview settings={s} />
          <Slider label="sticker outline" value={s.virtualOutline} zero="none" onChange={set('virtualOutline')} />
        </SettingRow>
      </Group>
      <Group title="smart cube">
        <SettingRow
          title="mark scrambled"
          description="When the solve is ready to start: as soon as the cube matches the scramble, or that long after the last turn (scrambling it your own way), or only by key. Then the first turn starts the timer."
        >
          <Options
            value={s.smartScrambled}
            options={[
              { value: 'scramble', label: 'on the scramble' },
              { value: '2', label: '2 s' },
              { value: '3', label: '3 s' },
              { value: '4', label: '4 s' },
              { value: '5', label: '5 s' },
              { value: 'never', label: 'never' },
            ]}
            onChange={set('smartScrambled')}
          />
        </SettingRow>
        <SettingRow
          title="space marks scrambled"
          description="Press space when the cube is scrambled. A cube scrambled its own way gets a scramble worked out from its state."
        >
          <Options value={s.smartSpace} options={onOff} onChange={set('smartSpace')} />
        </SettingRow>
        <SettingRow
          title="turns mark scrambled"
          description="Or turn one face four times the same way (U U U U), or back and forth (U U' U U'), and it's marked a second later."
        >
          <Options
            value={s.smartTurnMark}
            options={[
              { value: 'off', label: 'off' },
              { value: 'x4', label: 'U U U U' },
              { value: 'xi2', label: "U U' U U'" },
            ]}
            onChange={set('smartTurnMark')}
          />
        </SettingRow>
        <SettingRow title="beep when scrambled" description="A beep as the cube is marked scrambled.">
          <Options value={s.smartBeep} options={onOff} onChange={set('smartBeep')} />
        </SettingRow>
        <SettingRow title="cube on screen" description="Draw the cube as it is, turning as you turn it.">
          <Options
            value={s.smartView}
            options={[
              { value: '3D', label: '3D' },
              { value: '2D', label: '2D' },
              { value: 'off', label: 'off' },
            ]}
            onChange={set('smartView')}
          />
        </SettingRow>
        <SettingRow
          title="unsolved on connect"
          description="A cube that connects in a state it hasn't been marked solved in: ask whether it's solved, mark it solved, or leave it."
        >
          <Options
            value={s.smartReset}
            options={[
              { value: 'ask', label: 'ask' },
              { value: 'always', label: 'mark solved' },
              { value: 'never', label: 'leave it' },
            ]}
            onChange={set('smartReset')}
          />
        </SettingRow>
      </Group>
    </>
  );
}

/** 0 to 100 in fives, the value beside it (`zero` names 0) */
function Slider({ label, value, zero, onChange }: { label: string; value: number; zero: string; onChange: (v: number) => void }) {
  const text = value === 0 ? zero : `${value}%`;
  return (
    <>
      <input
        className="st-range"
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={text}
      />
      <span className="st-range-value">{text}</span>
    </>
  );
}

/** a solved cube drawn as the virtual cube is, to see its look while setting it */
function CubePreview({ settings: s }: { settings: Settings }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const model = modelFor('333') as PolyModel;
    if (!canvas) return;
    const size = canvas.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.height = size * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    drawPoly(ctx, size, size, model.twisty.puzzle, model.solved(), baseCamera(model, s.virtualView), puzzlePalette('cube', s), [], {
      float: s.virtualFloat / 100,
      outline: s.virtualOutline / 50,
    });
  }, [s]);
  return <canvas ref={ref} className="st-float-preview" aria-hidden="true" />;
}

/** The virtual puzzles' keys, a puzzle at a time: click a move's key, then press the one you want. */
function VirtualKeys({ maps }: { maps: Settings['virtualKeys'] }) {
  const [puzzle, setPuzzle] = useState<KeyPuzzle>('cube');
  /** the move (by its csTimer key) waiting for a key */
  const [waiting, setWaiting] = useState<string | null>(null);
  const [note, setNote] = useState<ReactNode>(null);
  const layout = useKeyboardLayout();
  const model = useMemo(() => newModel(KEY_PUZZLES.find((p) => p.id === puzzle)!.event)!, [puzzle]);
  const list = useMemo(() => controls(model), [model]);
  const map = useMemo(() => maps[puzzle] ?? {}, [maps, puzzle]);
  const label = (code: string) => keyLabel(code, layout);
  const moveOf = (action: string) => list.find((c) => c.actions.includes(action))?.label ?? null;

  const save = (next: typeof map) => {
    const all = { ...maps, [puzzle]: next };
    if (Object.keys(next).length === 0) delete all[puzzle];
    updateSettings({ virtualKeys: all });
  };

  // the next key pressed is the move's (esc lets it be)
  useEffect(() => {
    if (!waiting) return;
    const onKey = (e: KeyboardEvent) => {
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setWaiting(null);
        setNote(null);
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey || !BINDABLE.test(e.code)) {
        setNote(<span className="error">that key has a job of its own - press another for {moveOf(waiting)} (esc keeps it)</span>);
        return;
      }
      const old = keyOf(map, waiting);
      const was = moveOf(actionOf(map, e.code));
      const move = moveOf(waiting);
      setWaiting(null);
      if (old === e.code) {
        setNote(null);
        return;
      }
      save(bind(map, waiting, e.code));
      setNote(
        <>
          <kbd>{label(e.code)}</kbd> turns {move} now
          {was ? (
            <>
              , and <kbd>{label(old)}</kbd> turns {was}
            </>
          ) : (
            <>
              ; <kbd>{label(old)}</kbd> does nothing
            </>
          )}
        </>,
      );
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const changed = Object.keys(map).length > 0;
  return (
    <Group title="virtual puzzle keys">
      <p className="st-note">
        Click a move's key, then press the key you want for it. If that key already turns something, the two swap. All cubes share one layout, named here as on
        a 3x3: on bigger cubes the slice keys turn the second layer, and the depth keys set how many layers the outer turns take.
      </p>
      <div className="st-bind-tools">
        <Options
          value={puzzle}
          options={KEY_PUZZLES.map((p) => ({ value: p.id, label: p.label }))}
          onChange={(p) => {
            setPuzzle(p);
            setWaiting(null);
            setNote(null);
          }}
        />
        <button
          className="btn-text"
          disabled={!changed}
          onClick={() => {
            save({});
            setWaiting(null);
            setNote(`${KEY_PUZZLES.find((p) => p.id === puzzle)!.label}: back to csTimer's keys`);
          }}
        >
          <ArrowUturnLeftIcon width={14} height={14} /> csTimer's keys
        </button>
      </div>
      <p className="st-bind-note" aria-live="polite">
        {note ??
          (waiting && (
            <>
              press a key for <span className="main">{moveOf(waiting)}</span> (esc keeps it)
            </>
          ))}
      </p>
      <div className="st-binds">
        {list.map((c) => (
          <div key={c.label} className="st-bind">
            <span className="st-bind-move">{c.label}</span>
            <span className="st-bind-keys">
              {c.actions.map((a) => {
                const code = keyOf(map, a);
                const on = waiting === a;
                return (
                  <button
                    key={a}
                    className={`st-bind-key${on ? ' waiting' : ''}${code !== a ? ' own' : ''}`}
                    aria-label={`${c.label}: ${label(code)}`}
                    aria-pressed={on}
                    onClick={() => {
                      setWaiting(on ? null : a);
                      setNote(null);
                    }}
                    onBlur={() => {
                      if (!on) return;
                      setWaiting(null);
                      setNote(null);
                    }}
                  >
                    <kbd>{on ? '...' : label(code)}</kbd>
                  </button>
                );
              })}
            </span>
          </div>
        ))}
      </div>
    </Group>
  );
}

/** Deleting the account: the password is asked again, then it's gone for good. */
function DeleteAccountModal({ username, onDeleted, onClose }: { username: string; onDeleted: () => void; onClose: () => void }) {
  const { deleteAccount, user } = useAuth();
  // an account made with Google, Apple or GitHub has no password: its username confirms instead
  const byName = user?.hasPassword === false;
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(byName ? { confirm: password } : { password });
      onDeleted();
    } catch (e) {
      const wrong = byName ? "that isn't your username" : 'wrong password';
      setError(e instanceof ApiError && e.status === 403 ? wrong : (e as Error).message || "couldn't delete the account, try again");
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
          Delete <span className="main">{username}</span> with all its solves, sessions, stats and leaderboard places?{' '}
          <span className="error">This can't be undone.</span>
        </div>
        <div className="field">
          <label htmlFor="delete-account-password">{byName ? 'type your username to confirm' : 'type your password to confirm'}</label>
          <input
            id="delete-account-password"
            type={byName ? 'text' : 'password'}
            autoComplete={byName ? 'off' : 'current-password'}
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
                    <input
                      type="color"
                      value={colour}
                      onChange={(e) => pick(scheme, i, e.target.value)}
                      aria-label={`${scheme.label}: ${f.name} face colour`}
                    />
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

type ThemeFilter = 'all' | 'dark' | 'light';

const THEME_FILTERS: { value: ThemeFilter; label: string; test: (t: Theme) => boolean }[] = [
  { value: 'all', label: 'all', test: () => true },
  { value: 'dark', label: 'dark', test: (t) => !isLightTheme(t) },
  { value: 'light', label: 'light', test: (t) => isLightTheme(t) },
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

/** A chosen theme: its swatch, its name and what it's for. */
function ThemeNow({ theme, meta, waiting }: { theme: Theme; meta: string; waiting?: boolean }) {
  return (
    <div className={`st-theme-now-item${waiting ? ' waiting' : ''}`}>
      <ThemeSwatch theme={theme} big />
      <div className="st-theme-now-text">
        <span className="name">{themeLabel(theme.name)}</span>
        <span className="meta">{meta}</span>
      </div>
    </div>
  );
}

/**
 * Following the device's light or dark mode (or not), the theme in use on top (while following, the light
 * and the dark one), then every theme as a name with its swatch; hovering one previews it on the whole page.
 */
function ThemePicker({ settings: s }: { settings: Settings }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ThemeFilter>('all');
  const deviceDark = useDeviceIsDark();
  const auto = s.autoSwitchTheme;
  const current = activeTheme(s, deviceDark);
  const previewing = useRef(false);
  const restore = () => {
    if (previewing.current) applyTheme(current);
    previewing.current = false;
  };
  const preview = (t: Theme) => {
    previewing.current = true;
    applyTheme(t.name);
  };
  const shown = useMemo(() => {
    const test = THEME_FILTERS.find((f) => f.value === filter)!.test;
    const q = query
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    return THEMES.filter((t) => test(t) && t.name.includes(q));
  }, [query, filter]);
  // following the device, both the light and the dark theme are chosen
  const chosen = (t: Theme) => (auto ? t.name === s.themeLight || t.name === s.themeDark : t.name === s.theme);
  const pick = (t: Theme) => {
    previewing.current = false;
    // a theme for the other mode waits for it, and the page stays as it is: say where it went
    const waits = chooseTheme(t.name);
    if (waits) toast.notice(themeWaitsNote(t.name, waits));
  };
  const shuffle = () => {
    previewing.current = false;
    // from the list below (its filter and search); following the device, a new light and a new dark theme,
    // both shown on top
    chooseRandomTheme(shown);
  };
  const manual = getTheme(s.theme);
  return (
    <Group title="theme">
      <SettingRow
        title="light and dark mode"
        description="Follow your device: a light theme while it's in light mode and a dark theme in dark mode. While this is on, a light theme you pick below becomes your light one, and a dark theme your dark one."
      >
        <Options value={auto} options={onOff} onChange={setAutoSwitchTheme} />
      </SettingRow>
      <SettingRow
        title="high contrast"
        description="Labels, links and errors in every theme at least 4.5:1 against the background (WCAG AA), so they're easier to read. Each theme keeps its look."
      >
        <Options value={s.highContrast === true} options={onOff} onChange={(v) => updateSettings({ highContrast: v })} />
      </SettingRow>
      <div className={`st-theme-now${auto ? ' pair' : ''}`}>
        {auto ? (
          <>
            <ThemeNow theme={getTheme(s.themeLight)} meta={deviceDark ? 'light mode' : 'light mode - in use'} waiting={deviceDark} />
            <ThemeNow theme={getTheme(s.themeDark)} meta={deviceDark ? 'dark mode - in use' : 'dark mode'} waiting={!deviceDark} />
          </>
        ) : (
          <ThemeNow theme={manual} meta={isLightTheme(manual) ? 'light' : 'dark'} />
        )}
        <button
          className="btn-text st-random"
          onClick={shuffle}
          data-tip={auto ? 'a random light and dark theme from the list below' : 'a random theme from the list below'}
          aria-label={auto ? 'random light and dark themes' : 'random theme'}
        >
          <ArrowsRightLeftIcon width={16} height={16} /> <span className="st-random-label">random</span>
        </button>
      </div>
      <div className="st-theme-tools">
        <div className="st-options" role="group" aria-label="show">
          {THEME_FILTERS.map((f) => (
            <button
              key={f.value}
              className={`btn-text${f.value === filter ? ' active' : ''}`}
              onClick={() => setFilter(f.value)}
              aria-pressed={f.value === filter}
            >
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
        // one theme is chosen (radios), or a light and a dark one while following the device (toggles)
        <div className="st-themes" onMouseLeave={restore} role={auto ? 'group' : 'radiogroup'} aria-label="theme">
          {shown.map((t) => (
            <button
              key={t.name}
              {...(auto ? { 'aria-pressed': chosen(t) } : { role: 'radio', 'aria-checked': chosen(t) })}
              className={`st-theme${chosen(t) ? ' active' : ''}`}
              onMouseEnter={() => preview(t)}
              onFocus={() => preview(t)}
              onBlur={restore}
              onClick={() => pick(t)}
            >
              <ThemeSwatch theme={t} />
              <span className="st-theme-name">{themeLabel(t.name)}</span>
            </button>
          ))}
        </div>
      )}
    </Group>
  );
}

/** The installable app (lib/pwa.ts): install it, whether it works offline here, and updates. */
function AppGroup() {
  const pwa = usePwa();
  const [check, setCheck] = useState<'idle' | 'checking' | 'found' | 'none' | 'failed'>('idle');
  const runCheck = async () => {
    setCheck('checking');
    setCheck(await checkForUpdate());
  };
  return (
    <Group title="app">
      <SettingRow
        title="install"
        description="Install cubr as an app: it gets its own window and an icon on your home screen, dock or start menu, and opens without the browser around it. Chrome, Edge and Safari can install it."
      >
        {pwa.standalone ? (
          <span className="st-status main">installed - you're using the app</span>
        ) : pwa.canInstall ? (
          <button className="btn" onClick={() => void promptInstall()}>
            <ArrowDownTrayIcon width={16} height={16} /> install cubr
          </button>
        ) : (
          <span className="st-status">{installHint()}</span>
        )}
      </SettingRow>
      <SettingRow
        title="offline"
        description="Once cubr is saved on this device, it opens and times without a connection: scrambles are made on the device, and solves in your account sync when you're back online. Leaderboards, races and profiles need a connection."
      >
        <span className={`st-status${pwa.offline === 'ready' ? ' main' : ''}`}>
          {{ ready: 'ready', saving: 'saving cubr...', off: 'not available in this browser' }[pwa.offline]}
        </span>
      </SettingRow>
      <SettingRow
        title="updates"
        description="New versions download in the background. A notice says when one is ready; it applies when you click the notice, or with the next link you follow."
      >
        {pwa.update ? (
          <button className="btn" onClick={() => applyUpdate()}>
            <ArrowPathIcon width={16} height={16} /> reload to update
          </button>
        ) : (
          <>
            {check === 'none' && <span className="st-status">up to date</span>}
            {check === 'found' && <span className="st-status">downloading...</span>}
            {check === 'failed' && <span className="st-status error">couldn't check - offline?</span>}
            <button className="btn" onClick={() => void runCheck()} disabled={pwa.offline === 'off' || check === 'checking'}>
              <ArrowPathIcon width={16} height={16} /> {check === 'checking' ? 'checking...' : 'check now'}
            </button>
          </>
        )}
      </SettingRow>
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
    const events = Array.from(new Set(parsed.sessions.map((x) => x.event))).map((e) => getEvent(e)?.short.toLowerCase() ?? e);
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
      if (format === 'json') download(`cubr-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data));
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
              A cubr export, or any file csTimer can import: csTimer (<span className="text">export -&gt; export to file</span>), Twisty Timer, Cubic Timer,
              Block Keeper, CubeDesk, DCTimer, mateus Cubetimer or GAN CubeStation. Each session becomes a cubr session{' '}
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
                <div>
                  <span className="text">{parsed.file}</span> ({parsed.format})
                  <br />
                  <span className="main">{formatNumber(summary?.solves ?? 0)} solves</span> - {parsed.sessions.length} session
                  {parsed.sessions.length === 1 ? '' : 's'} - {summary?.events.join(', ')}
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
              Every session and solve. JSON re-imports here or on another cubr server; the csTimer file goes into csTimer with{' '}
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
          description={
            loggedIn
              ? 'Profile, PB history, activity and more data tools live on your account page.'
              : 'Sync your solves across devices, get on the leaderboards and race others.'
          }
        >
          <Link className="btn" to={loggedIn ? '/account' : '/login'}>
            {loggedIn ? 'open account' : 'sign in'} <ArrowUpRightIcon width={16} height={16} />
          </Link>
        </SettingRow>
      </Group>
    </>
  );
}
