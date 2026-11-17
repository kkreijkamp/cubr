import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTheme } from '../themes';
import { MemoryStorage } from './memoryStorage';

// settings.ts reads localStorage (and the device's light or dark mode) when it is imported, so each test
// loads a fresh copy of the module.

const KEY = 'cubr.settings';
let local: MemoryStorage;
let css: Map<string, string>;
let attrs: Map<string, string>;
/** the device's mode, as matchMedia('(prefers-color-scheme: dark)') reports it; `switchTo` changes it */
let device: EventTarget & { matches: boolean; media: string };

function stubDom(): void {
  css = new Map();
  attrs = new Map();
  const style = { setProperty: (k: string, v: string) => void css.set(k, v), removeProperty: (k: string) => void css.delete(k) };
  const element = (name: string) => ({ setAttribute: (k: string, v: string) => void attrs.set(`${name}.${k}`, v) });
  // index.html's two theme colours: the light-mode and the dark-mode one
  const metas = [element('meta-light'), element('meta-dark')];
  const icon = element('icon');
  vi.stubGlobal('document', {
    documentElement: { style },
    querySelector: (sel: string) => (sel.startsWith('link') ? icon : null),
    querySelectorAll: (sel: string) => (sel.startsWith('meta[name="theme-color"]') ? metas : []),
  });
  device = Object.assign(new EventTarget(), { matches: false, media: '(prefers-color-scheme: dark)' });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: (q: string) => (q === device.media ? device : null) }));
}

