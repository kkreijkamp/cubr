import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTheme } from '../themes';
import { MemoryStorage } from './memoryStorage';

// settings.ts reads localStorage when it is imported, so each test loads a fresh copy of the module.

const KEY = 'cubr.settings';
let local: MemoryStorage;
let css: Map<string, string>;
let attrs: Map<string, string>;

function stubDom(): void {
  css = new Map();
  attrs = new Map();
  const style = { setProperty: (k: string, v: string) => void css.set(k, v), removeProperty: (k: string) => void css.delete(k) };
  const element = (name: string) => ({ setAttribute: (k: string, v: string) => void attrs.set(`${name}.${k}`, v) });
  const meta = element('meta');
  const icon = element('icon');
  vi.stubGlobal('document', {
    documentElement: { style },
    querySelector: (sel: string) => (sel.startsWith('meta') ? meta : sel.startsWith('link') ? icon : null),
  });
  vi.stubGlobal('window', new EventTarget());
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  local = new MemoryStorage();
  vi.stubGlobal('localStorage', local);
  stubDom();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Loads settings.ts as a page would, with `saved` in localStorage (raw text or a value to JSON-encode). */
async function load(saved?: unknown) {
  if (typeof saved === 'string') local.setItem(KEY, saved);
  else if (saved !== undefined) local.setItem(KEY, JSON.stringify(saved));
  const mod = await import('../settings');
  return { ...mod, get: () => mod.settingsStore.get() };
}

describe('loading saved settings', () => {
  it.each([
    ['nothing saved', undefined],
    ['text that is not JSON', '{"theme": '],
    ['JSON null', 'null'],
    ['a number', '42'],
  ])('uses the defaults for %s', async (_label, saved) => {
    const s = await load(saved);
    expect(s.get()).toEqual(s.DEFAULT_SETTINGS);
  });

  it('keeps saved choices and gives settings added since then their default', async () => {
    const s = await load({ precision: 3, inspection: true, theme: 'stackmat', statsShown: ['ao5', 'ao50'], virtualSpeed: 0, smartScrambled: 'never' });
    expect(s.get()).toEqual({ ...s.DEFAULT_SETTINGS, precision: 3, inspection: true, theme: 'stackmat', statsShown: ['ao5', 'ao50'], virtualSpeed: 0, smartScrambled: 'never' });
  });

  it.each([
    ['theme', 'serika_dark', 'white_cross'], // a Monkeytype palette removed in 1.1.9
    ['theme', 42, 'white_cross'],
    ['virtualSpeed', 75, 100],
    ['virtualSpeed', '200', 100],
    ['virtualView', 'UFR', 'UF'],
    ['smartScrambled', '6', 'scramble'],
    ['smartScrambled', 2, 'scramble'],
    ['smartView', '4D', '3D'],
    ['smartTurnMark', 'x8', 'off'],
    ['smartReset', 'sometimes', 'ask'],
    ['virtualFloat', 'big', 30],
    ['virtualFloat', null, 30],
    ['virtualOutline', '50', 50],
    ['customStickers', ['#fff'], {}],
    ['customStickers', null, {}],
    ['customStickers', 'red', {}],
    ['virtualKeys', 'qwerty', {}],
  ])('falls back to the default for %s = %j', async (key, value, expected) => {
    const s = await load({ [key]: value, precision: 3 });
    expect(s.get()).toMatchObject({ [key]: expected, precision: 3 });
  });

  it.each([
    ['virtualFloat', 150, 100],
    ['virtualFloat', -5, 0],
    ['virtualFloat', 33.6, 34],
    ['virtualOutline', 100.4, 100],
    ['virtualOutline', 0, 0],
    ['virtualOutline', 49.5, 50],
  ])('clamps %s %j to %j (a 0-100 slider)', async (key, value, expected) => {
    expect((await load({ [key]: value })).get()).toMatchObject({ [key]: expected });
  });

  it('keeps sticker colours and only the key maps that are whole swaps of bindable keys for a known puzzle', async () => {
    const s = await load({
      customStickers: { '333': ['#ff0000', null] },
      virtualKeys: {
        cube: { KeyQ: 'KeyI', KeyI: 'KeyQ' },
        pyram: { KeyQ: 'KeyI' }, // KeyI's move would be lost
        skewb: { Space: 'KeyA', KeyA: 'Space' }, // space starts the timer
        minx: {},
        sq1: { KeyA: 'KeyA' },
        bogus: { KeyQ: 'KeyI', KeyI: 'KeyQ' },
      },
    });
    expect(s.get().customStickers).toEqual({ '333': ['#ff0000', null] });
    expect(s.get().virtualKeys).toEqual({ cube: { KeyQ: 'KeyI', KeyI: 'KeyQ' } });
  });
});

describe('changing settings', () => {
  it('saves a change at once, tells subscribers, and has it on the next visit', async () => {
    const s = await load();
    const seen: number[] = [];
    s.settingsStore.subscribe(() => seen.push(s.get().precision));
    s.updateSettings({ precision: 3, holdMs: 500 });
    expect(s.get()).toMatchObject({ precision: 3, holdMs: 500 });
    expect(local.json(KEY)).toMatchObject({ precision: 3, holdMs: 500 });
    expect(seen).toEqual([3]);
    vi.resetModules();
    expect((await load()).get()).toMatchObject({ precision: 3, holdMs: 500 });
  });

  it('pushes settings to the account 800 ms after the last change, once, with every change in it', async () => {
    const s = await load();
    const push = vi.fn(async () => ({}));
    s.setSettingsServerSync(push);
    s.updateSettings({ precision: 3 });
    vi.advanceTimersByTime(500);
    s.updateSettings({ inspection: true });
    vi.advanceTimersByTime(799);
    expect(push).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ precision: 3, inspection: true }));
  });

  it('does not push with sync off or when signed out, and survives a failed push', async () => {
    const s = await load();
    const push = vi.fn(async () => {
      throw new Error('offline');
    });
    s.setSettingsServerSync(push);
    s.updateSettings({ timerSize: 8 }, { sync: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(push).not.toHaveBeenCalled();
    s.updateSettings({ timerSize: 9 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(push).toHaveBeenCalledTimes(1); // rejected, swallowed
    expect(local.json(KEY)).toMatchObject({ timerSize: 9 });
    s.setSettingsServerSync(null);
    s.updateSettings({ timerSize: 10 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('applies a new theme or font to the page, and leaves the page alone for other settings', async () => {
    const s = await load();
    s.updateSettings({ precision: 3 });
    expect(css.size).toBe(0);
    s.updateSettings({ theme: 'stackmat' });
    const stackmat = getTheme('stackmat');
    expect(css.get('--bg-color')).toBe(stackmat.bg);
    expect(css.get('--main-color')).toBe(stackmat.main);
    expect(attrs.get('meta.content')).toBe(stackmat.bg);
    expect(local.json(`cubr.themeColors`)).toMatchObject({ '--bg-color': stackmat.bg });
    s.updateSettings({ font: 'Comfortaa' });
    expect(css.get('--font')).toBe("'Comfortaa', system-ui, sans-serif");
    expect(css.get('--digit-width')).toBe('0.65em');
    s.updateSettings({ font: 'Roboto Mono' });
    expect(css.get('--font')).toBe("'Roboto Mono', ui-monospace, monospace");
    expect(css.has('--digit-width')).toBe(false); // tabular digits: no fixed digit cell
  });

  it('applyVisualSettings applies the saved theme and font; an unknown font falls back to the first one', async () => {
    const s = await load({ theme: 'dnf', font: 'Comic Sans' });
    s.applyVisualSettings();
    expect(css.get('--bg-color')).toBe(getTheme('dnf').bg);
    expect(css.get('--font')).toBe(s.FONTS[0].css);
  });
});

describe('server settings at sign-in', () => {
  it('win over local ones, are cleaned like saved ones, are applied, and are not pushed back', async () => {
    const s = await load({ precision: 3, inspection: true, theme: 'dnf' });
    const push = vi.fn(async () => ({}));
    s.setSettingsServerSync(push);
    s.mergeServerSettings({ precision: 2, theme: 'serika_dark', virtualSpeed: 7, timerSize: 9 });
    expect(s.get()).toMatchObject({ precision: 2, theme: 'white_cross', virtualSpeed: 100, timerSize: 9, inspection: true });
    expect(local.json(KEY)).toMatchObject({ precision: 2, theme: 'white_cross', timerSize: 9 });
    expect(css.get('--bg-color')).toBe(getTheme('white_cross').bg);
    await vi.advanceTimersByTimeAsync(1000);
    expect(push).not.toHaveBeenCalled();
  });

  it('change nothing when the account has no settings yet', async () => {
    const s = await load({ precision: 3 });
    const before = s.get();
    s.mergeServerSettings({});
    s.mergeServerSettings(null);
    s.mergeServerSettings(undefined);
    expect(s.get()).toBe(before);
    expect(css.size).toBe(0);
  });
});
