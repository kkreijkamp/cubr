import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpTrayIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  ClockIcon,
  CommandLineIcon,
  FlagIcon,
  GiftIcon,
  GlobeAltIcon,
  HeartIcon,
  SignalSlashIcon,
  Square3Stack3DIcon,
  SwatchIcon,
  TrophyIcon,
} from '@heroicons/react/24/outline';
import { CubeLogo } from '../components/CubeLogo';
import { useCountUp } from '../components/social/useCountUp';
import { friendlyError } from '../components/social/util';
import { api } from '../lib/api';
import { formatDate, formatNumber } from '../lib/format';
import { useCanonical } from '../lib/canonical';
import { PAGE_META } from '../lib/pageMeta';
import { usePageMeta } from '../lib/usePageMeta';
import { DONATE_URL } from '../lib/links';
import { THEMES } from '../lib/themes';
import type { GlobalStats } from '../lib/types';
import { useAsync } from '../lib/useAsync';
import '../components/social/about.css';

const REFRESH_MS = 15_000;

// a feature with a page of its own links to it (`to`): descriptive links between pages help search
// engines and people find them
const FEATURES: { icon: typeof ClockIcon; t: string; d: string; to?: string }[] = [
  { icon: ClockIcon, t: 'a timer that gets out of the way', to: '/', d: 'space to start, hold-to-ready, wca inspection with 8 s / 12 s alerts, +2 and dnf, focus mode while solving.' },
  { icon: ChartBarIcon, t: 'csTimer-grade stats', d: 'mo3, ao5 ... ao1000 with wca trimming, session bests, and a solve history chart on your profile.' },
  { icon: ArrowUpTrayIcon, t: 'sessions & import', d: 'unlimited sessions for all 16 wca events, import from csTimer and every timer it reads, json and csTimer export.' },
  { icon: CalendarDaysIcon, t: 'daily challenge', to: '/daily', d: 'five shared scrambles a day for everyone, ranked by ao5 on a global board.' },
  { icon: FlagIcon, t: 'live races', to: '/race', d: 'real-time multiplayer rooms over websockets - share a link and race any event.' },
  { icon: TrophyIcon, t: 'leaderboards', to: '/leaderboards', d: 'all-time, weekly and daily boards for every event, single, ao5 and ao12.' },
  { icon: GlobeAltIcon, t: 'wca comparison', to: '/wca', d: 'see where your personal bests would rank among every official wca competitor.' },
  { icon: SwatchIcon, t: 'themes & command line', d: `${THEMES.length} cube-inspired themes with live preview, light or dark with your device. press esc and type - everything is a command.` },
  { icon: SignalSlashIcon, t: 'an app that works offline', d: "install it on your phone or computer. the timer opens and works without a connection, and your solves sync when you're back online." },
];

// the everyday ones - csTimer's keys; settings > keyboard shortcuts lists them all
const KEYS: [string[], string][] = [
  [['esc'], 'command line (or ctrl + k)'],
  [['space'], 'hold, release to start - press to stop'],
  [['tab'], 'new scramble'],
  [['alt', '1-7'], 'switch event: square-1, 2x2 ... 7x7 (alt + p / m / c / s for the others)'],
  [['ctrl', '1'], 'mark the last solve ok'],
  [['ctrl', '2'], 'add a +2 to the last solve'],
  [['ctrl', '3'], 'mark the last solve dnf'],
  [['alt', 'z'], 'delete the last solve (or ctrl + z)'],
  [['alt', 'd'], 'clear the session'],
  [['<-', '->'], 'flip leaderboard pages'],
];

function Counter({ label, value, decimals = 0, hint }: { label: string; value: number | null; decimals?: number; hint?: string }) {
  const animated = useCountUp(value);
  const text =
    value === null ? '-' : decimals > 0 ? animated.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : formatNumber(Math.round(animated));
  return (
    <div className="stat" data-tip={hint}>
      <span className="label">{label}</span>
      <span className={`value${value === null ? ' dim' : ''}`}>{text}</span>
    </div>
  );
}

function GlobalCounters() {
  const stats = useAsync<GlobalStats>((signal) => api.stats.global(signal), []);
  const { reload } = stats;

  // refresh the live counters while the tab is visible
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);

  const d = stats.data;
  const hours = d ? d.totalMs / 3_600_000 : null;
  return (
    <section aria-label="live stats" data-nosnippet>
      <div className="ab-counters">
        <Counter label="cubers" value={d ? d.users : null} />
        <Counter label="solves" value={d ? d.solves : null} />
        <Counter label="hours cubed" value={hours} decimals={hours !== null && hours < 100 ? 1 : 0} />
        <Counter label="solves today" value={d ? d.solvesToday : null} hint={d ? `by ${formatNumber(d.activeUsersToday)} cubers` : undefined} />
      </div>
      {stats.error && !d && (
        <div className="ab-counters-note" style={{ marginTop: '1rem' }}>
          {friendlyError(stats.error, 'the stats service')} - the counters come back on their own.{' '}
          <button className="btn-text" onClick={reload}>
            retry
          </button>
        </div>
      )}
    </section>
  );
}

