import { describe, expect, it } from 'vitest';
import { migrateLegacyStorage } from '../legacyStorage';

/** Minimal in-memory Storage; `failSet` makes setItem throw like a full quota. */
function memoryStorage(entries: Record<string, string> = {}, failSet = false): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failSet) throw new DOMException('full', 'QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

const dump = (s: Storage) => Object.fromEntries(Array.from({ length: s.length }, (_, i) => s.key(i)!).map((k) => [k, s.getItem(k)]));

describe('migrateLegacyStorage', () => {
  it('moves dot and colon keys to the new prefix', () => {
    const s = memoryStorage({ 'cubetype.local.v1': '[1]', 'cubetype:chunk-reload-at': '5', 'other.key': 'x' });
    expect(migrateLegacyStorage(s)).toBe(2);
    expect(dump(s)).toEqual({ 'other.key': 'x', 'cubr.local.v1': '[1]', 'cubr:chunk-reload-at': '5' });
  });

  it('keeps a value already saved under the new name and drops the old copy', () => {
    const s = memoryStorage({ 'cubetype.settings': 'old', 'cubr.settings': 'new' });
    expect(migrateLegacyStorage(s)).toBe(0);
    expect(dump(s)).toEqual({ 'cubr.settings': 'new' });
  });

  it('leaves look-alike keys alone', () => {
    const s = memoryStorage({ cubetype: 'a', cubetypes: 'b', 'x.cubetype.y': 'c' });
    expect(migrateLegacyStorage(s)).toBe(0);
    expect(s.length).toBe(3);
  });

  it('keeps the old keys when storage refuses writes', () => {
    const s = memoryStorage({ 'cubetype.queue.v1': '[]' }, true);
    expect(migrateLegacyStorage(s)).toBe(0);
    expect(dump(s)).toEqual({ 'cubetype.queue.v1': '[]' });
  });

  it('does nothing without storage', () => {
    expect(migrateLegacyStorage(null)).toBe(0);
  });
});
