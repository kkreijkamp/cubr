// The platform was called cubetype until 2026-11; browser data saved back then sits under
// `cubetype.<name>` / `cubetype:<name>` keys. This moves each one to its `cubr.` / `cubr:` key once,
// so guest solves, the offline queue and settings survive the rename. A key the new name already
// has wins (the old copy is dropped). If storage throws (blocked, full), the remaining old keys stay
// and the next page load tries again.
const LEGACY_KEY = /^cubetype([.:])/;

export function migrateLegacyStorage(storage: Storage | null): number {
  if (!storage) return 0;
  let moved = 0;
  try {
    const legacy: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && LEGACY_KEY.test(key)) legacy.push(key);
    }
    for (const oldKey of legacy) {
      const value = storage.getItem(oldKey);
      const newKey = oldKey.replace(LEGACY_KEY, 'cubr$1');
      if (value !== null && storage.getItem(newKey) === null) {
        storage.setItem(newKey, value);
        moved++;
      }
      storage.removeItem(oldKey);
    }
  } catch {
    // keep whatever is left under the old names
  }
  return moved;
}

/** window.localStorage, or null where reading it throws (privacy modes, sandboxed frames). */
export function browserLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
