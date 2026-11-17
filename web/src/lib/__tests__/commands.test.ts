import { describe, expect, it } from 'vitest';
import { closePalette, matches, openPalette, paletteStore, type Command } from '../commands';

const cmd = (label: string, keywords?: string[]): Command => ({ id: label, label, keywords });

describe('command palette search', () => {
  const theme = cmd('Theme: white cross', ['light', 'colours']);

  it.each([
    ['', true],
    ['   ', true],
    ['the', true],
    ['THEME', true],
    ['th wh', true], // every word prefixes some word
    ['white theme', true], // in any order
    ['theme > white', true], // ">" separates like a space (nested lists)
    ['light', true], // a keyword
    ['col', true],
    ['heme', false], // not a prefix
    ['theme dark', false], // every word must match
    ['crossing', false],
  ])('%j %s "Theme: white cross"', (query, expected) => {
    expect(matches(theme, query)).toBe(expected);
  });

  it('matches a label typed with its punctuation', () => {
    expect(matches(cmd('Light / dark mode...'), 'light / dark')).toBe(true);
    expect(matches(cmd('Light / dark mode...'), 'light/dark mode')).toBe(true);
    expect(matches(cmd('off (one theme)'), 'off (one')).toBe(true);
    expect(matches(cmd('Light / dark mode...'), 'light / darker')).toBe(false);
  });

  it('keeps +, . and : inside words, so penalties and times can be typed', () => {
    expect(matches(cmd('Set penalty +2'), '+2')).toBe(true);
    expect(matches(cmd('Set penalty +2'), '2')).toBe(false);
    expect(matches(cmd('Jump to 1:30.00'), '1:30')).toBe(true);
    expect(matches(cmd('Average ao5'), 'ao')).toBe(true);
  });
});

describe('palette state', () => {
  it('opens, optionally on a nested list, and closes', () => {
    openPalette('theme');
    expect(paletteStore.get()).toEqual({ open: true, initial: 'theme' });
    closePalette();
    expect(paletteStore.get()).toEqual({ open: false, initial: null });
    openPalette();
    expect(paletteStore.get()).toEqual({ open: true, initial: null });
    closePalette();
  });
});
