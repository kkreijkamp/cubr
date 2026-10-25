import { useRef, useState } from 'react';
import { IconPlayerPlay, IconSitemap } from '@tabler/icons-react';
import { api, SERVICE_INFO_PATHS } from '../../../lib/api';
import { useStoredState } from '../hooks';
import { Segmented } from '../ui';
import { podParts } from './ServiceCard';
import { vlabel } from './monitor';

interface PodCount {
  pod: string;
  version: string;
  count: number;
}
interface LbResult {
  service: string;
  n: number;
  done: number;
  errors: number;
  pods: PodCount[];
  latencies: number[];
  startedAt: number;
  durationMs: number | null;
  lastError: string | null;
}

const SIZES = [10, 50, 100] as const;

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/**
 * Fires N parallel requests at one service's `_info` and charts which pod answered each one -
 * the Kubernetes Service / Ingress spreading traffic over the replicas.
 */
export function LoadBalanceTest({ vc, onLog }: { vc: (v: string) => string; onLog: (text: string, service: string) => void }) {
  const [service, setService] = useStoredState<string>('cubetype.status.lbService', 'solve');
  const [n, setN] = useStoredState<number>('cubetype.status.lbN', 50);
  const [result, setResult] = useState<LbResult | null>(null);
  const running = result !== null && result.durationMs === null;
  const runId = useRef(0);

  const run = async () => {
    const target = SERVICE_INFO_PATHS.find((s) => s.name === service) ?? SERVICE_INFO_PATHS[0];
    const id = ++runId.current;
    const startedAt = performance.now();
    const acc: LbResult = { service: target.name, n, done: 0, errors: 0, pods: [], latencies: [], startedAt, durationMs: null, lastError: null };
    setResult({ ...acc });
    let scheduled = false;
    const flush = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (runId.current === id) setResult({ ...acc, pods: acc.pods.map((p) => ({ ...p })) });
      });
    };
    await Promise.all(
      Array.from({ length: n }, () =>
        api
          .info(target.path, 8000)
          .then((res) => {
            const pod = (typeof res.data?.pod === 'string' && res.data.pod) || res.servedBy || 'unknown';
            const version = (typeof res.data?.version === 'string' && res.data.version) || '?';
            const row = acc.pods.find((p) => p.pod === pod);
            if (row) row.count++;
            else acc.pods.push({ pod, version, count: 1 });
            acc.latencies.push(res.ms);
          })
          .catch((e: Error) => {
            acc.errors++;
            acc.lastError = e.message;
          })
          .finally(() => {
            acc.done++;
            flush();
          }),
      ),
    );
    if (runId.current !== id) return;
    acc.durationMs = performance.now() - startedAt;
    setResult({ ...acc, pods: acc.pods.map((p) => ({ ...p })) });
    const dist = [...acc.pods].sort((a, b) => b.count - a.count).map((p) => p.count).join('/');
    onLog(
      `load test: ${n} requests -> ${acc.pods.length} pod${acc.pods.length === 1 ? '' : 's'}${acc.pods.length ? ` (${dist})` : ''}${acc.errors ? ` - ${acc.errors} errors` : ''}`,
      target.name,
    );
  };

  const pods = result ? [...result.pods].sort((a, b) => b.count - a.count || a.pod.localeCompare(b.pod)) : [];
  const max = Math.max(1, ...pods.map((p) => p.count), result?.errors ?? 0);
  const p50 = result ? percentile(result.latencies, 50) : null;
  const ideal = result && pods.length ? result.done - result.errors : 0;

  return (
    <section className="card status-panel" aria-labelledby="lb-title">
      <div className="live-section-title">
        <h3 className="h3" id="lb-title">
          <IconSitemap /> load balancing test
        </h3>
        <span className="meta">parallel GET .../_info</span>
      </div>
      <p className="panel-desc">
        fires N requests at once and counts which pod answered each one (from <code>_info.pod</code> / <code>X-Served-By</code>).
      </p>
      <div className="panel-controls">
        <Segmented label="service" value={service} onChange={setService} options={SERVICE_INFO_PATHS.map((s) => ({ value: s.name, label: s.name }))} />
        <div className="row wrap" style={{ gap: '0.5rem' }}>
          <Segmented label="requests" value={n} onChange={setN} options={SIZES.map((v) => ({ value: v, label: `${v}x` }))} />
          <button className="btn primary" onClick={() => void run()} disabled={running}>
            <IconPlayerPlay /> {running ? 'firing...' : 'fire'}
          </button>
        </div>
      </div>

      {!result ? (
        <div className="panel-empty">pick a service and fire - with 2+ replicas the bars should come out roughly even.</div>
      ) : (
        <div className="lb-result">
          <div className="lb-summary mono-nums">
            <span>
              <b>{result.done}</b>/{result.n} done
            </span>
            <span>
              <b>{pods.length}</b> pod{pods.length === 1 ? '' : 's'}
            </span>
            <span className={result.errors ? 'error' : ''}>
              <b>{result.errors}</b> errors
            </span>
            <span>
              p50 <b>{p50 !== null ? `${Math.round(p50)}ms` : '-'}</b>
            </span>
            <span>
              total <b>{result.durationMs !== null ? `${Math.round(result.durationMs)}ms` : '...'}</b>
            </span>
          </div>
          <ul className="lb-bars">
            {pods.map((p) => {
              const { hash, id } = podParts(p.pod, result.service);
              const share = ideal ? (p.count / ideal) * 100 : 0;
              return (
                <li key={p.pod} className={vc(p.version)} title={`${p.pod} - ${vlabel(p.version)}`}>
                  <span className="vsq" aria-hidden="true" />
                  <span className="pod-name">
                    <span className="hash">{hash}</span>
                    <span className="id">{id}</span>
                  </span>
                  <span className="bar" aria-hidden="true">
                    <i style={{ width: `${(p.count / max) * 100}%` }} />
                  </span>
                  <span className="num">{p.count}</span>
                  <span className="pct">{share.toFixed(0)}%</span>
                </li>
              );
            })}
            {result.errors > 0 && (
              <li className="err" title={result.lastError ?? undefined}>
                <span className="vsq" aria-hidden="true" />
                <span className="pod-name">errors</span>
                <span className="bar" aria-hidden="true">
                  <i style={{ width: `${(result.errors / max) * 100}%` }} />
                </span>
                <span className="num">{result.errors}</span>
                <span className="pct">{((result.errors / result.n) * 100).toFixed(0)}%</span>
              </li>
            )}
          </ul>
          {result.durationMs !== null && pods.length > 1 && (
            <div className="panel-foot">
              ideal {(ideal / pods.length).toFixed(1)} per pod - spread {Math.min(...pods.map((p) => p.count))}-{Math.max(...pods.map((p) => p.count))}
            </div>
          )}
          {result.durationMs !== null && pods.length === 1 && result.errors === 0 && (
            <div className="panel-foot">only one pod answered - is the deployment scaled to 1 replica?</div>
          )}
        </div>
      )}
    </section>
  );
}
