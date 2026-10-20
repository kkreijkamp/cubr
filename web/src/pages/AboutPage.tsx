import { useEffect } from 'react';
import {
  BarChart3,
  CalendarCheck,
  Crown,
  Globe,
  Heart,
  Keyboard,
  Layers,
  Network,
  Palette,
  Swords,
  Timer,
  Upload,
  WifiOff,
  Wrench,
} from 'lucide-react';
import { CubeLogo } from '../components/CubeLogo';
import { ArchitectureDiagram } from '../components/social/ArchitectureDiagram';
import { useCountUp } from '../components/social/useCountUp';
import { friendlyError } from '../components/social/util';
import { api } from '../lib/api';
import { formatDate, formatNumber } from '../lib/format';
import { THEMES } from '../lib/themes';
import type { GlobalStats } from '../lib/types';
import { useAsync } from '../lib/useAsync';
import '../components/social/about.css';

const REFRESH_MS = 15_000;

const FEATURES = [
  { icon: Timer, t: 'a timer that gets out of the way', d: 'space to start, hold-to-ready, wca inspection with 8 s / 12 s alerts, +2 and dnf, focus mode while solving.' },
  { icon: BarChart3, t: 'csTimer-grade stats', d: 'mo3, ao5 … ao1000 with wca trimming, session bests, trend and histogram charts.' },
  { icon: Upload, t: 'sessions & import', d: 'unlimited sessions for all 16 wca events, import from csTimer and every timer it reads, json and csTimer export.' },
  { icon: CalendarCheck, t: 'daily challenge', d: 'five shared scrambles a day for everyone, ranked by ao5 on a global board.' },
  { icon: Swords, t: 'live races', d: 'real-time multiplayer rooms over websockets — share a link and race any event.' },
  { icon: Crown, t: 'leaderboards', d: 'all-time, weekly and daily boards for every event, single, ao5 and ao12.' },
  { icon: Globe, t: 'wca comparison', d: 'see where your personal bests would rank among every official wca competitor.' },
  { icon: Palette, t: 'themes & command line', d: `${THEMES.length} themes — monkeytype classics plus cube-inspired originals — with live preview. press esc and type — everything is a command.` },
  { icon: WifiOff, t: 'offline first', d: 'guest mode works with no backend at all; sign in to sync solves to the cloud.' },
];

const STACK: [string, string][] = [
  ['frontend', 'react 18 · typescript · vite · chart.js · cubing.js'],
  ['services', 'node.js 22 · fastify 5 · zod · socket.io + redis adapter'],
  ['data', 'postgresql 17 (cloudnativepg) · redis 7 streams'],
  ['platform', 'google kubernetes engine · ingress · hpa · kustomize · artifact registry'],
  ['patterns', 'transactional outbox · event-driven read models · consumer groups · cache-aside'],
];

