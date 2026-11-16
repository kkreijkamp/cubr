import { createStore, useStore } from './store';

export type ToastType = 'notice' | 'success' | 'error' | 'pb';
export interface Toast {
  id: number;
  type: ToastType;
  title: string;
  message: string;
  /** stays visible in focus mode */
  important: boolean;
  /** what a click on it does, besides closing it (e.g. reload for an update) */
  onClick?: () => void;
}

export const toastStore = createStore<Toast[]>([]);
let nextId = 1;

export function dismissToast(id: number): void {
  toastStore.set((list) => list.filter((t) => t.id !== id));
}

type ToastOptions = { title?: string; durationMs?: number; onClick?: () => void };

function push(type: ToastType, message: string, opts: ToastOptions & { important?: boolean } = {}): number {
  const id = nextId++;
  const title = opts.title ?? { notice: 'notice', success: 'success', error: 'error', pb: 'new personal best' }[type];
  const t: Toast = { id, type, title, message, important: opts.important ?? type === 'pb', ...(opts.onClick ? { onClick: opts.onClick } : {}) };
  toastStore.set((list) => [...list.slice(-4), t]);
  const duration = opts.durationMs ?? (type === 'error' ? 6000 : 3000);
  if (duration > 0) setTimeout(() => dismissToast(id), duration);
  return id;
}

/** durationMs 0 = stays until clicked */
export const toast = {
  notice: (m: string, o?: ToastOptions) => push('notice', m, o),
  success: (m: string, o?: ToastOptions) => push('success', m, o),
  error: (m: string, o?: ToastOptions) => push('error', m, o),
  pb: (m: string, o?: ToastOptions) => push('pb', m, o),
};

export function useToasts(): Toast[] {
  return useStore(toastStore);
}
