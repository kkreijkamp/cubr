import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, Eye, Gauge, Hand, Hash, List, Maximize2, Palette, RotateCcw, Sigma, Timer, Trash2, TriangleAlert, Type } from 'lucide-react';
import { ConfirmModal } from '../components/timer/Dialogs';
import { AVG_CHOICES, parseAvgKey } from '../components/timer/statsUtil';
import '../components/timer/settings-page.css';
import { applyVisualSettings, DEFAULT_SETTINGS, FONTS, updateSettings, useSettings, type Settings } from '../lib/settings';
import { applyTheme, THEMES, themeLabel } from '../lib/themes';
import { toast } from '../lib/toast';

const SECTIONS = [
  { id: 'timer', label: 'timer', icon: Timer },
  { id: 'inspection', label: 'inspection', icon: Eye },
  { id: 'display', label: 'display', icon: Maximize2 },
  { id: 'stats', label: 'stats', icon: Sigma },
  { id: 'theme', label: 'theme', icon: Palette },
  { id: 'danger', label: 'danger zone', icon: TriangleAlert },
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

export default function SettingsPage() {
  const s = useSettings();
  const [confirm, setConfirm] = useState<'reset' | null>(null);

  // never leave a hover preview applied when navigating away
  useEffect(() => () => applyVisualSettings(), []);

  return (
    <div className="settings-page">
      <nav className="st-quicknav" aria-label="settings sections">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button key={id} className="btn-text" onClick={() => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </nav>

      <Section id="timer" title="timer">
        <SettingRow icon={<Hand size={16} />} title="hold to start" description="How long space (or your finger) must be held before the timer turns green and is ready to start. Stops accidental starts.">
          <Options value={s.holdMs} options={[0, 300, 550, 1000].map((v) => ({ value: v, label: v === 0 ? 'off' : `${v / 1000}s` }))} onChange={set('holdMs')} />
        </SettingRow>
        <SettingRow icon={<Gauge size={16} />} title="timer update" description="What the timer shows while you solve. Hiding the time helps you stay relaxed instead of watching the clock.">
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
        <SettingRow icon={<Hash size={16} />} title="precision" description="Decimal places for times and averages. Singles are truncated, averages rounded — like the WCA.">
          <Options
            value={s.precision}
            options={[
              { value: 2, label: '0.01' },
              { value: 3, label: '0.001' },
            ]}
            onChange={set('precision')}
          />
        </SettingRow>
        <SettingRow icon={<Maximize2 size={16} />} title="timer size" description="Size of the big timer on the timer page.">
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
      </Section>

      <Section id="inspection" title="inspection">
        <SettingRow icon={<Timer size={16} />} title="WCA inspection" description="15 seconds of inspection before each solve. Starting after 15 s adds +2, after 17 s the solve is a DNF (WCA A4d).">
          <Options
            value={s.inspection}
            options={[
              { value: true, label: 'on' },
              { value: false, label: 'off' },
            ]}
            onChange={set('inspection')}
          />
        </SettingRow>
        <SettingRow icon={<Bell size={16} />} title="inspection alerts" description="Called out at 8 and 12 seconds, like a judge at a competition.">
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
        <SettingRow icon={<List size={16} />} title="solve list" description="Show the list of solves in the current session on the timer page.">
          <Options value={s.showSolveList} options={onOff} onChange={set('showSolveList')} />
        </SettingRow>
        <SettingRow icon={<Type size={16} />} title="font" description="One font for the whole app. Hover to preview." wide>
          <div className="option-group wide st-fonts" onMouseLeave={() => applyVisualSettings()}>
            {FONTS.map((f) => (
              <button
                key={f.name}
                className={`btn${s.font === f.name ? ' active' : ''}`}
                style={{ fontFamily: f.css }}
                onMouseEnter={() => document.documentElement.style.setProperty('--font', f.css)}
                onClick={() => updateSettings({ font: f.name })}
              >
                {f.name.toLowerCase()}
              </button>
            ))}
          </div>
        </SettingRow>
      </Section>

      <Section id="stats" title="stats">
        <SettingRow icon={<Sigma size={16} />} title="averages shown" description="Which averages appear in the stats panel. Averages trim the best and worst 5 % (at least one each side); mo3 is a plain mean.">
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
        <SettingRow icon={<Trash2 size={16} />} title="confirm delete" description="Ask before deleting a solve with alt+backspace or from the solve window.">
          <Options value={s.confirmDelete} options={onOff} onChange={set('confirmDelete')} />
        </SettingRow>
      </Section>

      <Section id="theme" title="theme">
        <ThemeGrid current={s.theme} />
      </Section>

      <Section id="danger" title="danger zone">
        <SettingRow icon={<RotateCcw size={16} />} title="reset settings" description="Put every setting on this page back to its default (your solves are kept).">
          <button className="btn danger" onClick={() => setConfirm('reset')}>
            reset settings
          </button>
        </SettingRow>
      </Section>

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

function ThemeGrid({ current }: { current: string }) {
  const previewing = useRef(false);
  const restore = () => {
    if (previewing.current) applyTheme(current, false);
    previewing.current = false;
  };
  return (
    <div className="st-themes" onMouseLeave={restore} role="radiogroup" aria-label="theme">
      {THEMES.map((t) => (
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
          <span className="st-theme-name">{themeLabel(t.name)}</span>
          <span className="st-theme-dots" aria-hidden="true">
            <i style={{ background: t.main }} />
            <i style={{ background: t.sub }} />
            <i style={{ background: t.text }} />
          </span>
        </button>
      ))}
    </div>
  );
}