function WcaCitation() {
  const meta = useAsync((signal) => api.wca.meta(signal), []);
  return (
    <div className="ab-citation">
      This information is based on competition results owned and maintained by the World Cube Association, published at{' '}
      <a href="https://www.worldcubeassociation.org/results" target="_blank" rel="noreferrer noopener">
        worldcubeassociation.org/results
      </a>
      {meta.data ? ` as of ${formatDate(meta.data.exportDate)}` : ''}. cubr is not affiliated with the WCA.
    </div>
  );
}

function Supporters() {
  const list = useAsync((signal) => api.supporters.list(signal), []);
  const names = list.data?.supporters ?? [];
  return (
    <section aria-labelledby="ab-supporters">
      <h2 className="ab-h" id="ab-supporters">
        <GiftIcon /> supporters
      </h2>
      <p className="ab-p">
        if you&apos;d like to support hosting and development of cubr,{' '}
        <a href={DONATE_URL} target="_blank" rel="noreferrer noopener">
          consider donating
        </a>
      </p>
      {names.length > 0 ? (
        <ul className="ab-supporters">
          {names.map((s) => (
            <li key={s.name}>
              {s.name}
              {s.member && (
                <span className="pill" data-tip="a monthly ko-fi member">
                  member
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        list.data && (
          <p className="ab-p">
            <span className="sub">no supporters yet</span>
          </p>
        )
      )}
    </section>
  );
}

export default function AboutPage() {
  useCanonical('/about');
  usePageMeta(PAGE_META['/about']);

  return (
    <div className="ab">
      <section className="ab-hero">
        <h1 className="ab-logo">
          <CubeLogo /> cubr
        </h1>
        <p className="ab-lead">
          a minimal speedcubing timer, made by <span className="text">Koen Kreijkamp</span>
        </p>
      </section>

      <GlobalCounters />

      <section aria-labelledby="ab-features">
        <h2 className="ab-h" id="ab-features">
          <Square3Stack3DIcon /> features
        </h2>
        <div className="ab-features">
          {FEATURES.map(({ icon: Icon, t, d, to }) => (
            <div className="ab-feature" key={t}>
              <Icon aria-hidden="true" />
              {to ? (
                <Link className="t" to={to}>
                  {t}
                </Link>
              ) : (
                <span className="t">{t}</span>
              )}
              <span className="d">{d}</span>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="ab-keys">
        <h2 className="ab-h" id="ab-keys">
          <CommandLineIcon /> keyboard shortcuts
        </h2>
        <p className="ab-p">
          The same keys as csTimer, so your habits carry over. The everyday ones are below; <Link to="/settings?tab=shortcuts">settings</Link> lists them all.
        </p>
        <div className="ab-keys">
          {KEYS.map(([keys, label]) => (
            <div key={label} style={{ display: 'contents' }}>
              <span className="k">
                {keys.map((k, i) => (
                  <span key={k} style={{ display: 'contents' }}>
                    {i > 0 && (keys[0] === '<-' ? ' ' : ' + ')}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </span>
              <span className="v">{label}</span>
            </div>
          ))}
        </div>
      </section>

      <Supporters />

      <section aria-labelledby="ab-credits">
        <h2 className="ab-h" id="ab-credits">
          <HeartIcon /> credits
        </h2>
        <div className="ab-credits">
          <div className="ab-credit">
            <a href="https://cstimer.net" target="_blank" rel="noreferrer noopener">
              csTimer
            </a>
            <span className="d">by cs0x7f - the timer behaviour, statistics and export format cubers rely on.</span>
          </div>
          <div className="ab-credit">
            <a href="https://monkeytype.com" target="_blank" rel="noreferrer noopener">
              monkeytype
            </a>
            <span className="d">by miodec - the design language and command line this app borrows.</span>
          </div>
          <div className="ab-credit">
            <a href="https://js.cubing.net/cubing/" target="_blank" rel="noreferrer noopener">
              cubing.js
            </a>
            <span className="d">by lucas garron &amp; tom rokicki - random-state scrambles and puzzle previews.</span>
          </div>
          <div className="ab-credit">
            <a href="https://www.worldcubeassociation.org" target="_blank" rel="noreferrer noopener">
              world cube association
            </a>
            <span className="d">official competition results behind the rankings and comparisons.</span>
          </div>
        </div>
        <WcaCitation />
      </section>
    </div>
  );
}
