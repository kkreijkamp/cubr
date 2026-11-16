import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, loadJson, saveJson } from '../store';
import { MemoryStorage } from './memoryStorage';

afterEach(() => vi.unstubAllGlobals());

describe('createStore', () => {
  it('notifies subscribers of a new value, through a value or an updater, but not of the same value', () => {
    const store = createStore({ n: 1 });
    const seen: number[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.get().n));
    store.set({ n: 2 });
    store.set((prev) => ({ n: prev.n + 1 }));
    store.set(store.get());
    store.set((prev) => prev);
    expect(seen).toEqual([2, 3]);
    unsubscribe();
    store.set({ n: 9 });
    expect(seen).toEqual([2, 3]);
    expect(store.get()).toEqual({ n: 9 });
  });

  it('notifies every subscriber, and unsubscribing one leaves the others', () => {
    const store = createStore(0);
    const a = vi.fn();
    const b = vi.fn();
    const offA = store.subscribe(a);
    store.subscribe(b);
    store.set(1);
    offA();
    store.set(2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});

describe('loadJson / saveJson', () => {
  it('reads back what was saved, and the fallback for a missing, empty or unreadable value', () => {
    vi.stubGlobal('localStorage', new MemoryStorage({ broken: '{nope', empty: '' }));
    saveJson('k', { a: [1, 2], b: null });
    expect(loadJson('k', null)).toEqual({ a: [1, 2], b: null });
    expect(loadJson('missing', 'fallback')).toBe('fallback');
    expect(loadJson('empty', 'fallback')).toBe('fallback');
    expect(loadJson('broken', 'fallback')).toBe('fallback');
  });

  it('never throws when storage is full, blocked or missing (private modes, sandboxed frames)', () => {
    const full = new MemoryStorage();
    full.full = true;
    vi.stubGlobal('localStorage', full);
    expect(() => saveJson('k', 1)).not.toThrow();
    const blocked = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(loadJson('k', 'fallback')).toBe('fallback');
    expect(() => saveJson('k', 1)).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    expect(loadJson('k', 'fallback')).toBe('fallback');
    expect(() => saveJson('k', 1)).not.toThrow();
  });
});
