// User settings: persisted in localStorage for everyone, synced to the auth service
// (PUT /api/auth/me/settings) for logged-in users so they follow you across devices.
import { applyTheme, DEFAULT_THEME } from './themes';
import { createStore, loadJson, saveJson, useStore } from './store';

export type TimerUpdate = 'realtime' | 'tenths' | 'seconds' | 'hidden';
export type PreviewMode = 'off' | '2D' | '3D';

export interface Settings {
  theme: string;
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
  /** the 2D scramble preview's sticker colours: cubetype's, or your own (customStickers) */
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
  /** smart cube: when a scramble counts as done (csTimer "mark scrambled after"): matching the scramble, n seconds without a move, or never */
  smartScrambled: 'scramble' | '2' | '3' | '4' | '5' | 'never';
  /** smart cube: space marks the cube as scrambled */
  smartSpace: boolean;
  /** smart cube: beep when the cube is marked scrambled */
  smartBeep: boolean;
  /** smart cube: show the cube on screen */
  smartView: '3D' | '2D' | 'off';
  /** stackmat: use the timer's status signals (hands on, green light) */
  stackmatStatus: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME,
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
  smartScrambled: 'scramble',
  smartSpace: true,
  smartBeep: true,
  smartView: '3D',
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

const KEY = 'cubetype.settings';

function sanitize(raw: Partial<Settings> | null | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  // choices from another version (or a hand-edited store) fall back to the default
  const oneOf = <K extends keyof Settings>(key: K, allowed: readonly Settings[K][]) => {
    if (!allowed.includes(s[key])) s[key] = DEFAULT_SETTINGS[key];
  };
  oneOf('virtualSpeed', [0, 50, 100, 200, 500, 1000]);
  oneOf('virtualView', ['UF', 'URF']);
  oneOf('smartScrambled', ['scramble', '2', '3', '4', '5', 'never']);
  oneOf('smartView', ['3D', '2D', 'off']);
  // read by puzzle, so it has to be an object (each colour in it is checked where it is used)
  if (!s.customStickers || typeof s.customStickers !== 'object' || Array.isArray(s.customStickers)) s.customStickers = {};
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

/** Apply visual settings to the document (call once at startup). */
export function applyVisualSettings(): void {
  const s = settingsStore.get();
  applyTheme(s.theme);
  applyFont(s.font);
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
  if (patch.theme && patch.theme !== prev.theme) applyTheme(next.theme);
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
  updateSettings(sanitize({ ...settingsStore.get(), ...(remote as Partial<Settings>) }), { sync: false });
  applyVisualSettings();
}

export function useSettings(): Settings {
  return useStore(settingsStore);
}