const KEYS: [string[], string][] = [
  [['esc'], 'command line (or ctrl + k)'],
  [['space'], 'hold, release to start · press to stop'],
  [['tab'], 'new scramble'],
  [['alt', '1'], 'mark the last solve ok'],
  [['alt', '2'], 'add a +2 to the last solve'],
  [['alt', '3'], 'mark the last solve dnf'],
  [['alt', 'backspace'], 'delete the last solve'],
  [['←', '→'], 'flip leaderboard pages'],
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
    <section aria-label="live stats">
      <div className="ab-counters">
        <Counter label="cubers" value={d ? d.users : null} />
        <Counter label="solves" value={d ? d.solves : null} />
        <Counter label="hours cubed" value={hours} decimals={hours !== null && hours < 100 ? 1 : 0} />
        <Counter label="solves today" value={d ? d.solvesToday : null} hint={d ? `by ${formatNumber(d.activeUsersToday)} cubers` : undefined} />
      </div>
      {stats.error && !d && (
        <div className="ab-counters-note" style={{ marginTop: '1rem' }}>
          {friendlyError(stats.error, 'the stats service')} — the counters come back on their own.{' '}
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
      {meta.data ? ` as of ${formatDate(meta.data.exportDate)}` : ''}. cubetype is not affiliated with the WCA.
    </div>
  );
}

function FlowSwatch({ main }: { main?: boolean }) {
  return (
    <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true">
      <line
        x1="1"
        y1="4"
        x2="25"
        y2="4"
        style={{ stroke: main ? 'var(--main-color)' : 'var(--sub-color)' }}
        strokeWidth={main ? 2.5 : 1.5}
        strokeDasharray={main ? '7 6' : undefined}
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function AboutPage() {
  useEffect(() => {
    document.title = 'about | cubetype';
    return () => {
      document.title = 'cubetype';
    };
  }, []);

  return (
    <div className="ab">
      <section className="ab-hero">
        <h1 className="ab-logo">
          <CubeLogo /> cubetype
        </h1>
        <p className="ab-lead">
          a minimal, keyboard-first speedcubing timer — <span className="text">csTimer</span>&apos;s depth with <span className="text">monkeytype</span>
          &apos;s polish, running as cloud-native microservices on kubernetes.
        </p>
      </section>

      <GlobalCounters />

      <section aria-labelledby="ab-features">
        <h2 className="ab-h" id="ab-features">
          <Layers /> features
        </h2>
        <div className="ab-features">
          {FEATURES.map(({ icon: Icon, t, d }) => (
            <div className="ab-feature" key={t}>
              <Icon aria-hidden="true" />
              <span className="t">{t}</span>
              <span className="d">{d}</span>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="ab-arch">
        <h2 className="ab-h" id="ab-arch">
          <Network /> architecture
        </h2>
        <p className="ab-p">
          the web app and seven microservices run as replicated deployments on google kubernetes engine behind a single cloud load balancer. services
          that keep relational data own a postgres schema; leaderboards and race rooms live in redis. they talk to each other over http or through a
          redis event stream — so a slow or crashed service only degrades its own feature. <span className="sub">try it: the timer keeps working with every backend down.</span>
        </p>
        <ArchitectureDiagram />
        <div className="arch-legend">
          <span>
            <FlowSwatch /> request path (ingress → services → data)
          </span>
          <span>
            <FlowSwatch main /> event flow over redis streams
          </span>
          <span>stacked boxes = 2+ replicas · hpa = horizontal pod autoscaler</span>
        </div>
        <div className="arch-steps">
          <div>
            <span className="text">solve-service</span> writes your solve and an outbox row in one postgres transaction, then relays it to the{' '}
            <span className="text">cubetype:events</span> stream.
          </div>
          <div>
            <span className="text">stats-service</span> consumes the stream (consumer group) and updates pbs, streaks, the heatmap and time-of-day read
            models.
          </div>
          <div>
            <span className="text">leaderboard-service</span> consumes the same events and updates redis sorted sets — boards can be rebuilt from stats
            at any time.
          </div>
        </div>
      </section>

      <div className="ab-two">
        <section aria-labelledby="ab-stack">
          <h2 className="ab-h" id="ab-stack">
            <Wrench /> tech stack
          </h2>
          <dl className="ab-dl">
            {STACK.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-labelledby="ab-keys">
          <h2 className="ab-h" id="ab-keys">
            <Keyboard /> keyboard shortcuts
          </h2>
          <div className="ab-keys">
            {KEYS.map(([keys, label]) => (
              <div key={label} style={{ display: 'contents' }}>
                <span className="k">
                  {keys.map((k, i) => (
                    <span key={k} style={{ display: 'contents' }}>
                      {i > 0 && (keys[0] === '←' ? ' ' : ' + ')}
                      <kbd>{k}</kbd>
                    </span>
                  ))}
                </span>
                <span className="v">{label}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section aria-labelledby="ab-credits">
        <h2 className="ab-h" id="ab-credits">
          <Heart /> credits
        </h2>
        <div className="ab-credits">
          <div className="ab-credit">
            <a href="https://cstimer.net" target="_blank" rel="noreferrer noopener">
              csTimer
            </a>
            <span className="d">by cs0x7f — the timer behaviour, statistics and export format cubers rely on.</span>
          </div>
          <div className="ab-credit">
            <a href="https://monkeytype.com" target="_blank" rel="noreferrer noopener">
              monkeytype
            </a>
            <span className="d">by miodec — the design language, themes and command line this app borrows.</span>
          </div>
          <div className="ab-credit">
            <a href="https://js.cubing.net/cubing/" target="_blank" rel="noreferrer noopener">
              cubing.js
            </a>
            <span className="d">by lucas garron &amp; tom rokicki — random-state scrambles and puzzle previews.</span>
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
