import { createStore, useStore } from './store';

export type ToastType = 'notice' | 'success' | 'error' | 'pb';
export interface Toast {
  id: number;
  type: ToastType;
  title: string;
  message: string;
  /** stays visible in focus mode */
  important: boolean;
}

export const toastStore = createStore<Toast[]>([]);
let nextId = 1;

export function dismissToast(id: number): void {
  toastStore.set((list) => list.filter((t) => t.id !== id));
}

function push(type: ToastType, message: string, opts: { title?: string; durationMs?: number; important?: boolean } = {}): number {
  const id = nextId++;
  const title = opts.title ?? { notice: 'notice', success: 'success', error: 'error', pb: 'new personal best' }[type];
  toastStore.set((list) => [...list.slice(-4), { id, type, title, message, important: opts.important ?? type === 'pb' }]);
  const duration = opts.durationMs ?? (type === 'error' ? 6000 : 3000);
  if (duration > 0) setTimeout(() => dismissToast(id), duration);
  return id;
}

export const toast = {
  notice: (m: string, o?: { title?: string; durationMs?: number }) => push('notice', m, o),
  success: (m: string, o?: { title?: string; durationMs?: number }) => push('success', m, o),
  error: (m: string, o?: { title?: string; durationMs?: number }) => push('error', m, o),
  pb: (m: string, o?: { title?: string; durationMs?: number }) => push('pb', m, o),
};

export function useToasts(): Toast[] {
  return useStore(toastStore);
}
