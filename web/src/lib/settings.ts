// User settings: persisted in localStorage for everyone, synced to the auth service
// (PUT /api/auth/me/settings) for logged-in users so they follow you across devices.
import { useSyncExternalStore } from 'react';
import { cleanKeyMaps, type KeyMaps } from '../input/virtual/keymap';
import { applyTheme, DEFAULT_DARK_THEME, DEFAULT_THEME, getTheme, isLightTheme, randomTheme, setHighContrast, themeColors, themeLabel, THEMES, type Theme } from './themes';
import { createStore, loadJson, saveJson, useStore } from './store';

export type TimerUpdate = 'realtime' | 'tenths' | 'seconds' | 'hidden';
export type PreviewMode = 'off' | '2D' | '3D';

export interface Settings {
  /** the theme, while autoSwitchTheme is off */
  theme: string;
  /** follow the device's light or dark mode (prefers-color-scheme): themeLight in light mode, themeDark in dark mode */
  autoSwitchTheme: boolean;
  /** the light theme used in light mode while autoSwitchTheme is on */
  themeLight: string;
  /** the dark theme used in dark mode while autoSwitchTheme is on */
  themeDark: string;
  /** labels, links and errors at 4.5:1 in every theme (lib/themes.ts highContrastTheme) */
  highContrast: boolean;
  font: string;
  /** WCA 15 s inspection before each solve */
  inspection: boolean;
  /** spoken/beeped "8 seconds" / "12 seconds" warnings during inspection */
  inspectionAlerts: 'off' | 'beep' | 'voice';
  /** how long space must be held before the timer is ready (ms) */
  holdMs: number;
  timerUpdate: TimerUpdate;
  /** decimal places: 2 = centiseconds, 3 = milliseconds */
  precision: 2 | 3;
  /** timer font size in rem */
  timerSize: number;
  scramblePreview: PreviewMode;
  /** the 2D scramble preview's sticker colours: cubr's, or your own (customStickers) */
  stickerColours: 'default' | 'custom';
  /** your own sticker colours: per scheme (lib/scrambleNet SCHEMES), one per face; gaps are the default */
  customStickers: Record<string, (string | null)[]>;
  /** fade the UI while solving */
  focusMode: boolean;
  /** which averages appear in the timer stats panel */
  statsShown: string[];
  confirmDelete: boolean;
  showSolveList: boolean;
  /** play a sound when you set a PB */
  pbSound: boolean;
  /** last used event (timer page) */
  lastEvent: string;
  /** virtual puzzle: ms per animated turn (0 = no animation), csTimer's "VRC base speed" */
  virtualSpeed: number;
  /** virtual cube camera: csTimer's orientation option (looking at the top and front, or the top front right corner) */
  virtualView: 'UF' | 'URF';
  /** virtual (and smart) cube: how far the stickers float off a hollow cube, as csTimer draws it (0-100; 0 = a solid cube) */
  virtualFloat: number;
  /** virtual (and smart) cube: the dark edge round each sticker (0-100; 50 = the cube's own, 0 = none) */
  virtualOutline: number;
  /** virtual puzzle: your own keys, per puzzle (input/virtual/keymap); none = csTimer's layout */
  virtualKeys: KeyMaps;
  /** smart cube: when a scramble counts as done (csTimer "mark scrambled after"): matching the scramble, n seconds without a move, or never */
  smartScrambled: 'scramble' | '2' | '3' | '4' | '5' | 'never';
  /** smart cube: space marks the cube as scrambled */
  smartSpace: boolean;
  /** smart cube: beep when the cube is marked scrambled */
  smartBeep: boolean;
  /** smart cube: show the cube on screen */
  smartView: '3D' | '2D' | 'off';
  /** smart cube: also mark it scrambled a second after one face is turned 4 times one way (x4) or back and forth (xi2) */
  smartTurnMark: 'off' | 'x4' | 'xi2';
  /** smart cube: on connecting to a cube that isn't solved, ask to mark it solved, always do, or never */
  smartReset: 'ask' | 'always' | 'never';
  /** stackmat: use the timer's status signals (hands on, green light) */
  stackmatStatus: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME,
  autoSwitchTheme: true,
  themeLight: DEFAULT_THEME,
  themeDark: DEFAULT_DARK_THEME,
  highContrast: false,
  font: 'Lexend Deca',
  inspection: false,
  inspectionAlerts: 'beep',
  holdMs: 300,
  timerUpdate: 'realtime',
  precision: 2,
  timerSize: 7,
  scramblePreview: '2D',
  stickerColours: 'default',
  customStickers: {},
  focusMode: true,
  statsShown: ['mo3', 'ao5', 'ao12', 'ao100'],
  confirmDelete: true,
  showSolveList: true,
  pbSound: true,
  lastEvent: '333',
  virtualSpeed: 100,
  virtualView: 'UF',
  virtualFloat: 30,
  virtualOutline: 50,
  virtualKeys: {},
  smartScrambled: 'scramble',
  smartSpace: true,
  smartBeep: true,
  smartView: '3D',
  smartTurnMark: 'off',
  smartReset: 'ask',
  stackmatStatus: true,
};

