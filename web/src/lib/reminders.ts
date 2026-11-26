// This browser's daily-challenge reminder (Web Push). The solve service sends it at the minute of the
// day picked here (10:00 unless changed), on days the person hasn't played yet; the service worker shows
// it (sw/sw.ts). One subscription per browser: turning it on asks for notification permission, and
// signing out turns it off. The minute is remembered here too, to show it; the server's row is the truth.
import { api } from './api';

export const DEFAULT_REMINDER_MINUTE = 600;
/** how long the browser's push service may take to hand out a subscription */
export const SUBSCRIBE_TIMEOUT_MS = 20_000;
const MINUTE_KEY = 'cubr.reminderMinute';

/** What this browser can do about reminders. */
export type ReminderSupport =
  | 'ok'
  /** no service worker or Push API */
  | 'unsupported'
  /** an iPhone or iPad gets push only in the installed app (iOS 16.4+) */
  | 'install-first'
  /** notifications are blocked for the site */
  | 'blocked';

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function installed(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function reminderSupport(): ReminderSupport {
  if (isIos() && !installed()) return 'install-first';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return 'ok';
}

async function subscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function storedMinute(): number | null {
  try {
    const v = Number(localStorage.getItem(MINUTE_KEY));
    return localStorage.getItem(MINUTE_KEY) !== null && Number.isInteger(v) && v >= 0 && v < 1440 ? v : null;
  } catch {
    return null;
  }
}
function storeMinute(minute: number | null): void {
  try {
    if (minute === null) localStorage.removeItem(MINUTE_KEY);
    else localStorage.setItem(MINUTE_KEY, String(minute));
  } catch {
    // storage off: the setting still holds on the server
  }
}

/** This browser's reminder: its minute of the day, or null when it's off. */
export async function getReminder(): Promise<number | null> {
  if (!(await subscription())) return null;
  return storedMinute() ?? DEFAULT_REMINDER_MINUTE;
}

const keyBytes = (key: string) => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.byteLength && new Uint8Array(a).every((x, i) => x === b[i]);

/** Turns this browser's reminder on at `minute` of its local day (asking for permission), or moves it there. */
export async function setReminder(minute: number): Promise<void> {
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted')
    throw new Error(Notification.permission === 'denied' ? 'notifications are blocked for cubr in this browser' : 'notifications weren’t allowed');
  const { publicKey } = await api.solves.reminderKey();
  if (!publicKey) throw new Error('reminders aren’t set up on this server');
  const reg = await navigator.serviceWorker.ready;
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // one made with another key (the server's changed) can't be reached any more: start over
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  // a browser whose push service is off or out of reach may never answer: don't wait for ever
  sub ??= await Promise.race([
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
    new Promise<never>((_, fail) =>
      setTimeout(() => fail(new Error('this browser’s push service didn’t answer: try again, or another browser')), SUBSCRIBE_TIMEOUT_MS),
    ),
  ]);
  const { endpoint, keys } = sub.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) throw new Error('this browser gave an incomplete subscription');
  await api.solves.setReminder({
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    remindMinute: minute,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  storeMinute(minute);
}

/** Turns this browser's reminder off. Once unsubscribed, the push service refuses it, and the server
 *  deletes its row then even if this call didn't get through. */
export async function clearReminder(): Promise<void> {
  const sub = await subscription();
  storeMinute(null);
  if (!sub) return;
  await api.solves.clearReminder(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}
