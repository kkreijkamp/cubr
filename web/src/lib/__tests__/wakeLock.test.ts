import { afterEach, describe, expect, it, vi } from 'vitest';
import { AFTER_SOLVE_MS, createLingeringHold, createScreenLock, type WakeLockEnv } from '../wakeLock';

/** A browser's screen wake lock, faked: a hidden page is refused, and hiding drops the lock, as browsers do. */
function fakeBrowser({ supported = true, refuse = false } = {}) {
  let visible = true;
  let requests = 0;
  const shown: (() => void)[] = [];
  const locks: { released: boolean; listeners: (() => void)[] }[] = [];
  const drop = (lock: (typeof locks)[number]) => {
    if (lock.released) return;
    lock.released = true;
    for (const l of lock.listeners) l();
  };
  const env: WakeLockEnv = {
    request: supported
      ? async () => {
          requests++;
          if (refuse || !visible) throw new DOMException('Wake Lock permission request denied', 'NotAllowedError');
          const lock = { released: false, listeners: [] as (() => void)[] };
          locks.push(lock);
          return { release: async () => drop(lock), onRelease: (l) => lock.listeners.push(l) };
        }
      : undefined,
    visible: () => visible,
    onVisible: (l) => shown.push(l),
  };
  return {
    env,
    /** locks the browser holds now */
    held: () => locks.filter((l) => !l.released).length,
    requests: () => requests,
    hide() {
      visible = false;
      locks.forEach(drop);
    },
    show() {
      visible = true;
      for (const l of shown) l();
    },
  };
}

/** lets the fake's promises settle */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('the screen lock', () => {
  it('keeps the screen on while anyone holds it, with one lock from the browser', async () => {
    const browser = fakeBrowser();
    const lock = createScreenLock(browser.env);
    const a = lock.hold();
    const b = lock.hold();
    await flush();
    expect([browser.held(), browser.requests(), lock.active]).toEqual([1, 1, true]);
    a();
    a(); // letting go twice counts once
    await flush();
    expect(browser.held()).toBe(1);
    b();
    await flush();
    expect([browser.held(), lock.active]).toEqual([0, false]);
  });

  it('lets go of a lock that arrives after everyone let go', async () => {
    const browser = fakeBrowser();
    const lock = createScreenLock(browser.env);
    lock.hold()();
    await flush();
    expect([browser.requests(), browser.held()]).toEqual([1, 0]);
  });

  it('takes the lock again when the page shows, while it is still held', async () => {
    const browser = fakeBrowser();
    const lock = createScreenLock(browser.env);
    const release = lock.hold();
    await flush();
    browser.hide();
    expect(lock.active).toBe(false);
    browser.show();
    await flush();
    expect([browser.held(), browser.requests()]).toEqual([1, 2]);
    release();
    await flush();
    browser.hide();
    browser.show();
    await flush();
    expect([browser.held(), browser.requests()]).toEqual([0, 2]);
  });

  it("doesn't ask while the page is hidden; asks once it shows", async () => {
    const browser = fakeBrowser();
    const lock = createScreenLock(browser.env);
    browser.hide();
    lock.hold();
    await flush();
    expect(browser.requests()).toBe(0);
    browser.show();
    await flush();
    expect(browser.held()).toBe(1);
  });

  it('does nothing in a browser without the API, and lives with a refusal', async () => {
    const without = fakeBrowser({ supported: false });
    const a = createScreenLock(without.env);
    a.hold()();
    expect(a.active).toBe(false);

    const refusing = fakeBrowser({ refuse: true });
    const b = createScreenLock(refusing.env);
    const release = b.hold();
    await flush();
    expect([refusing.requests(), refusing.held(), b.active]).toEqual([1, 0, false]);
    // asked again the next time someone holds it, not in a loop
    const again = b.hold();
    await flush();
    expect(refusing.requests()).toBe(2);
    release();
    again();
  });
});

describe('the hold after a solve', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** a hold that counts its holders */
  function counter() {
    let holders = 0;
    const hold = vi.fn(() => {
      holders++;
      return () => holders--;
    });
    return { hold, holders: () => holders };
  }

  it('keeps the screen on while timing and for the linger after, then lets go', () => {
    vi.useFakeTimers();
    const c = counter();
    const s = createLingeringHold(c.hold, 1000);
    s.set(false);
    expect(c.hold).not.toHaveBeenCalled(); // the page opening doesn't keep the screen on
    s.set(true);
    s.set(true);
    expect([c.hold.mock.calls.length, c.holders()]).toEqual([1, 1]);
    s.set(false);
    vi.advanceTimersByTime(999);
    expect(c.holders()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(c.holders()).toBe(0);
  });

  it('keeps holding when the next solve starts within the linger, and counts the linger from the last stop', () => {
    vi.useFakeTimers();
    const c = counter();
    const s = createLingeringHold(c.hold, 1000);
    s.set(true);
    s.set(false);
    vi.advanceTimersByTime(800);
    s.set(true); // the next solve
    vi.advanceTimersByTime(5000);
    expect([c.hold.mock.calls.length, c.holders()]).toEqual([1, 1]);
    s.set(false);
    vi.advanceTimersByTime(600);
    s.set(false); // another idle phase (stopped -> idle) doesn't push the end back
    vi.advanceTimersByTime(400);
    expect(c.holders()).toBe(0);
  });

  it('lets go at once when the timer goes, and works again after', () => {
    vi.useFakeTimers();
    const c = counter();
    const s = createLingeringHold(c.hold, 1000);
    s.set(true);
    s.set(false);
    s.stop();
    expect(c.holders()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(c.holders()).toBe(0); // the cancelled linger doesn't let go twice
    s.set(true); // React's strict mode runs effects again after a stop
    expect(c.holders()).toBe(1);
    s.stop();
  });

  it('lasts long enough to scramble the next solve', () => {
    expect(AFTER_SOLVE_MS).toBe(5 * 60_000);
  });
});
