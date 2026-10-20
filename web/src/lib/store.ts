import { useSyncExternalStore } from 'react';

/** Minimal external store (no dependency). Selectors must return stable values (primitives or
 *  existing object references) - never build a new object inside a selector. */
export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? (next as (p: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore<T>(store: Store<T>): T;
export function useStore<T, S>(store: Store<T>, selector: (s: T) => S): S;
export function useStore<T, S>(store: Store<T>, selector?: (s: T) => S): T | S {
  return useSyncExternalStore(
    store.subscribe,
    () => (selector ? selector(store.get()) : store.get()),
    () => (selector ? selector(store.get()) : store.get()),
  );
}

/** localStorage JSON helpers that never throw (private mode, quota, disabled storage). */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
