// User settings, persisted in localStorage.
import { applyTheme, DEFAULT_THEME } from './themes';
import { createStore, loadJson, saveJson, useStore } from './store';

export type TimerUpdate = 'realtime' | 'tenths' | 'seconds' | 'hidden';

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
  /** which averages appear in the timer stats panel */
  statsShown: string[];
  confirmDelete: boolean;
  showSolveList: boolean;
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
  statsShown: ['mo3', 'ao5', 'ao12', 'ao100'],
  confirmDelete: true,
  showSolveList: true,
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

export function updateSettings(patch: Partial<Settings>): void {
  const prev = settingsStore.get();
  const next = { ...prev, ...patch };
  settingsStore.set(next);
  saveJson(KEY, next);
  if (patch.theme && patch.theme !== prev.theme) applyTheme(next.theme);
  if (patch.font && patch.font !== prev.font) applyFont(next.font);
}

export function useSettings(): Settings {
  return useStore(settingsStore);
}
