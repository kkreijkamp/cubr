// Keeps the screen on while you time (the Screen Wake Lock API). A phone or laptop would otherwise dim
// and sleep during a long solve or inspection. With a Stackmat, a smart cube or a Bluetooth timer
// nobody touches the screen at all, so the device counts as idle the whole time: let go the moment
// the solve stops, the screen could go dark before the time is read.
//
// The timer display (timer/TimerDisplay.tsx) holds the lock from the press, or the start of
// inspection, until the solve stops, and AFTER_SOLVE_MS longer: enough to read the time and scramble
// the next one, even a 7x7. Leaving the timer lets go at once. The browser drops the lock while the
// page is hidden; it's taken again when the page shows while still held.
//
// Without the API (iOS before 16.4, or before 18.4 in a home-screen app; Firefox before 126), or
// when the browser refuses (some battery savers), the screen sleeps as it always did. The
// Permissions-Policy header allows the lock for cubr itself (web/nginx/default.conf.template).
import { useEffect, useState } from 'react';

/** How long the screen stays on after a solve stops: to read the time and scramble the next one. */
export const AFTER_SOLVE_MS = 5 * 60_000;

/** A lock the browser granted. */
export interface WakeLockHandle {
  release(): Promise<void>;
  /** called when the lock goes, also when the browser drops it (the page was hidden) */
  onRelease(listener: () => void): void;
}

/** What the lock needs from the browser (a fake in tests). */
export interface WakeLockEnv {
  /** asks for a screen wake lock; undefined in a browser without the API */
  request: (() => Promise<WakeLockHandle>) | undefined;
  visible(): boolean;
  /** calls `listener` whenever the page shows again */
  onVisible(listener: () => void): void;
}

/** One screen lock shared by everything that holds it: kept while anyone holds it and the page shows. */
export function createScreenLock(env: WakeLockEnv) {
  let holders = 0;
  let handle: WakeLockHandle | null = null;
  let asking = false;
  let watching = false;

  function settle(): void {
    if (holders > 0 && !handle && !asking && env.request && env.visible()) {
      asking = true;
      env.request().then(
        (h) => {
          asking = false;
          handle = h;
          h.onRelease(() => {
            if (handle === h) handle = null; // the browser let go: taken again when the page shows
          });
          settle(); // everyone let go while it was on its way
        },
        () => {
          asking = false; // refused: asked again on the next hold, or when the page shows again
        },
      );
    } else if (holders === 0 && handle) {
      const h = handle;
      handle = null;
      h.release().catch(() => undefined);
    }
  }

  return {
    /** Keeps the screen on until the returned function is called. */
    hold(): () => void {
      if (!watching) {
        watching = true;
        env.onVisible(settle);
      }
      holders++;
      settle();
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        holders--;
        settle();
      };
    },
    /** whether the browser is keeping the screen on for us right now */
    get active(): boolean {
      return handle !== null;
    },
  };
}

/**
 * A switch over `hold`: on keeps the screen on; off lets go `lingerMs` later, unless it's switched on
 * again first. `stop` lets go at once (the timer left the page); the switch still works after it.
 */
export function createLingeringHold(hold: () => () => void, lingerMs: number) {
  let release: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function stop(): void {
    clearTimeout(timer);
    timer = undefined;
    release?.();
    release = null;
  }
  return {
    set(on: boolean): void {
      if (on) {
        clearTimeout(timer);
        timer = undefined;
        release ??= hold();
      } else if (release && timer === undefined) {
        timer = setTimeout(stop, lingerMs);
      }
    },
    stop,
  };
}

function browserEnv(): WakeLockEnv {
  return {
    request:
      'wakeLock' in navigator
        ? async () => {
            const sentinel = await navigator.wakeLock.request('screen');
            return {
              release: () => sentinel.release(),
              onRelease: (listener) => sentinel.addEventListener('release', listener, { once: true }),
            };
          }
        : undefined,
    visible: () => document.visibilityState === 'visible',
    onVisible: (listener) =>
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') listener();
      }),
  };
}

let shared: ReturnType<typeof createScreenLock> | null | undefined;
function screenLock(): ReturnType<typeof createScreenLock> | null {
  if (shared === undefined) shared = typeof document === 'undefined' ? null : createScreenLock(browserEnv());
  return shared;
}

/** Keeps the screen on while `on`, and `lingerMs` after it turns off; lets go when the component goes. */
export function useWakeLock(on: boolean, lingerMs: number): void {
  const [hold] = useState(() => {
    const lock = screenLock();
    return lock ? createLingeringHold(lock.hold, lingerMs) : null;
  });
  useEffect(() => {
    hold?.set(on);
  }, [hold, on]);
  useEffect(() => () => hold?.stop(), [hold]);
}
