import { describe, expect, it } from 'vitest';
import { PATCH_NOTES, compareVersions, releaseFor } from '../patchNotes';

describe('patch notes', () => {
  it('are newest first, with valid versions, dates and non-empty sections', () => {
    for (let i = 0; i < PATCH_NOTES.length; i++) {
      const note = PATCH_NOTES[i];
      expect(note.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(note.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(note.title.length).toBeGreaterThan(0);
      expect(note.sections.length).toBeGreaterThan(0);
      for (const s of note.sections) expect(s.items.length).toBeGreaterThan(0);
      if (i > 0) {
        expect(compareVersions(PATCH_NOTES[i - 1].version, note.version)).toBe(1);
        expect(PATCH_NOTES[i - 1].date >= note.date).toBe(true);
      }
    }
  });

  it('compares versions numerically', () => {
    expect(compareVersions('1.1.0', '1.0.85')).toBe(1);
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('finds the release a running version belongs to', () => {
    const notes = [
      { version: '1.1.0', date: '2026-11-16', title: 'b', sections: [] },
      { version: '1.0.19', date: '2026-10-21', title: 'a', sections: [] },
    ];
    expect(releaseFor('1.1.0', notes)).toBe('1.1.0');
    expect(releaseFor('1.1.3', notes)).toBe('1.1.0'); // patches after a release
    expect(releaseFor('1.0.40', notes)).toBe('1.0.19');
    expect(releaseFor('1.0.2', notes)).toBeNull(); // older than every note
    expect(releaseFor('dev', notes)).toBeNull();
    expect(releaseFor(null, notes)).toBeNull();
  });
});
