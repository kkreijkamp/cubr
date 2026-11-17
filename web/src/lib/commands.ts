// Command palette registry (Monkeytype "command line"). Any component can register commands
// with useRegisterCommands(); the palette (Esc / Ctrl+K / Ctrl+Shift+P) searches all of them.
import { useEffect, type ReactNode } from 'react';
import { createStore, useStore } from './store';

export interface Command {
  id: string;
  label: string;
  icon?: ReactNode;
  /** shown right after the label (e.g. the practice bottle after a session's name) */
  after?: ReactNode;
  /** extra words that should match the search */
  keywords?: string[];
  /** shows a check mark (currently selected option) */
  active?: boolean;
  /** run on Enter/click; return false to keep the palette open */
  run?: () => void | boolean;
  /** opens a nested list instead of running (e.g. "Theme...") */
  children?: () => Command[];
  /** called while the row is highlighted (live theme preview); undone when the palette closes */
  preview?: () => void;
}

const registry = createStore<Map<string, Command[]>>(new Map());

export function registerCommands(source: string, commands: Command[]): () => void {
  registry.set((m) => new Map(m).set(source, commands));
  return () =>
    registry.set((m) => {
      const n = new Map(m);
      n.delete(source);
      return n;
    });
}

/** Register commands for the lifetime of a component. Pass a stable `deps` array. */
export function useRegisterCommands(source: string, factory: () => Command[], deps: unknown[]): void {
  useEffect(() => registerCommands(source, factory()), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useAllCommands(): Command[] {
  const map = useStore(registry);
  return Array.from(map.values()).flat();
}

interface PaletteState {
  open: boolean;
  /** id of the command whose children should be shown first (e.g. 'theme') */
  initial: string | null;
}
export const paletteStore = createStore<PaletteState>({ open: false, initial: null });

export function openPalette(initial: string | null = null): void {
  paletteStore.set({ open: true, initial });
}
export function closePalette(): void {
  paletteStore.set({ open: false, initial: null });
}

/** Words for matching: letters and digits, with + . : kept inside them (+2, 1:30.00); the rest separates. */
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9+.:]+/).filter(Boolean);

/**
 * Monkeytype-style matching: every typed word must prefix some word of the label/keywords. The query splits
 * like the label, so punctuation typed from a label ("light / dark", "theme > white") matches it.
 */
export function matches(cmd: Command, query: string): boolean {
  const typed = words(query);
  if (typed.length === 0) return true;
  const hay = words([cmd.label, ...(cmd.keywords ?? [])].join(' '));
  return typed.every((w) => hay.some((h) => h.startsWith(w)));
}
