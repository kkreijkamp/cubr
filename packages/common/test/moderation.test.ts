import { describe, expect, it } from 'vitest';
import { hasBlockedWord, hasSlur, isReservedUsername } from '../src/moderation.js';

// The word filter (obscenity's English list) and the reserved usernames.
describe('words cubr does not allow', () => {
  it('refuses them in names and bios, spelling tricks included', () => {
    for (const t of ['xX_fuck_Xx', 'shithead', 'fvck', 'b1tch']) expect(hasBlockedWord(t), t).toBe(true);
  });

  it('leaves innocent words that contain one alone', () => {
    for (const t of [
      'assassin',
      'classic cuber',
      'Scunthorpe',
      'cocktail',
      'passionate',
      'bassist',
      'therapist',
      'analysis',
      'Dickens',
      'Feliks',
      'koen_k',
      'sub-10 ao5',
    ]) {
      expect(hasBlockedWord(t), t).toBe(false);
    }
  });

  it('refuses only slurs in race chat: a cuber may still swear at a bad solve', () => {
    for (const t of ['retard', 'r3tard', 'you are a retard lol']) expect(hasSlur(t), t).toBe(true);
    for (const t of ['what a shit solve', 'fuck, a +2', 'gg', 'cubo negro']) expect(hasSlur(t), t).toBe(false);
  });
});

describe('reserved usernames', () => {
  it("are the site's and its staff's, whatever the case, underscores or trailing digits", () => {
    for (const u of ['admin', 'Admin_1', 'cubr', 'CUBR_official', 'support2', 'moderator_99', 'wca', 'no_reply']) expect(isReservedUsername(u), u).toBe(true);
    for (const u of ['koen', 'adminx', 'cubrfan', 'feliks_z', 'helpful_cuber']) expect(isReservedUsername(u), u).toBe(false);
  });
});
