// The title and description search engines show for each public page, and the heading crawlers that
// don't run the app read in its HTML (AI search engines, link previews, and Bing at times).
//
// One table, read twice: the app sets the title and description while a page shows (usePageMeta), and
// the build writes each page's HTML with them (plugins/pageFiles.ts), so a crawler reads the same
// before and after the app runs. The home page's are also in index.html, which the tests compare.
//
// The words to rank for are cubers' own: speedcube, cube and timer, and their family (speedcubing,
// speedcubers, cubing, cubers), plus "rubik's cube" in the home and About descriptions (the most common
// way people search for a cube timer; Koen, 2026-11-26), never in a title: it's a trademark, named only
// to say what cubr times. They're used where they read naturally, never as a list: search engines
// discount stuffing, and people skip it. No imports, so the build can read it.

export interface PageMeta {
  /** the tab and the search result's title: at most 60 characters, the brand last (the home page's: first) */
  readonly title: string;
  /** the search result's text, and link previews': 110 to 160 characters */
  readonly description: string;
  /** the page's heading, as it shows it: in the page's HTML before the app starts */
  readonly heading: string;
}

/** The home page: the timer. Its heading is read by screen readers and search engines, not shown. */
export const HOME: PageMeta = {
  title: 'cubr | a minimalist cube timer for speedcubers',
  description: "a minimalist speedcube timer for cubers, from the rubik's cube to every wca event: csTimer-grade stats, a daily challenge and live races with other speedcubers.",
  heading: 'cubr: a minimalist speedcube timer',
};

/** Every page search engines may list (the sitemap's), by path. */
export const PAGE_META = {
  '/': HOME,
  '/daily': {
    title: 'daily speedcubing challenge | cubr',
    description: "five scrambles a day, the same for every cuber: solve them on the cube timer and see where your ao5 ranks on today's global leaderboard.",
    heading: 'daily challenge',
  },
  '/race': {
    title: 'live speedcubing races with friends | cubr',
    description: "race other cubers in real time: open a room, share the link and solve the same scrambles, with everyone's times live and results for every round.",
    heading: 'race',
  },
  '/leaderboards': {
    // the default board's (3x3 single, all-time, plain /leaderboards); the others are named after their board
    title: 'speedcubing leaderboards for every wca event | cubr',
    description: "the fastest cubers on cubr: all-time, weekly and daily leaderboards for every wca event by single, ao5 and ao12, plus each day's challenge.",
    heading: 'all-time 3x3 single leaderboard',
  },
  '/wca': {
    title: 'wca rank calculator for speedcubers | cubr',
    description: "see where your times would rank among every official wca competitor, browse the world records and look up any speedcuber's results.",
    heading: 'wca rankings',
  },
  '/about': {
    title: 'about cubr, a minimalist speedcube timer',
    description: "cubr is a minimalist speedcube timer for the rubik's cube and other puzzles: csTimer-grade stats, a daily challenge, live races and an app that works offline.",
    heading: 'about cubr',
  },
  '/terms': {
    title: 'terms of service | cubr',
    description: 'the terms of service for cubr, a minimalist speedcube timer: who may use it, your account and content, fair play, moderation and liability.',
    heading: 'terms of service',
  },
  '/privacy': {
    title: 'privacy policy | cubr',
    description: "how cubr, a minimalist speedcube timer, handles your data: what it collects and why, what is public, who helps run it, how long it's kept, your rights.",
    heading: 'privacy policy',
  },
} as const satisfies Record<string, PageMeta>;

export type PagePath = keyof typeof PAGE_META;
