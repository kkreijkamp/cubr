// Patch notes shown when you click the version in the footer (PatchNotesModal), newest first.
// One entry per release that `main` gets; patch versions in between (every commit bumps one) roll
// up into the next release's notes. Written for cubers, in the UI's lowercase voice.

export interface PatchNoteSection {
  heading: 'new' | 'changed' | 'fixed' | 'behind the scenes';
  items: string[];
}

export interface PatchNote {
  /** semver of the release, without the leading v */
  version: string;
  /** release day, YYYY-MM-DD */
  date: string;
  title: string;
  sections: PatchNoteSection[];
}

export const PATCH_NOTES: readonly PatchNote[] = [
  {
    version: '1.4.0',
    date: '2026-11-17',
    title: 'sign in with google or github, and an app that works offline',
    sections: [
      {
        heading: 'new',
        items: [
          'sign in with google or github: one click on the sign-in page, then pick your username. already have an account? connect either one on your account page',
          'install cubr as an app on your phone or computer, with its own window and icon. the timer opens and works offline, and your solves sync once you are back online',
          'new versions download in the background: click "update ready" to switch, or it happens on your next click inside the app',
          'practice sessions get a little bottle after their name',
        ],
      },
      {
        heading: 'changed',
        items: ["white cross's greys are cooler and cleaner", 'a slightly tighter logo', 'the privacy policy covers signing in with google or github'],
      },
      {
        heading: 'fixed',
        items: [
          'after a password reset, an old sign-in could still join race rooms. now it is signed out there too',
          'twisty timer +2 solves imported 2 seconds too slow',
          'an import with a date past the year 9999 failed as a whole',
          'a 0 ms solve from a gan cube became a 0.001 s pb',
          "right after switching accounts, the new one could briefly see the previous account's new sessions",
          '"solves today" on the about page counts by the utc day',
          'a deleted account could reappear on the leaderboards after a rebuild',
          'clearer messages when race rooms or the daily challenge are briefly unavailable',
        ],
      },
      {
        heading: 'behind the scenes',
        items: ['many more automated tests: about 1,200 for the servers and 420 for the app, which found most of the fixes above'],
      },
    ],
  },
  {
    version: '1.3.0',
    date: '2026-11-16',
    title: 'private profiles, supporters and the fine print',
    sections: [
      {
        heading: 'new',
        items: [
          'private profiles: in edit profile, pick who can see yours. everyone else then sees only your picture and username',
          'support cubr on ko-fi (ko-fi.com/cubrr): make it public there and your name shows on the about page',
          'terms of service and a privacy policy, linked at the bottom of every page',
        ],
      },
      {
        heading: 'changed',
        items: ['a shorter about page'],
      },
      {
        heading: 'behind the scenes',
        items: [
          'scramble requests have per-address limits, so no one can tie up the scramble server',
          'exports stream in batches, imports and exports have hourly limits, and an account holds up to 250,000 solves',
          'server logs rotate on their own',
        ],
      },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-11-16',
    title: 'password reset, daily penalties and a white default theme',
    sections: [
      {
        heading: 'new',
        items: [
          'forgot your password? reset it by email from the sign-in page',
          'daily challenge: mark ok, +2 or dnf after the solve (or ctrl+1 / 2 / 3), and click an earlier attempt to change it. your ao5 and the board follow',
          'every event comes with a practice session next to the main one, e.g. 3x3 and 3x3 practice',
          'a contact address: hello@cubr.dev, in the footer',
        ],
      },
      {
        heading: 'changed',
        items: [
          'white cross is the default theme: pure white, with a brighter green',
          "the monkeytype themes are gone and cubr keeps its own 10 cube-inspired ones. if you used one of them, you're on white cross now",
          'no cloud icon in the timer bar when every solve is saved',
          'the status page and its buttons are gone',
        ],
      },
      {
        heading: 'behind the scenes',
        items: ['cubr is licensed under GPL-3.0'],
      },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-11-16',
    title: 'cubetype is now cubr, at cubr.dev',
    sections: [
      {
        heading: 'new',
        items: [
          'a new name and a home of its own: cubr.dev',
          'smart cubes and bluetooth timers as timer input',
          'stackmat timers through the audio input',
          'a virtual puzzle you turn from the keyboard, with your own keys, floating stickers and sticker outlines',
          'practice sessions: their solves count for no pb or leaderboard',
          "all of csTimer's keyboard shortcuts on the timer page",
          'delete your account from settings > danger zone',
          'pick the sticker colours of the 2d scramble preview',
          'patch notes: click the version in the bottom right',
        ],
      },
      {
        heading: 'changed',
        items: [
          'sign in and sign up on one page, with a show-password button',
          'a redesigned profile: your events in a ring, activity beside time of day, the wca comparison full width and your solves at the bottom, with ao100 and ao1000',
          "pick the activity heatmap's year from its title",
          'the timer page fits the window: no scrolling, no charts, one quiet config bar and every event in one dropdown',
          'settings in one list, with a rail that jumps between sections',
          'session pbs are bold in the solve list',
          '"jump to my rank" on the leaderboards',
          'lexend deca is the default font, with one cleaner icon set',
          'the tab icon takes your theme\'s colours',
          'no focus ring on text fields and selects',
        ],
      },
      {
        heading: 'fixed',
        items: [
          'your theme comes back after previewing others in the command palette',
          'the running timer no longer jitters in fonts without fixed-width digits',
          "the virtual cube's L moves turned two layers",
          'a smart cube solve scrambled by hand kept the wrong scramble',
          "a floating cube's far side showed the wrong colours",
        ],
      },
      {
        heading: 'behind the scenes',
        items: ['a new server in sydney behind cloudflare, with nightly backups and uptime alerts'],
      },
    ],
  },
  {
    version: '1.0.19',
    date: '2026-10-21',
    title: 'the first release',
    sections: [
      {
        heading: 'new',
        items: [
          'a wca-compliant timer: hold to start, 15 s inspection with +2 and dnf, penalties and sessions per event',
          'official random-state scrambles for all 16 wca events, with 2d and 3d previews',
          'mo3 up to ao1000, pbs and cloud sync, with csTimer import and export',
          'leaderboards, a daily challenge and live race rooms',
          'profiles with a solve history chart, activity heatmap and streaks',
          'where would you rank? your times against the official wca results',
          '178 themes and a command palette (esc)',
        ],
      },
    ],
  },
];

const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10));

/** a < b ? -1 : a > b ? 1 : 0 for x.y.z versions */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** The release a running version belongs to: the newest one not above it (null for "dev"). */
export function releaseFor(running: string | null | undefined, notes: readonly PatchNote[] = PATCH_NOTES): string | null {
  if (!running || !/^\d+\.\d+\.\d+$/.test(running)) return null;
  return notes.find((n) => compareVersions(n.version, running) <= 0)?.version ?? null;
}
