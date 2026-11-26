import { DataSet, englishDataset, englishRecommendedTransformers, RegExpMatcher } from 'obscenity';

// ---------------------------------------------------------------------------------------------
// Words cubr doesn't allow, from obscenity's English list (npm `obscenity`, MIT): it catches spelling
// tricks (l33t, spacing, repeated letters) and leaves innocent words that contain a bad one alone.
// Two strengths (decided 2026-11-26):
// - names and bios, which show to everyone (leaderboards, profiles, race rooms): the whole list;
// - race chat, where guests talk too: slurs only, so a cuber can still swear at a bad solve.
// ---------------------------------------------------------------------------------------------

/**
 * The list's slurs (by its own words): blocked in race chat. "negro" stays out of chat: it's the Spanish
 * and Portuguese word for black (names still refuse it).
 */
const SLURS = new Set(['abeed', 'abo', 'africoon', 'arabush', 'boonga', 'chingchong', 'chink', 'dyke', 'fag', 'kike', 'nigger', 'retard', 'spastic', 'tranny']);

// built on first use: every service loads @cubr/common, only auth and race check words
let everything: RegExpMatcher | null = null;
let slurs: RegExpMatcher | null = null;

/** A name or bio with a word cubr doesn't allow (the whole list). */
export function hasBlockedWord(text: string): boolean {
  everything ??= new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
  return everything.hasMatch(text);
}

/** A race chat message with a slur. */
export function hasSlur(text: string): boolean {
  slurs ??= new RegExpMatcher({
    ...new DataSet<{ originalWord: string }>()
      .addAll(englishDataset)
      .removePhrasesIf((phrase) => !SLURS.has(phrase.metadata?.originalWord ?? ''))
      .build(),
    ...englishRecommendedTransformers,
  });
  return slurs.hasMatch(text);
}

/**
 * Usernames nobody may take, so no one can pose as the site or its staff: compared without case,
 * underscores or trailing digits ("Admin_1" is "admin").
 */
// prettier-ignore
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'root', 'system', 'sysadmin', 'superuser', 'owner', 'staff', 'team', 'moderator', 'mod', 'mods',
  'support', 'help', 'helpdesk', 'contact', 'hello', 'info', 'security', 'abuse', 'privacy', 'legal', 'billing',
  'postmaster', 'hostmaster', 'webmaster', 'noreply', 'mail', 'email',
  'cubr', 'cubrdev', 'cubrofficial', 'cubrteam', 'cubrsupport', 'cubradmin', 'official', 'verified',
  'wca', 'worldcubeassociation', 'api', 'www', 'app', 'status', 'guest', 'anonymous', 'null', 'undefined', 'deleted',
]);

export function isReservedUsername(name: string): boolean {
  return RESERVED_USERNAMES.has(name.toLowerCase().replace(/_/g, '').replace(/\d+$/, ''));
}
