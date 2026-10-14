// Cluster status — the live Kubernetes demo page. Polls every microservice's `_info` endpoint once
// a second and visualises load balancing (pods answering), scaling (new pods) and self-healing (pods
// replaced, outages + recovery).
import { useEffect, useState } from 'react';
import { Activity, Pause, Play } from 'lucide-react';
import { useStore } from '../lib/store';
import { useRegisterCommands } from '../lib/commands';
import { usePageVisible } from '../components/live/hooks';
import { Dot } from '../components/live/ui';
import { ClusterMonitor } from '../components/live/status/monitor';
import { ServiceCard } from '../components/live/status/ServiceCard';
import { LoadBalanceTest } from '../components/live/status/LoadBalanceTest';
import { CpuBurst } from '../components/live/status/CpuBurst';
import '../components/live/live.css';
import '../components/live/status/status.css';

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export default function StatusPage() {
  const [monitor] = useState(() => new ClusterMonitor());
  const state = useStore(monitor.store);
  const visible = usePageVisible();
  const [userPaused, setUserPaused] = useState(false);

  useEffect(() => {
    monitor.start();
    return () => monitor.dispose();
  }, [monitor]);
  useEffect(() => monitor.setHidden(!visible), [monitor, visible]);
  useEffect(() => monitor.setUserPaused(userPaused), [monitor, userPaused]);

  useRegisterCommands(
    'status',
    () => [
      {
        id: 'status-pause',
        label: userPaused ? 'Resume status polling' : 'Pause status polling',
        icon: userPaused ? <Play /> : <Pause />,
        run: () => setUserPaused((p) => !p),
      },
    ],
    [userPaused],
  );

  const { services, now } = state;
  const healthy = services.filter((s) => s.status === 'up').length;
  const degraded = services.filter((s) => s.status === 'degraded').length;
  const down = services.filter((s) => s.status === 'down').length;
  const pending = services.filter((s) => s.status === 'pending').length;
  const livePods = services.flatMap((s) => s.pods.filter((p) => !p.stale));
  const nodes = new Set(livePods.map((p) => p.node));
  const lat = median(services.map((s) => s.latency).filter((v): v is number => v !== null));
  const allHealthy = healthy === services.length;

  return (
    <div className="stack lg status-page live-page">
      <div className="live-head">
        <div className="titles">
          <h1 className="h2">
            <Activity /> cluster status
          </h1>
          <div className="subtitle">
            live view of the kubernetes deployment — every number below comes from a real request to a service's <code>_info</code> endpoint.
          </div>
        </div>
        <div className="tools">
          <span className={`live-indicator${state.running ? ' on' : ''}`}>
            <Dot state={state.running ? 'up' : 'pending'} pulse={state.running} />
            {state.running ? 'live · 1s' : state.pausedReason === 'hidden' ? 'paused (tab hidden)' : 'paused'}
          </span>
          <button className="btn small" onClick={() => setUserPaused((p) => !p)} aria-label={userPaused ? 'resume polling' : 'pause polling'}>
            {userPaused ? <Play /> : <Pause />} {userPaused ? 'resume' : 'pause'}
          </button>
        </div>
      </div>

      <section className="card status-summary" aria-label="summary">
        <div className="stat">
          <span className="label">healthy services</span>
          <span className={`value ${down ? 'error' : allHealthy ? '' : 'text'}`}>
            {healthy}
            <small>/{services.length}</small>
          </span>
          <span className="hint">
            {pending
              ? `checking ${pending}…`
              : allHealthy
                ? 'all services healthy'
                : [down && `${down} down`, degraded && `${degraded} degraded`].filter(Boolean).join(' · ')}
          </span>
        </div>
        <div className="stat">
          <span className="label">pods seen · 30s</span>
          <span className="value">{livePods.length}</span>
          <span className="hint">
            on {nodes.size} node{nodes.size === 1 ? '' : 's'}
          </span>
        </div>
        <div className="stat">
          <span className="label">median latency</span>
          <span className="value text">
            {lat !== null ? Math.round(lat) : '–'}
            <small>ms</small>
          </span>
          <span className="hint" title="one request per live pod per service, every second">
            {services.reduce((a, s) => a + (state.running ? s.probes : 0), 0)} requests / s
          </span>
        </div>
      </section>

      <div className="svc-grid">
        {services.map((s) => (
          <ServiceCard key={s.name} s={s} now={now} />
        ))}
      </div>

      <div className="status-panels">
        <CpuBurst />
        <LoadBalanceTest />
      </div>
    </div>
  );
}
