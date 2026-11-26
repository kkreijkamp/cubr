// What a viewer can do about someone else's content (decided 2026-11-26): report a profile or a race room
// by email, and mute a player in race chat for themselves. The servers refuse slurs in chat and words cubr
// doesn't allow in names and bios (packages/common moderation.ts).
import { CONTACT_EMAIL, SITE_URL } from './links';

/** An email to cubr's address reporting a profile or a race room: room to say what's wrong, then its address. */
export function reportMailto(what: 'profile' | 'race room', name: string, path: string): string {
  const subject = `report: ${what} ${name}`;
  const body = `What's wrong (a name, a picture, a bio, a chat message...), and when:\n\n\n-- \n${SITE_URL}${path}`.replace(/\n/g, '\r\n');
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

const MUTED_KEY = 'cubr.mutedPlayers';
/** the most players remembered (the oldest go first) */
export const MUTED_MAX = 200;

/** The players muted in race chat on this device (their messages show nowhere here), oldest first. */
export function mutedPlayers(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(MUTED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-MUTED_MAX) : [];
  } catch {
    return [];
  }
}

export function setMutedPlayers(ids: readonly string[]): void {
  try {
    localStorage.setItem(MUTED_KEY, JSON.stringify([...new Set(ids)].slice(-MUTED_MAX)));
  } catch {
    /* storage unavailable: it lasts while the page is open */
  }
}
