// Cluster status - the live Kubernetes demo page. Polls every microservice's `_info` endpoint once
// a second and visualises load balancing (pods answering), scaling (new pods), self-healing (pods
// replaced, outages + recovery) and rolling updates (versions changing colour).
import { useEffect, useMemo, useState } from 'react';
import { CheckIcon, CommandLineIcon, PauseIcon, PlayIcon, SignalIcon } from '@heroicons/react/24/outline';
import { useStore } from '../lib/store';
import { useRegisterCommands } from '../lib/commands';
import { usePageVisible, copyText } from '../components/live/hooks';
import { Dot } from '../components/live/ui';
import { ClusterMonitor, vlabel, type ServiceView } from '../components/live/status/monitor';
import { versionColors } from '../components/live/status/versions';
import { ServiceCard } from '../components/live/status/ServiceCard';
import { LoadBalanceTest } from '../components/live/status/LoadBalanceTest';
import { CpuBurst } from '../components/live/status/CpuBurst';
import { EventLog } from '../components/live/status/EventLog';
import { NodeMap } from '../components/live/status/NodeMap';
import '../components/live/live.css';
import '../components/live/status/status.css';

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function Cheatsheet({ services }: { services: ServiceView[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const solvePod = services.find((s) => s.name === 'solve')?.pods.find((p) => !p.stale)?.pod ?? '<solve-pod>';
  const rows: [string, string][] = [
    ['watch pods', 'kubectl -n cubr get pods -o wide -w'],
    ['scale out', 'kubectl -n cubr scale deploy/stats --replicas=4'],
    ['self-healing', `kubectl -n cubr delete pod ${solvePod}`],
    ['rolling update', 'kubectl -n cubr rollout restart deploy/web'],
    ['rollout status', 'kubectl -n cubr rollout status deploy/web'],
    ['autoscaler', 'kubectl -n cubr get hpa -w'],
  ];
  return (
    <div className="card cheatsheet">
      {rows.map(([label, cmd]) => (
        <button
          key={label}
          className="cheat-row"
          onClick={async () => {
            if (await copyText(cmd)) {
              setCopied(cmd);
              setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1200);
            }
          }}
          title="click to copy"
        >
          <span className="label">{label}</span>
          <code>{cmd}</code>
          <span className="copied">{copied === cmd ? <CheckIcon width={14} height={14} /> : null}</span>
        </button>
      ))}
    </div>
  );
}

export default function StatusPage() {
  const [monitor] = useState(() => new ClusterMonitor());
  const state = useStore(monitor.store);
  const visible = usePageVisible();
  const [userPaused, setUserPaused] = useState(false);
  const [showCheats, setShowCheats] = useState(false);

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
        icon: userPaused ? <PlayIcon /> : <PauseIcon />,
        run: () => setUserPaused((p) => !p),
      },
      { id: 'status-cheats', label: 'Toggle kubectl cheatsheet', icon: <CommandLineIcon />, run: () => setShowCheats((v) => !v) },
    ],
    [userPaused],
  );

  const { services, log, now } = state;
  const { cls: vc, legend } = useMemo(() => versionColors(services), [services]);
  const healthy = services.filter((s) => s.status === 'up').length;
  const degraded = services.filter((s) => s.status === 'degraded').length;
  const down = services.filter((s) => s.status === 'down').length;
  const pending = services.filter((s) => s.status === 'pending').length;
  const livePods = services.flatMap((s) => s.pods.filter((p) => !p.stale));
  const nodes = new Set(livePods.map((p) => p.node));
  const lat = median(services.map((s) => s.latency).filter((v): v is number => v !== null));
  const rolling = services.filter((s) => s.versions.length > 1);
  const allHealthy = healthy === services.length;
  const onLog = (text: string, service: string) => monitor.addLog('sub', text, service);

  return (
    <div className="stack lg status-page live-page">
      <div className="live-head">
        <div className="titles">
          <h1 className="h2">
            <SignalIcon /> cluster status
          </h1>
          <div className="subtitle">
            live view of the kubernetes deployment - every number below comes from a real request to a service's <code>_info</code> endpoint.
          </div>
        </div>
        <div className="tools">
          <span className={`live-indicator${state.running ? ' on' : ''}`}>
            <Dot state={state.running ? 'up' : 'pending'} pulse={state.running} />
            {state.running ? 'live - 1s' : state.pausedReason === 'hidden' ? 'paused (tab hidden)' : 'paused'}
          </span>
          <button className="btn small" onClick={() => setUserPaused((p) => !p)} aria-label={userPaused ? 'resume polling' : 'pause polling'}>
            {userPaused ? <PlayIcon /> : <PauseIcon />} {userPaused ? 'resume' : 'pause'}
          </button>
          <button className={`btn small${showCheats ? ' active' : ''}`} onClick={() => setShowCheats((v) => !v)} aria-expanded={showCheats}>
            <CommandLineIcon /> kubectl
          </button>
        </div>
      </div>

      {showCheats && <Cheatsheet services={services} />}

      <section className="card status-summary" aria-label="summary">
        <div className="stat">
          <span className="label">healthy services</span>
          <span className={`value ${down ? 'error' : allHealthy ? '' : 'text'}`}>
            {healthy}
            <small>/{services.length}</small>
          </span>
          <span className="hint">
            {pending
              ? `checking ${pending}...`
              : allHealthy
                ? 'all services healthy'
                : [down && `${down} down`, degraded && `${degraded} degraded`].filter(Boolean).join(' - ')}
          </span>
        </div>
        <div className="stat">
          <span className="label">pods seen - 30s</span>
          <span className="value">{livePods.length}</span>
          <span className="hint">
            on {nodes.size} node{nodes.size === 1 ? '' : 's'}
          </span>
        </div>
        <div className="stat">
          <span className="label">median latency</span>
          <span className="value text">
            {lat !== null ? Math.round(lat) : '-'}
            <small>ms</small>
          </span>
          <span className="hint" title="one request per live pod per service, every second">
            {services.reduce((a, s) => a + (state.running ? s.probes : 0), 0)} requests / s
          </span>
        </div>
        <div className="stat versions">
          <span className="label">versions in flight</span>
          <div className="legend">
            {legend.length === 0 && <span className="sub">-</span>}
            {legend.map((l) => (
              <span key={l.version} className={`legend-item ${l.cls}`} title={l.services.join(', ')}>
                <span className="vsq" aria-hidden="true" />
                {vlabel(l.version)}
                <span className="sub">
                  {' '}
                  {l.pods} pod{l.pods === 1 ? '' : 's'}
                </span>
              </span>
            ))}
          </div>
          <span className="hint rollouts">
            {rolling.length > 0
              ? rolling.map((s) => (
                  <span key={s.name} className="rolling">
                    {s.name}: {s.versions.map(vlabel).join(' -> ')} rolling...
                  </span>
                ))
              : legend.length === 1
                ? `all services on ${vlabel(legend[0].version)}`
                : legend.length > 1
                  ? 'services run different versions'
                  : 'waiting for replies'}
          </span>
        </div>
      </section>

      <div className="svc-grid">
        {services.map((s) => (
          <ServiceCard key={s.name} s={s} vc={vc} now={now} />
        ))}
      </div>

      <div className="status-panels">
        <CpuBurst onLog={onLog} />
        <LoadBalanceTest vc={vc} onLog={onLog} />
      </div>

      <div className="status-panels">
        <EventLog log={log} />
        <NodeMap services={services} vc={vc} />
      </div>
    </div>
  );
}
