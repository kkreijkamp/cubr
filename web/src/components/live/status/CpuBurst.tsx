import { useEffect, useRef, useState } from 'react';
import { FlameIcon, LightningIcon, StopIcon } from '@phosphor-icons/react';
import { requestRaw } from '../../../lib/api';
import { useRegisterCommands } from '../../../lib/commands';
import { useStoredState } from '../hooks';
import { Segmented, Sparkline } from '../ui';
import { podParts } from './ServiceCard';

const DURATIONS = [30, 60, 120] as const;
const EVENT = '444';
/** same request as api.scrambles.get('444', 5, true), via requestRaw to also read X-Served-By */
const PATH = `/api/scrambles/${EVENT}?count=5&fresh=1`;
const REQUEST_TIMEOUT_MS = 30_000;

interface Stats {
  startedAt: number;
  endsAt: number;
  concurrency: number;
  ok: number;
  errors: number;
  inFlight: number;
  latencies: number[];
  completions: number[];
  pods: Map<string, number>;
  podFirstSeen: Map<string, number>;
  lastError: string | null;
  rateHistory: number[];
  stoppedAt: number | null;
}

interface View {
  running: boolean;
  elapsed: number;
  duration: number;
  ok: number;
  errors: number;
  inFlight: number;
  rps: number;
  p50: number | null;
  p95: number | null;
  pods: { pod: string; count: number; fresh: boolean }[];
  rateHistory: number[];
  lastError: string | null;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function combine(stop: AbortSignal): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return anyFn ? anyFn([stop, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : stop;
}

function toView(s: Stats, now: number): View {
  const end = s.stoppedAt ?? now;
  const recent = s.completions.filter((t) => end - t <= 2000).length;
  const window = Math.min(2000, Math.max(250, end - s.startedAt));
  return {
    running: s.stoppedAt === null,
    elapsed: Math.min(end, s.endsAt) - s.startedAt,
    duration: s.endsAt - s.startedAt,
    ok: s.ok,
    errors: s.errors,
    inFlight: s.inFlight,
    rps: s.stoppedAt === null ? (recent / window) * 1000 : 0,
    p50: pct(s.latencies.slice(-200), 50),
    p95: pct(s.latencies.slice(-200), 95),
    pods: [...s.pods.entries()]
      .map(([pod, count]) => ({ pod, count, fresh: now - (s.podFirstSeen.get(pod) ?? 0) < 6000 && s.podFirstSeen.get(pod)! - s.startedAt > 3000 }))
      .sort((a, b) => b.count - a.count),
    rateHistory: s.rateHistory,
    lastError: s.lastError,
  };
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Drives the scramble HorizontalPodAutoscaler: M workers each request fresh (un-pooled) random-state
 * 4x4 scrambles back-to-back - CPU-heavy work - for 30/60/120 s.
 */
export function CpuBurst({ onLog }: { onLog: (text: string, service: string) => void }) {
  const [concurrency, setConcurrency] = useStoredState<number>('cubetype.status.burstC', 8);
  const [duration, setDuration] = useStoredState<number>('cubetype.status.burstD', 60);
  const [view, setView] = useState<View | null>(null);
  const stats = useRef<Stats | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  const finish = (reason: 'done' | 'stopped') => {
    const s = stats.current;
    if (!s || s.stoppedAt !== null) return;
    s.stoppedAt = Date.now();
    ctrl.current?.abort();
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
    setView(toView(s, Date.now()));
    const secs = (s.stoppedAt - s.startedAt) / 1000;
    onLog(
      `cpu burst ${reason === 'done' ? 'finished' : 'stopped'}: ${s.ok} scramble requests in ${secs.toFixed(0)}s (${(s.ok / Math.max(1, secs)).toFixed(1)}/s) - ${s.errors} errors - served by ${s.pods.size} pod${s.pods.size === 1 ? '' : 's'}`,
      'scramble',
    );
  };

  const start = () => {
    if (stats.current && stats.current.stoppedAt === null) return;
    const now = Date.now();
    const s: Stats = {
      startedAt: now,
      endsAt: now + duration * 1000,
      concurrency,
      ok: 0,
      errors: 0,
      inFlight: 0,
      latencies: [],
      completions: [],
      pods: new Map(),
      podFirstSeen: new Map(),
      lastError: null,
      rateHistory: [],
      stoppedAt: null,
    };
    stats.current = s;
    const c = new AbortController();
    ctrl.current = c;
    onLog(`cpu burst started: ${concurrency} parallel fresh ${EVENT} scramble requests for ${duration}s`, 'scramble');

    const worker = async () => {
      while (!c.signal.aborted && Date.now() < s.endsAt) {
        const t0 = performance.now();
        s.inFlight++;
        try {
          const res = await requestRaw<unknown>('GET', PATH, undefined, { signal: combine(c.signal) });
          if (c.signal.aborted) break;
          s.ok++;
          s.latencies.push(performance.now() - t0);
          if (s.latencies.length > 1000) s.latencies.splice(0, 500);
          const pod = res.servedBy ?? 'unknown';
          s.pods.set(pod, (s.pods.get(pod) ?? 0) + 1);
          if (!s.podFirstSeen.has(pod)) s.podFirstSeen.set(pod, Date.now());
        } catch (e) {
          if (c.signal.aborted) break;
          s.errors++;
          s.lastError = (e as Error).message;
          await sleep(300, c.signal); // don't spin on a dead service
        } finally {
          s.inFlight--;
          s.completions.push(Date.now());
          if (s.completions.length > 5000) s.completions.splice(0, 2500);
        }
      }
    };
    void Promise.all(Array.from({ length: concurrency }, worker)).then(() => finish('done'));

    let lastSample = now;
    ticker.current = setInterval(() => {
      const t = Date.now();
      if (t - lastSample >= 1000) {
        lastSample = t;
        const v = toView(s, t);
        s.rateHistory = [...s.rateHistory, v.rps].slice(-120);
      }
      setView(toView(s, t));
    }, 250);
    setView(toView(s, now));
  };

  // stop on unmount (leaving the page)
  useEffect(
    () => () => {
      ctrl.current?.abort();
      if (ticker.current) clearInterval(ticker.current);
    },
    [],
  );

  const running = view?.running ?? false;

  useRegisterCommands(
    'status-burst',
    () => [
      running
        ? { id: 'status-burst-stop', label: 'Stop CPU burst', icon: <StopIcon />, run: () => finish('stopped') }
        : { id: 'status-burst-start', label: 'Start CPU burst (scramble HPA)', icon: <FlameIcon />, keywords: ['load', 'hpa', 'autoscaler'], run: start },
    ],
    [running, concurrency, duration],
  );

  return (
    <section className="card status-panel burst" aria-labelledby="burst-title">
      <div className="live-section-title">
        <h3 className="h3" id="burst-title">
          <FlameIcon /> cpu burst
        </h3>
        <span className="meta" title={`GET ${PATH}`}>
          drives the scramble HPA
        </span>
      </div>
      <p className="panel-desc">
        workers request fresh random-state 4x4 scrambles back-to-back (<code>fresh=1</code> skips the pool: pure CPU). the scramble
        autoscaler should add pods within a minute - they show up here and in the scramble card.
      </p>
      <div className="panel-controls">
        <label className="burst-slider">
          <span className="label">concurrency</span>
          <input type="range" min={1} max={32} step={1} value={concurrency} disabled={running} onChange={(e) => setConcurrency(Number(e.target.value))} aria-label="concurrency" />
          <span className="value mono-nums">{concurrency}</span>
        </label>
        <div className="row wrap" style={{ gap: '0.5rem' }}>
          <Segmented label="duration" value={duration} onChange={setDuration} options={DURATIONS.map((d) => ({ value: d, label: `${d}s`, disabled: running }))} />
          {running ? (
            <button className="btn danger" onClick={() => finish('stopped')}>
              <StopIcon /> stop
            </button>
          ) : (
            <button className="btn primary" onClick={start}>
              <LightningIcon /> start burst
            </button>
          )}
        </div>
      </div>

      {!view ? (
        <div className="panel-empty">tip: run <code>kubectl -n cubetype get hpa scramble -w</code> next to this page.</div>
      ) : (
        <div className="burst-live">
          <div className={`burst-progress${running ? ' on' : ''}`} aria-hidden="true">
            <i style={{ width: `${Math.min(100, (view.elapsed / view.duration) * 100)}%` }} />
          </div>
          <div className="burst-progress-label mono-nums">
            <span>{running ? 'running' : 'finished'}</span>
            <span>
              {mmss(view.elapsed)} / {mmss(view.duration)}
            </span>
          </div>
          <div className="burst-stats">
            <div className="stat">
              <span className="label">req/s</span>
              <span className="value">{view.rps.toFixed(1)}</span>
            </div>
            <div className="stat">
              <span className="label">requests</span>
              <span className="value text">{view.ok.toLocaleString('en-US')}</span>
            </div>
            <div className="stat">
              <span className="label">errors</span>
              <span className={`value ${view.errors ? 'error' : 'text'}`}>{view.errors}</span>
            </div>
            <div className="stat">
              <span className="label">p50 / p95</span>
              <span className="value text">
                {view.p50 !== null ? `${Math.round(view.p50)}` : '-'}
                <small>/{view.p95 !== null ? `${Math.round(view.p95)}` : '-'} ms</small>
              </span>
            </div>
          </div>
          {view.rateHistory.length > 1 && <Sparkline values={view.rateHistory} height={34} className="burst-spark" />}
          {view.pods.length > 0 && (
            <div className="burst-pods">
              <span className="label">served by</span>
              {view.pods.map((p) => {
                const { id } = podParts(p.pod, 'scramble');
                return (
                  <span key={p.pod} className={`burst-pod${p.fresh ? ' fresh' : ''}`} title={p.pod}>
                    {id} <b>{p.count}</b>
                  </span>
                );
              })}
            </div>
          )}
          {view.lastError && view.errors > 0 && <div className="panel-foot error">last error: {view.lastError}</div>}
        </div>
      )}
    </section>
  );
}
