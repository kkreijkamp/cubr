import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isChunkLoadError } from '../chunkReload';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const items = new Map<string, string>();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v) };
}

// The module remembers a pending reload, so each page load gets a fresh copy (storage persists).
async function freshPage() {
  vi.resetModules();
  return (await import('../chunkReload')).reloadForNewRelease;
}

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reload = vi.fn();
  vi.stubGlobal('location', { reload });
  vi.stubGlobal('sessionStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: http://x/assets/StatusPage-a1b2.js', // Chrome
    'error loading dynamically imported module: http://x/assets/StatusPage-a1b2.js', // Firefox
    'Importing a module script failed.', // Safari
    'Unable to preload CSS for /assets/StatusPage-a1b2.css', // Vite
  ])('recognises "%s"', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('reloadForNewRelease', () => {
  it('reloads once, then reports failure instead of looping', async () => {
    expect((await freshPage())()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // the reloaded page still can't load its chunk (an old pod answered)
    expect((await freshPage())()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('treats repeated calls on one page as the same reload', async () => {
    const reloadForNewRelease = await freshPage();
    expect(reloadForNewRelease()).toBe(true);
    expect(reloadForNewRelease()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again for a later release', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
    expect((await freshPage())()).toBe(true);
    vi.setSystemTime(new Date('2026-10-21T00:00:11Z'));
    expect((await freshPage())()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload when it cannot remember doing so', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect((await freshPage())()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
