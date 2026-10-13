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
  /** which averages appear in the timer stats panel */
  statsShown: string[];
  confirmDelete: boolean;
  showSolveList: boolean;
  showCharts: boolean;
  /** last used event (timer page) */
  lastEvent: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME,
  font: 'Roboto Mono',
  inspection: false,
  inspectionAlerts: 'beep',
  holdMs: 300,
  timerUpdate: 'realtime',
  precision: 2,
  timerSize: 7,
  scramblePreview: '2D',
  statsShown: ['mo3', 'ao5', 'ao12', 'ao100'],
  confirmDelete: true,
  showSolveList: true,
  showCharts: true,
  lastEvent: '333',
};

export const FONTS: { name: string; css: string }[] = [
  { name: 'Roboto Mono', css: "'Roboto Mono', ui-monospace, monospace" },
  { name: 'Lexend Deca', css: "'Lexend Deca', system-ui, sans-serif" },
  { name: 'System Mono', css: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  { name: 'System Sans', css: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' },
  { name: 'Georgia', css: 'Georgia, serif' },
];

const KEY = 'cubetype.settings';

function sanitize(raw: Partial<Settings> | null | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

export const settingsStore = createStore<Settings>(sanitize(loadJson<Partial<Settings>>(KEY, {})));

function applyFont(name: string) {
  const f = FONTS.find((x) => x.name === name) ?? FONTS[0];
  document.documentElement.style.setProperty('--font', f.css);
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
        /* offline — local copy is still saved */
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