function switchTo(mode: 'light' | 'dark'): void {
  device.matches = mode === 'dark';
  device.dispatchEvent(new Event('change'));
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
    expect(s.get()).toEqual({
      ...s.DEFAULT_SETTINGS,
      precision: 3,
      inspection: true,
      theme: 'stackmat',
      // a theme picked before the theme could follow the device stays put
      autoSwitchTheme: false,
      statsShown: ['ao5', 'ao50'],
      virtualSpeed: 0,
      smartScrambled: 'never',
    });
  });

  it.each([
    ['nothing saved', undefined, true],
    ['other settings, the theme never touched', { precision: 3 }, true],
    ['the default theme', { theme: 'white_cross' }, true],
    ['a theme that no longer exists (so the default)', { theme: 'serika_dark' }, true],
    ['a light theme someone picked', { theme: 'comp_day' }, false],
    ['a dark theme someone picked', { theme: 'dnf' }, false],
    ['white cross dark, picked', { theme: 'white_cross_dark' }, false],
    ['following the device switched off', { theme: 'white_cross', autoSwitchTheme: false }, false],
    ['following the device switched on', { theme: 'dnf', autoSwitchTheme: true }, true],
  ])('follows the device by default, but not over an earlier pick: %s', async (_label, saved, follows) => {
    expect((await load(saved)).get().autoSwitchTheme).toBe(follows);
  });

  it.each([
    ['themeLight', 'comp_day', 'comp_day'],
    ['themeLight', 'dnf', 'white_cross'], // a dark theme can't be the light one
    ['themeLight', 'serika_dark', 'white_cross'],
    ['themeDark', 'sub_10', 'sub_10'],
    ['themeDark', 'white_cross', 'white_cross_dark'],
    ['themeDark', 7, 'white_cross_dark'],
  ])('keeps %s = %j only if it is a theme of that kind', async (key, value, expected) => {
    expect((await load({ [key]: value })).get()).toMatchObject({ [key]: expected });
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
    const s = await load({ autoSwitchTheme: false });
    s.updateSettings({ precision: 3 });
    expect(css.size).toBe(0);
    s.updateSettings({ theme: 'stackmat' });
    const stackmat = getTheme('stackmat');
    expect(css.get('--bg-color')).toBe(stackmat.bg);
    expect(css.get('--main-color')).toBe(stackmat.main);
    expect(css.get('color-scheme')).toBe('light');
    // both of the browser's theme colours: the page's own colour, in light mode and in dark
    expect(attrs.get('meta-light.content')).toBe(stackmat.bg);
    expect(attrs.get('meta-dark.content')).toBe(stackmat.bg);
    expect(local.json(`cubr.themeColors`)).toMatchObject({ '--bg-color': stackmat.bg, 'color-scheme': 'light' });
    s.updateSettings({ theme: 'dnf' });
    expect(css.get('color-scheme')).toBe('dark'); // dark scrollbars, dropdown lists and pickers
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
    expect(s.get()).toMatchObject({ precision: 2, theme: 'white_cross', autoSwitchTheme: true, virtualSpeed: 100, timerSize: 9, inspection: true });
    expect(local.json(KEY)).toMatchObject({ precision: 2, theme: 'white_cross', timerSize: 9 });
    expect(css.get('--bg-color')).toBe(getTheme('white_cross').bg);
    await vi.advanceTimersByTimeAsync(1000);
    expect(push).not.toHaveBeenCalled();
  });

  it("decide on following the device by the account's theme when they are from before it could", async () => {
    // an account that picked a theme keeps it, even on a device that follows its mode
    const s = await load();
    switchTo('dark');
    s.mergeServerSettings({ theme: 'comp_day', precision: 3 });
    expect(s.get()).toMatchObject({ theme: 'comp_day', autoSwitchTheme: false });
    expect(css.get('--bg-color')).toBe(getTheme('comp_day').bg);
    // an account on the default theme follows the device, whatever this device had
    const t = await load({ theme: 'dnf' });
    t.mergeServerSettings({ theme: 'white_cross' });
    expect(t.get()).toMatchObject({ theme: 'white_cross', autoSwitchTheme: true });
    expect(css.get('--bg-color')).toBe(getTheme('white_cross_dark').bg);
    // newer settings say so themselves
    const u = await load();
    u.mergeServerSettings({ theme: 'dnf', autoSwitchTheme: true, themeDark: 'sune' });
    expect(u.get()).toMatchObject({ theme: 'dnf', autoSwitchTheme: true, themeDark: 'sune' });
    expect(css.get('--bg-color')).toBe(getTheme('sune').bg);
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

describe("following the device's light or dark mode", () => {
  it('shows white cross in light mode and white cross dark in dark mode, switching with the device', async () => {
    const s = await load();
    s.applyVisualSettings();
    expect(css.get('--bg-color')).toBe(getTheme('white_cross').bg);
    expect(css.get('color-scheme')).toBe('light');
    switchTo('dark');
    expect(css.get('--bg-color')).toBe(getTheme('white_cross_dark').bg);
    expect(css.get('--text-color')).toBe(getTheme('white_cross_dark').text);
    expect(css.get('color-scheme')).toBe('dark');
    expect(attrs.get('meta-light.content')).toBe(getTheme('white_cross_dark').bg);
    switchTo('light');
    expect(css.get('--bg-color')).toBe(getTheme('white_cross').bg);
  });

  it('opens in the mode the device is in', async () => {
    device.matches = true;
    const s = await load();
    expect(s.activeTheme()).toBe('white_cross_dark');
    s.applyVisualSettings();
    expect(css.get('--bg-color')).toBe(getTheme('white_cross_dark').bg);
  });

  it('stores a light and a dark set of colours for the first paint while following, one set otherwise', async () => {
    const s = await load();
    s.applyVisualSettings();
    const stored = local.json('cubr.themeColors') as { light: Record<string, string>; dark: Record<string, string> };
    expect(stored.light).toMatchObject({ '--bg-color': '#ffffff', 'color-scheme': 'light' });
    expect(stored.dark).toMatchObject({ '--bg-color': getTheme('white_cross_dark').bg, 'color-scheme': 'dark' });
    s.setAutoSwitchTheme(false);
    expect(local.json('cubr.themeColors')).toMatchObject({ '--bg-color': '#ffffff', 'color-scheme': 'light' });
  });

  it('leaves the page alone when the device switches while a theme is set on its own', async () => {
    const s = await load({ theme: 'dnf' });
    s.applyVisualSettings();
    switchTo('dark');
    switchTo('light');
    expect(css.get('--bg-color')).toBe(getTheme('dnf').bg);
  });

  it('makes a picked theme the light or the dark one by its colours, or the theme when not following', async () => {
    const s = await load();
    s.applyVisualSettings();
    // dark, while the device is light: saved for dark mode, the page stays light, and the caller hears so
    expect(s.chooseTheme('sub_10')).toBe('dark');
    expect(s.themeWaitsNote('sub_10', 'dark')).toBe('sub 10 is your dark theme now: it shows while your device is in dark mode');
    expect(s.get()).toMatchObject({ themeLight: 'white_cross', themeDark: 'sub_10', theme: 'white_cross' });
    expect(css.get('--bg-color')).toBe(getTheme('white_cross').bg);
    expect(s.chooseTheme('comp_day')).toBeNull(); // light, in light mode: on screen at once
    expect(s.get()).toMatchObject({ themeLight: 'comp_day', themeDark: 'sub_10' });
    expect(css.get('--bg-color')).toBe(getTheme('comp_day').bg);
    switchTo('dark');
    expect(css.get('--bg-color')).toBe(getTheme('sub_10').bg);
    s.setAutoSwitchTheme(false);
    expect(s.chooseTheme('stackmat')).toBeNull();
    expect(s.get()).toMatchObject({ theme: 'stackmat', themeLight: 'comp_day', themeDark: 'sub_10' });
    expect(css.get('--bg-color')).toBe(getTheme('stackmat').bg);
  });

  it('switches following off and on without changing the theme on screen', async () => {
    const s = await load();
    switchTo('dark');
    s.setAutoSwitchTheme(false); // the dark theme on screen becomes the theme
    expect(s.get()).toMatchObject({ autoSwitchTheme: false, theme: 'white_cross_dark' });
    expect(css.get('--bg-color')).toBe(getTheme('white_cross_dark').bg);
    s.updateSettings({ theme: 'dnf' });
    s.setAutoSwitchTheme(true); // dnf is dark: it becomes the dark theme, and stays on screen
    expect(s.get()).toMatchObject({ autoSwitchTheme: true, themeDark: 'dnf', themeLight: 'white_cross' });
    expect(css.get('--bg-color')).toBe(getTheme('dnf').bg);
  });
});
