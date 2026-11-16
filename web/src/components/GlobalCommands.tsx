import { useNavigate } from 'react-router-dom';
import {
  ArrowRightEndOnRectangleIcon,
  ArrowRightStartOnRectangleIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowsRightLeftIcon,
  BoldIcon,
  BoltIcon,
  CalendarDaysIcon,
  ClockIcon,
  Cog6ToothIcon,
  EyeIcon,
  FlagIcon,
  GlobeAltIcon,
  InformationCircleIcon,
  SwatchIcon,
  TrophyIcon,
  UserIcon,
} from '@heroicons/react/24/outline';
import { useRegisterCommands, type Command } from '../lib/commands';
import { useAuth } from '../lib/auth';
import { FONTS, updateSettings, useSettings, type Settings as S } from '../lib/settings';
import { applyTheme, getTheme, isLightTheme, randomTheme, THEMES, themeLabel } from '../lib/themes';
import { applyUpdate, checkForUpdate, promptInstall, usePwa } from '../lib/pwa';
import { toast } from '../lib/toast';

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
    label: `${label}...`,
    icon: <Cog6ToothIcon />,
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

/** App-wide palette commands: navigation, theme (with live preview) and font, timer settings, auth. */
export function GlobalCommands() {
  const navigate = useNavigate();
  const settings = useSettings();
  const { user, logout } = useAuth();
  const pwa = usePwa();

  useRegisterCommands(
    'global',
    () => {
      const go = (path: string) => () => navigate(path);
      const nav: Command[] = [
        { id: 'go-timer', label: 'Go to timer', icon: <ClockIcon />, run: go('/') },
        { id: 'go-daily', label: 'Go to daily challenge', icon: <CalendarDaysIcon />, run: go('/daily') },
        { id: 'go-race', label: 'Go to race rooms', icon: <FlagIcon />, keywords: ['multiplayer'], run: go('/race') },
        { id: 'go-lb', label: 'Go to leaderboards', icon: <TrophyIcon />, run: go('/leaderboards') },
        { id: 'go-wca', label: 'Go to WCA rankings', icon: <GlobeAltIcon />, run: go('/wca') },
        { id: 'go-settings', label: 'Go to settings', icon: <Cog6ToothIcon />, run: go('/settings') },
        { id: 'go-about', label: 'Go to about', icon: <InformationCircleIcon />, run: go('/about') },
      ];
      const theme: Command = {
        id: 'theme',
        label: 'Theme...',
        icon: <SwatchIcon />,
        keywords: ['color', 'colour'],
        children: () => [
          ...(['', 'light', 'dark'] as const).map((kind) => ({
            id: `theme-random${kind && `-${kind}`}`,
            label: `random${kind && ` ${kind}`} theme`,
            icon: <ArrowsRightLeftIcon />,
            keywords: ['shuffle', 'surprise'],
            run: () => updateSettings({ theme: randomTheme(settings.theme, kind || undefined).name }),
          })),
          ...THEMES.map((t) => ({
            id: `theme-${t.name}`,
            label: themeLabel(t.name),
            icon: <ThemeBubbles name={t.name} />,
            // "theme light" / "theme dark" narrow the list
            keywords: [isLightTheme(t) ? 'light' : 'dark'],
            active: settings.theme === t.name,
            preview: () => applyTheme(t.name, false),
            run: () => updateSettings({ theme: t.name }),
          })),
        ],
      };
      const font: Command = {
        id: 'font',
        label: 'Font...',
        icon: <BoldIcon />,
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
        { ...options('stickerColours', 'Sticker colours', [{ value: 'default', label: 'default' }, { value: 'custom', label: 'custom (pick them in settings)' }], settings.stickerColours), icon: <SwatchIcon /> },
        { ...options('focusMode', 'Focus mode', [{ value: true, label: 'on' }, { value: false, label: 'off' }], settings.focusMode), icon: <EyeIcon /> },
        { ...options('inspectionAlerts', 'Inspection alerts', [{ value: 'off', label: 'off' }, { value: 'beep', label: 'beep' }, { value: 'voice', label: 'voice' }], settings.inspectionAlerts), icon: <BoltIcon /> },
      ];
      const auth: Command[] = user
        ? [
            { id: 'go-account', label: 'Go to account', icon: <UserIcon />, run: go('/account') },
            { id: 'logout', label: 'Log out', icon: <ArrowRightStartOnRectangleIcon />, run: () => void logout() },
          ]
        : [{ id: 'login', label: 'Log in / register', icon: <ArrowRightEndOnRectangleIcon />, run: go('/login') }];
      // the installable app (lib/pwa.ts)
      const app: Command[] = [
        ...(pwa.canInstall ? [{ id: 'app-install', label: 'Install cubr as an app', icon: <ArrowDownTrayIcon />, keywords: ['pwa', 'home screen', 'offline'], run: () => void promptInstall() }] : []),
        ...(pwa.update
          ? [{ id: 'app-update', label: 'Reload to update cubr', icon: <ArrowPathIcon />, keywords: ['new version', 'refresh'], run: () => applyUpdate() }]
          : pwa.offline !== 'off'
            ? [
                {
                  id: 'app-check',
                  label: 'Check for updates',
                  icon: <ArrowPathIcon />,
                  keywords: ['new version'],
                  run: () => {
                    void checkForUpdate().then((r) =>
                      toast.notice(r === 'none' ? 'cubr is up to date' : r === 'found' ? 'downloading the new version...' : "couldn't check for updates - offline?", { durationMs: 2500 }),
                    );
                  },
                },
              ]
            : []),
      ];
      return [theme, font, ...timer, ...nav, ...auth, ...app];
    },
    [settings, user, navigate, logout, pwa],
  );
  return null;
}
