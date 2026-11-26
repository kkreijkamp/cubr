import { describe, expect, it } from 'vitest';
import { MUTED_MAX, mutedPlayers, reportMailto, setMutedPlayers } from '../moderation';

// Reporting a profile or a race room by email, and muting a player in race chat on this device.
describe('moderation for viewers', () => {
  it("reports by email to cubr's address, naming what and ending with its address", () => {
    const href = reportMailto('race room', 'k3x9q2ab', '/race/k3x9q2ab');
    expect(href.startsWith('mailto:hello@cubr.dev?subject=report%3A%20race%20room%20k3x9q2ab&body=')).toBe(true);
    const body = decodeURIComponent(href.split('&body=')[1]);
    expect(body).toContain("What's wrong");
    expect(body.endsWith('\r\n-- \r\nhttps://cubr.dev/race/k3x9q2ab')).toBe(true);
    expect(decodeURIComponent(reportMailto('profile', 'koen_k', '/profile/koen_k'))).toContain('subject=report: profile koen_k');
  });

  it('remembers muted players on the device, each once, the latest kept', () => {
    const store = new Map<string, string>();
    const local = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    (globalThis as { localStorage?: unknown }).localStorage = local;
    try {
      expect(mutedPlayers()).toEqual([]);
      setMutedPlayers(['guest-abc123', 'user-1', 'guest-abc123']);
      expect(mutedPlayers()).toEqual(['guest-abc123', 'user-1']);
      setMutedPlayers(Array.from({ length: MUTED_MAX + 5 }, (_, i) => `p${i}`));
      expect(mutedPlayers()).toHaveLength(MUTED_MAX);
      expect(mutedPlayers()[0]).toBe('p5');
      store.set('cubr.mutedPlayers', 'not json');
      expect(mutedPlayers()).toEqual([]);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    // no storage at all: nothing remembered, nothing thrown
    expect(mutedPlayers()).toEqual([]);
    expect(() => setMutedPlayers(['x'])).not.toThrow();
  });
});
