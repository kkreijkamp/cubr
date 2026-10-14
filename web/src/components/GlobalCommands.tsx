import { useNavigate } from 'react-router-dom';
import { Activity, CalendarDays, Crown, Eye, Globe, Info, LogIn, LogOut, Palette, Settings, Swords, Timer, Type, User, Zap } from 'lucide-react';
import { useRegisterCommands, type Command } from '../lib/commands';
import { useAuth } from '../lib/auth';
import { FONTS, updateSettings, useSettings, type Settings as S } from '../lib/settings';
import { applyTheme, getTheme, THEMES, themeLabel } from '../lib/themes';

function ThemeBubbles({ name }: { name: string }) {
  const t = getTheme(name);
  return (
    <span className="bubbles" style={{ background: t.bg }}>
      <i style={{ background: t.main }} />
    </span>
  );
}

function options<K extends keyof S>(key: K, label: string, values: { value: S[K]; label: string }[], current: S[K]): Command {
  return {
    id: `setting-${String(key)}`,
    label: `${label}…`,
    icon: <Settings />,
    keywords: ['setting'],
    children: () =>
      values.map((v) => ({
        id: `setting-${String(key)}-${String(v.value)}`,
        label: v.label,
        active: v.value === current,
        run: () => updateSettings({ [key]: v.value } as Partial<S>),
      })),
  };
}

/** App-wide palette commands: navigation, theme/font with live preview, timer settings, auth. */
export function GlobalCommands() {
  const navigate = useNavigate();
  const settings = useSettings();
  const { user, logout } = useAuth();

  useRegisterCommands(
    'global',
    () => {
      const go = (path: string) => () => navigate(path);
      const nav: Command[] = [
        { id: 'go-timer', label: 'Go to timer', icon: <Timer />, run: go('/') },
        { id: 'go-daily', label: 'Go to daily challenge', icon: <CalendarDays />, run: go('/daily') },
        { id: 'go-race', label: 'Go to race rooms', icon: <Swords />, keywords: ['multiplayer'], run: go('/race') },
        { id: 'go-lb', label: 'Go to leaderboards', icon: <Crown />, run: go('/leaderboards') },
        { id: 'go-wca', label: 'Go to WCA rankings', icon: <Globe />, run: go('/wca') },
        { id: 'go-settings', label: 'Go to settings', icon: <Settings />, run: go('/settings') },
        { id: 'go-status', label: 'Go to cluster status', icon: <Activity />, keywords: ['kubernetes', 'pods'], run: go('/status') },
        { id: 'go-about', label: 'Go to about', icon: <Info />, run: go('/about') },
      ];
      const theme: Command = {
        id: 'theme',
        label: 'Theme…',
        icon: <Palette />,
        keywords: ['color', 'colour'],
        children: () =>
          THEMES.map((t) => ({
            id: `theme-${t.name}`,
            label: themeLabel(t.name),
            icon: <ThemeBubbles name={t.name} />,
            active: settings.theme === t.name,
            preview: () => applyTheme(t.name, false),
            run: () => updateSettings({ theme: t.name }),
          })),
      };
      const font: Command = {
        id: 'font',
        label: 'Font…',
        icon: <Type />,
        children: () => FONTS.map((f) => ({ id: `font-${f.name}`, label: f.name, active: settings.font === f.name, run: () => updateSettings({ font: f.name }) })),
      };
      const timer: Command[] = [
        options('inspection', 'Inspection', [{ value: false, label: 'off' }, { value: true, label: 'on (WCA 15s)' }], settings.inspection),
        options('holdMs', 'Hold to start', [0, 300, 550, 1000].map((v) => ({ value: v, label: `${v} ms` })), settings.holdMs),
        options(
          'timerUpdate',
          'Timer update',
          [
            { value: 'realtime', label: 'realtime' },
            { value: 'tenths', label: 'tenths' },
            { value: 'seconds', label: 'seconds' },
            { value: 'hidden', label: 'hidden while solving' },
          ],
          settings.timerUpdate,
        ),
        options('precision', 'Precision', [{ value: 2, label: '0.01 (centiseconds)' }, { value: 3, label: '0.001 (milliseconds)' }], settings.precision),
        options('scramblePreview', 'Scramble preview', [{ value: 'off', label: 'off' }, { value: '2D', label: '2D' }, { value: '3D', label: '3D' }], settings.scramblePreview),
        { ...options('focusMode', 'Focus mode', [{ value: true, label: 'on' }, { value: false, label: 'off' }], settings.focusMode), icon: <Eye /> },
        { ...options('inspectionAlerts', 'Inspection alerts', [{ value: 'off', label: 'off' }, { value: 'beep', label: 'beep' }, { value: 'voice', label: 'voice' }], settings.inspectionAlerts), icon: <Zap /> },
      ];
      const auth: Command[] = user
        ? [
            { id: 'go-account', label: 'Go to account', icon: <User />, run: go('/account') },
            { id: 'logout', label: 'Log out', icon: <LogOut />, run: () => void logout() },
          ]
        : [{ id: 'login', label: 'Log in / register', icon: <LogIn />, run: go('/login') }];
      return [theme, font, ...timer, ...nav, ...auth];
    },
    [settings, user, navigate, logout],
  );
  return null;
}
