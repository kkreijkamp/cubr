import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ solves: { reminderKey: vi.fn(), setReminder: vi.fn(), clearReminder: vi.fn() } }));
vi.mock('../api', () => ({ api }));
import { clearReminder, DEFAULT_REMINDER_MINUTE, getReminder, reminderSupport, setReminder } from '../reminders';

// the server's VAPID public key: 65 bytes, base64url (btoa and atob: this file is type-checked without Node's types)
const KEY = btoa(String.fromCharCode(...Uint8Array.from({ length: 65 }, (_, i) => i + 1)))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
const keyBytes = (k: string) => Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function fakeSubscription(key: Uint8Array, endpoint = 'https://push.example.com/abc') {
  return {
    endpoint,
    options: { applicationServerKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } }),
    unsubscribe: vi.fn(async () => true),
  };
}

describe('daily reminders in the browser', () => {
  let store: Map<string, string>;
  let current: ReturnType<typeof fakeSubscription> | null;
  let pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
  let permission: NotificationPermission;

  beforeEach(() => {
    store = new Map();
    current = null;
    permission = 'default';
    pushManager = {
      getSubscription: vi.fn(async () => current),
      subscribe: vi.fn(
        async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) =>
          (current = fakeSubscription(applicationServerKey, 'https://push.example.com/new')),
      ),
    };
    const registration = { pushManager };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131',
      platform: 'Win32',
      maxTouchPoints: 0,
      serviceWorker: { ready: Promise.resolve(registration), getRegistration: async () => registration },
    });
    vi.stubGlobal('window', { PushManager: class {}, Notification: class {} });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('Notification', {
      get permission() {
        return permission;
      },
      requestPermission: vi.fn(async () => (permission = 'granted')),
    });
    api.solves.reminderKey.mockResolvedValue({ publicKey: KEY });
    api.solves.setReminder.mockResolvedValue({});
    api.solves.clearReminder.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('says when this browser can have them', () => {
    expect(reminderSupport()).toBe('ok');
    permission = 'denied';
    expect(reminderSupport()).toBe('blocked');
    vi.stubGlobal('window', {});
    expect(reminderSupport()).toBe('unsupported');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 });
    expect(reminderSupport()).toBe('install-first'); // Safari, not the installed app
  });

  it('turns on at 10:00 (asking first), subscribed with the server key, in the local time zone', async () => {
    expect(await getReminder()).toBeNull();
    await setReminder(DEFAULT_REMINDER_MINUTE);
    expect(Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: keyBytes(KEY) });
    expect(api.solves.setReminder).toHaveBeenCalledWith({
      endpoint: 'https://push.example.com/new',
      keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
      remindMinute: 600,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(await getReminder()).toBe(600);
    // another hour: the same subscription, moved
    await setReminder(1080);
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(api.solves.setReminder).toHaveBeenLastCalledWith(expect.objectContaining({ remindMinute: 1080 }));
    expect(await getReminder()).toBe(1080);
  });

  it('subscribes again when the server key changed, and refuses without permission or keys', async () => {
    permission = 'granted';
    const old = fakeSubscription(new Uint8Array(65).fill(9), 'https://push.example.com/old');
    current = old;
    await setReminder(600);
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(api.solves.setReminder).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://push.example.com/new' }));

    api.solves.reminderKey.mockResolvedValueOnce({ publicKey: null });
    await expect(setReminder(600)).rejects.toThrow('set up');
    permission = 'default';
    vi.mocked(Notification.requestPermission).mockImplementationOnce(async () => (permission = 'denied'));
    await expect(setReminder(600)).rejects.toThrow('blocked');
  });

  it('turns off: the server forgets it, the browser unsubscribes, even if the server is out of reach', async () => {
    await setReminder(600);
    const sub = current!;
    api.solves.clearReminder.mockRejectedValueOnce(new Error('offline'));
    await clearReminder();
    expect(api.solves.clearReminder).toHaveBeenCalledWith('https://push.example.com/new');
    expect(sub.unsubscribe).toHaveBeenCalled();
    current = null;
    expect(await getReminder()).toBeNull();
    await clearReminder(); // nothing on: nothing to do
    expect(api.solves.clearReminder).toHaveBeenCalledTimes(1);
  });
});