export interface FontOption {
  name: string;
  css: string;
  /** widest digit, when wider than the "0" (no tabular figures): sizes the timer's digit cells (default 1ch) */
  digitWidth?: string;
}

export const FONTS: FontOption[] = [
  { name: 'Lexend Deca', css: "'Lexend Deca', system-ui, sans-serif", digitWidth: '0.62em' },
  { name: 'Comfortaa', css: "'Comfortaa', system-ui, sans-serif", digitWidth: '0.65em' },
  { name: 'Roboto Mono', css: "'Roboto Mono', ui-monospace, monospace" },
  { name: 'System Mono', css: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  { name: 'System Sans', css: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' },
  { name: 'Georgia', css: 'Georgia, serif' },
];

const KEY = 'cubr.settings';

/**
 * Settings saved before the theme could follow the device (1.4.14) have no autoSwitchTheme. Following the
 * device is the new default, but a theme someone picked stays: only the default theme starts following.
 */
function followsDeviceByDefault(saved: Partial<Settings>): boolean {
  return saved.theme === undefined || getTheme(String(saved.theme)).name === DEFAULT_THEME;
}

/** `name` if it is a theme of the wanted kind (light or dark), else the default theme of that kind */
function themeOfKind(name: unknown, light: boolean): string {
  const t = THEMES.find((x) => x.name === name);
  return t && isLightTheme(t) === light ? t.name : light ? DEFAULT_SETTINGS.themeLight : DEFAULT_SETTINGS.themeDark;
}

function sanitize(raw: Partial<Settings> | null | undefined): Settings {
  const saved: Partial<Settings> = raw && typeof raw === 'object' ? raw : {};
  const s = { ...DEFAULT_SETTINGS, ...saved };
  // choices from another version (or a hand-edited store) fall back to the default
  const oneOf = <K extends keyof Settings>(key: K, allowed: readonly Settings[K][]) => {
    if (!allowed.includes(s[key])) s[key] = DEFAULT_SETTINGS[key];
  };
  // a theme that no longer exists (the Monkeytype palettes were removed in 1.1.9) -> the default
  s.theme = getTheme(s.theme).name;
  if (typeof saved.autoSwitchTheme !== 'boolean') s.autoSwitchTheme = followsDeviceByDefault(saved);
  s.themeLight = themeOfKind(s.themeLight, true);
  s.themeDark = themeOfKind(s.themeDark, false);
  oneOf('virtualSpeed', [0, 50, 100, 200, 500, 1000]);
  oneOf('virtualView', ['UF', 'URF']);
  if (typeof s.virtualFloat !== 'number' || !Number.isFinite(s.virtualFloat)) s.virtualFloat = DEFAULT_SETTINGS.virtualFloat;
  s.virtualFloat = Math.round(Math.max(0, Math.min(100, s.virtualFloat)));
  if (typeof s.virtualOutline !== 'number' || !Number.isFinite(s.virtualOutline)) s.virtualOutline = DEFAULT_SETTINGS.virtualOutline;
  s.virtualOutline = Math.round(Math.max(0, Math.min(100, s.virtualOutline)));
  oneOf('smartScrambled', ['scramble', '2', '3', '4', '5', 'never']);
  oneOf('smartView', ['3D', '2D', 'off']);
  oneOf('smartTurnMark', ['off', 'x4', 'xi2']);
  oneOf('smartReset', ['ask', 'always', 'never']);
  // read by puzzle, so it has to be an object (each colour in it is checked where it is used)
  if (!s.customStickers || typeof s.customStickers !== 'object' || Array.isArray(s.customStickers)) s.customStickers = {};
  s.virtualKeys = cleanKeyMaps(s.virtualKeys);
  return s;
}

export const settingsStore = createStore<Settings>(sanitize(loadJson<Partial<Settings>>(KEY, {})));

function applyFont(name: string) {
  const f = FONTS.find((x) => x.name === name) ?? FONTS[0];
  const root = document.documentElement.style;
  root.setProperty('--font', f.css);
  if (f.digitWidth) root.setProperty('--digit-width', f.digitWidth);
  else root.removeProperty('--digit-width');
}

// ---- the theme, and the device's light or dark mode -----------------------------------------------
const darkQuery: MediaQueryList | null =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** Whether the device (the system, or the browser's own setting) is in dark mode. */
export function deviceIsDark(): boolean {
  return darkQuery?.matches ?? false;
}

/** The theme on screen: while following the device, the light or the dark one; otherwise the chosen theme. */
export function activeTheme(s: Settings = settingsStore.get(), dark = deviceIsDark()): string {
  return s.autoSwitchTheme ? (dark ? s.themeDark : s.themeLight) : s.theme;
}

const THEME_KEYS = ['theme', 'autoSwitchTheme', 'themeLight', 'themeDark', 'highContrast'] as const;

/**
 * Shows the theme these settings call for, and stores its colours for the pre-paint script in index.html:
 * one set, or a light and a dark set while following the device (the script picks by the device's mode,
 * so the page opens in the right one even after the mode changed while it was closed).
 */
function showTheme(s: Settings): void {
  setHighContrast(s.highContrast === true);
  applyTheme(activeTheme(s));
  saveJson('cubr.themeColors', s.autoSwitchTheme ? { light: themeColors(getTheme(s.themeLight)), dark: themeColors(getTheme(s.themeDark)) } : themeColors(getTheme(s.theme)));
}

let followingDevice = false;

/** Switches the theme when the device switches between light and dark mode, while the theme follows it. */
function followDevice(): void {
  if (followingDevice || !darkQuery) return;
  followingDevice = true;
  darkQuery.addEventListener('change', () => {
    if (settingsStore.get().autoSwitchTheme) applyTheme(activeTheme());
  });
}

/** Apply visual settings to the document (call once at startup). */
export function applyVisualSettings(): void {
  const s = settingsStore.get();
  showTheme(s);
  applyFont(s.font);
  followDevice();
}

let serverSync: ((s: Settings) => Promise<unknown>) | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** The auth layer installs a function that pushes settings to the server (or null when logged out). */
export function setSettingsServerSync(fn: ((s: Settings) => Promise<unknown>) | null): void {
  serverSync = fn;
}

export function updateSettings(patch: Partial<Settings>, opts: { sync?: boolean } = {}): void {
  const prev = settingsStore.get();
  const next = { ...prev, ...patch };
  settingsStore.set(next);
  saveJson(KEY, next);
  if (THEME_KEYS.some((k) => k in patch && patch[k] !== prev[k])) showTheme(next);
  if (patch.font && patch.font !== prev.font) applyFont(next.font);
  if (opts.sync !== false && serverSync) {
    if (syncTimer) clearTimeout(syncTimer);
    const fn = serverSync;
    syncTimer = setTimeout(() => {
      fn(settingsStore.get()).catch(() => {
        /* offline - local copy is still saved */
      });
    }, 800);
  }
}

/** Server settings win over local ones when you log in. */
export function mergeServerSettings(remote: Record<string, unknown> | null | undefined): void {
  if (!remote || Object.keys(remote).length === 0) return;
  const r = remote as Partial<Settings>;
  // an account's settings from before 1.4.14: its theme decides, as for settings saved on a device
  const migrated = 'theme' in r && typeof r.autoSwitchTheme !== 'boolean' ? { ...r, autoSwitchTheme: followsDeviceByDefault(r) } : r;
  updateSettings(sanitize({ ...settingsStore.get(), ...migrated }), { sync: false });
  applyVisualSettings();
}

/**
 * Picks a theme (the theme list, the command line): while following the device it becomes the light or
 * the dark theme, by its own colours; otherwise it is the theme. Returns the mode the theme waits for when
 * it's for the mode the device isn't in (the page stays as it is), else null.
 */
export function chooseTheme(name: string): 'light' | 'dark' | null {
  const t = getTheme(name);
  if (!settingsStore.get().autoSwitchTheme) {
    updateSettings({ theme: t.name });
    return null;
  }
  const light = isLightTheme(t);
  updateSettings(light ? { themeLight: t.name } : { themeDark: t.name });
  return light === deviceIsDark() ? (light ? 'light' : 'dark') : null;
}

/**
 * A random theme (the theme list's "random", the command line's "random theme"). While following the
 * device it is a new light theme and a new dark theme, so both modes change; otherwise one new theme.
 * `from` narrows the choice (the theme list's filter and search): a mode it has nothing new for keeps its
 * theme, and when it has nothing new at all, every theme counts. Returns the names it chose.
 */
export function chooseRandomTheme(from: readonly Theme[] = THEMES): { theme?: string; light?: string; dark?: string } {
  const s = settingsStore.get();
  const any = (pool: readonly Theme[]) => (pool.length ? pool[Math.floor(Math.random() * pool.length)].name : undefined);
  if (!s.autoSwitchTheme) {
    const theme = any(from.filter((t) => t.name !== s.theme)) ?? randomTheme(s.theme).name;
    updateSettings({ theme });
    return { theme };
  }
  const fresh = (pool: readonly Theme[]) => ({
    light: any(pool.filter((t) => isLightTheme(t) && t.name !== s.themeLight)),
    dark: any(pool.filter((t) => !isLightTheme(t) && t.name !== s.themeDark)),
  });
  const picked = fresh(from);
  const { light, dark } = picked.light || picked.dark ? picked : fresh(THEMES);
  updateSettings({ ...(light ? { themeLight: light } : {}), ...(dark ? { themeDark: dark } : {}) });
  return { light, dark };
}

/** The note for a theme chosen for the other mode (chooseTheme's answer), as the page doesn't change. */
export function themeWaitsNote(name: string, mode: 'light' | 'dark'): string {
  return `${themeLabel(name)} is your ${mode} theme now: it shows while your device is in ${mode} mode`;
}

/**
 * Turns following the device on or off without a jump: turning it on makes the theme in use the light or
 * the dark one (so it stays in its mode), turning it off keeps the theme on screen.
 */
export function setAutoSwitchTheme(on: boolean): void {
  const s = settingsStore.get();
  if (on === s.autoSwitchTheme) return;
  if (!on) {
    updateSettings({ autoSwitchTheme: false, theme: activeTheme(s) });
    return;
  }
  const t = getTheme(s.theme);
  updateSettings({ autoSwitchTheme: true, ...(isLightTheme(t) ? { themeLight: t.name } : { themeDark: t.name }) });
}

export function useSettings(): Settings {
  return useStore(settingsStore);
}

function onDeviceModeChange(listener: () => void): () => void {
  darkQuery?.addEventListener('change', listener);
  return () => darkQuery?.removeEventListener('change', listener);
}

/** Whether the device is in dark mode, updating when it switches. */
export function useDeviceIsDark(): boolean {
  return useSyncExternalStore(onDeviceModeChange, deviceIsDark, () => false);
}

/** The name of the theme on screen (activeTheme), updating when the settings or the device's mode change. */
export function useActiveTheme(): string {
  return activeTheme(useSettings(), useDeviceIsDark());
}
