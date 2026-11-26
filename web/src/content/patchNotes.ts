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
    version: '1.7.0',
    date: '2026-11-27',
    title: "csTimer's other events, 42 themes, daily reminders and a feedback form",
    sections: [
      {
        heading: 'new',
        items: [
          "csTimer's other puzzles and the relays, in the event menu under the wca events. fto joins the wca events (official from 2 january 2027)",
          "a scramble menu next to the event: practise pll, 2x2 eg and csTimer's other scramble types, each in its own practice session. only an event's default scramble counts for personal bests and leaderboards",
          'scramble previews for nearly every puzzle, flat or in 3d',
          '31 new themes, 42 in all, and a high-contrast setting that keeps labels, links and errors easy to read in every theme (settings > theme)',
          "daily reminders: a notification at the hour you pick, on days you haven't played the daily challenge yet (settings > app; 10:00 to start with). on an iphone or ipad, install cubr first",
          "a feedback link at the bottom of every page: write to us right there, with your email if you'd like an answer, or open an issue on github",
          'report a profile or a race room with the flag beside it, and mute someone in race chat',
          '"sign out everywhere else", on your account page and in the command palette',
          'an email tells you when a google or github sign-in is connected to your account or removed from it',
          'a help section and an accessibility statement on the about page',
        ],
      },
      {
        heading: 'changed',
        items: [
          'a daily challenge attempt counts from the moment it starts: esc, a reload or a closed tab makes it a dnf, so each scramble gets one try',
          "importing a file again, or a newer backup from the same timer, adds only the solves you don't have yet",
          'cubr works from the keyboard alone: a "skip to content" link, tab walks the timer page\'s controls, menus answer the arrow keys, and dialogs give focus back when they close',
          "screen readers hear a solve's time once it ends, and nothing while it runs",
          'reduced motion is followed everywhere, and focus stays visible in windows high contrast',
          'long scrambles scroll inside their box, so the timer page holds together',
          'the daily, about, settings and legal pages no longer jump while they load',
          'cubr opens faster: smart cube, bluetooth timer, stackmat and virtual puzzle input load only when you pick them',
          'usernames, display names and bios go through a word filter, race chat keeps out slurs, and names like admin or cubr are reserved',
          'the wca comparison on profiles says how recent its results are',
          'the privacy policy changed (effective 27 november 2026). it covers the feedback form, daily reminders and moderation records (kept 2 years), and it says that emails to us are kept up to 12 months, that resend sends from japan and keeps its copies 30 days, that race chat lasts until 2 hours after the room was last active, that server logs are kept 14 days at most, and that search engines are asked not to list profiles',
          "the terms changed (effective 27 november 2026): confirm your email within 7 days, or the address can be used by another account; the worst kinds of content (what australian law calls class 1a and 1b) are removed at once and the account closed; and how to report something, to cubr or to australia's esafety commissioner",
        ],
      },
      {
        heading: 'fixed',
        items: [
          'a dialog that opens mid-solve no longer swallows the key that stops the timer',
          "the daily page no longer retries forever when an attempt's solve was deleted: the attempt shows as used",
          "imports keep each session's order and place solves without a date",
          'averages read the same on every page',
          "when a session or event fails to load, the last one's numbers no longer stay on screen",
          "a settings change that didn't reach your account is kept and sent again",
          'solves waiting to sync for a session you merged on another device go to a recovered session instead of being lost',
          "two open tabs no longer overwrite each other's unsent solves",
          "a solve entered later for an earlier day no longer puts the session's current ao5 on that day's board",
          'stats keep up with accounts at the 250,000-solve limit',
          "race rooms hold up better: nobody can play as someone else's guest, and a room keeps its last 25 rounds while the standings count them all",
          'page views are no longer counted when your browser sends global privacy control or do not track, as the privacy policy says',
          'the weekly update of wca results runs again',
          'a save could now and then fail on a connection the server was just closing',
        ],
      },
      {
        heading: 'behind the scenes',
        items: [
          "pages carry their text for search engines and link previews that don't run javascript, and ai training crawlers are turned away",
          'a limit on how fast one visitor can use the api, so nobody can slow cubr down for everyone',
          'the server watches its disk, services, errors and backups, and asks for help when something needs a person',
          'faster under the hood: half the idle cpu, wca rank lookups about five times quicker, and pages compressed with brotli',
          'checks on the libraries cubr is built on, and tests that run cubr in a real browser, accessibility included',
          'a favicon that stays sharp in small tabs and search results',
          "cubr no longer keeps wca competitors' gender, which it never showed",
          'the licences of everything cubr ships, at cubr.dev/licenses.txt (linked from about)',
          "cubr's code has a contributing guide and a code of conduct, and security issues can be reported privately on github",
        ],
      },
    ],
  },
  {
    version: '1.6.0',
    date: '2026-11-20',
    title: 'change your password, a screen that stays on while you solve, and a better timer on touch screens',
    sections: [
      {
        heading: 'new',
        items: [
          'change your password on your account page, or set one if you signed up with google or github. every other device is signed out, an email tells you it happened, and your password manager\'s "change password" button opens it',
          "the screen stays on while you time, and for five minutes after a solve, so your phone doesn't go to sleep mid-solve or while you scramble",
          'on an iphone or ipad in dark mode, cubr opens from the home screen on a dark screen. added it before? remove it and add it again: ios saves the picture when the app is added',
        ],
      },
      {
        heading: 'changed',
        items: [
          'on touch screens, holding the timer starts it instead of selecting text, the line under the time starts it too, and a quick double tap no longer zooms in',
          'buttons and fields are a fingertip tall on touch screens, and a button or row you tapped no longer stays highlighted',
          "cubr's emails follow your mail app's dark mode, and a second reset link no longer hides in the first one's thread in gmail",
        ],
      },
      {
        heading: 'fixed',
        items: ['the stats rows on the timer page line up with the solves beside them', 'one solve is "1 solve", not "1 solves"'],
      },
      {
        heading: 'behind the scenes',
        items: [
          'the server makes every profile picture afresh, so none can carry hidden details from the original file, such as where a photo was taken',
          'if cubr\'s server is ever down, you see a cubr "back in a moment" page instead of an error',
          'each page tells search engines what it is, in the words cubers search for',
        ],
      },
    ],
  },
  {
    version: '1.5.0',
    date: '2026-11-18',
    title: 'light and dark mode, a better fit on phones, and an email you can confirm and change',
    sections: [
      {
        heading: 'new',
        items: [
          'a new theme, white cross dark. cubr can follow your device\'s light or dark mode: white cross by day and white cross dark at night, or any light and dark pair you pick (settings > theme, "light and dark mode"). a theme you picked before stays until you switch this on',
          'change your email on your account page: a link to the new address confirms it, and the old address is told',
          'new accounts confirm their email with a link sent at sign-up. password-reset links only go to a confirmed address, so a mistyped email can\'t hand your account to a stranger. made your account before today? reset links still reach you, and you can confirm your email on your account page ("send link")',
          'links to cubr.dev show a preview in chats and on social sites: the logo, "cubr" and "a minimalist speedcubing timer"',
          'on an iphone or ipad, cubr opens from the home screen on its cube instead of a white screen. added it before? remove it and add it again: ios saves the picture when the app is added',
          'a "support" link at the bottom of every page, to cubr\'s ko-fi',
        ],
      },
      {
        heading: 'changed',
        items: [
          'every page fits small phones, phones on their side and tablets. on a phone held sideways, the timer, its time and the +2/dnf buttons fit on one screen',
          'profiles no longer jump around while they load on a phone, and their big numbers show sooner',
          'with light and dark mode on, "random" picks a new light and a new dark theme',
          "scrollbars and dropdowns turn dark with dark themes, and the browser's bar takes the theme's colour",
          'the daily and race pages say "hold the timer" on touch screens',
          'the about page is linked from the (i) in the header instead of the bottom of the page, and has a shorter supporters line',
          'the privacy policy now covers counting page views, error reports and the emails that confirm an address',
        ],
      },
      {
        heading: 'fixed',
        items: [
          'a mis-tap as your personal best no longer keeps your real solves off the all-time boards, and an average with a mis-tap in it never ranks',
          'when the anti-cheat leaves a time off a board, the leaderboard says so in red, and what to do',
          'the daily and weekly boards follow deleted solves, penalties, and merged, imported and practice sessions',
          'a long session name no longer pushes the timer bar off the screen, and text fields no longer make iphones zoom in',
        ],
      },
      {
        heading: 'behind the scenes',
        items: [
          'cubr counts page views with cloudflare web analytics: no cookies, totals only, and never when your browser sends global privacy control or do not track',
          'when something breaks in your browser, cubr sends itself a short error report so it can be fixed, with nothing personal in it',
          "security headers on every page, a robots.txt, a sitemap and a security contact. addresses that don't exist answer a real 404, and each page has one address for search engines, which also learn the site's name and logo",
          'security updates to the libraries cubr is built on',
        ],
      },
    ],
  },
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
          "the tab icon takes your theme's colours",
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
