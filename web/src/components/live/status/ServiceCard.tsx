import { memo } from 'react';
import { formatDuration } from '@cubr/cubestats';
import { Dot, Sparkline } from '../ui';
import { vlabel, type PodView, type ServiceView } from './monitor';

const STANDARD_KEYS = new Set(['service', 'version', 'pod', 'node', 'startedAt', 'uptimeSec', 'deps']);

const humanKey = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/** A few service-specific numbers from `_info` (race sockets, solve outbox backlog, ...). */
function extras(info: Record<string, unknown> | null): { label: string; value: string }[] {
  if (!info) return [];
  const out: { label: string; value: string }[] = [];
  const push = (label: string, v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ label, value: v.toLocaleString('en-US') });
    else if (typeof v === 'boolean') out.push({ label, value: v ? 'yes' : 'no' });
    else if (typeof v === 'string' && v.length <= 24) out.push({ label, value: v });
  };
  for (const [k, v] of Object.entries(info)) {
    if (STANDARD_KEYS.has(k) || v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (typeof v2 === 'number') push(`${humanKey(k)} ${humanKey(k2)}`, v2);
        if (out.length >= 3) break;
      }
    } else push(humanKey(k), v);
    if (out.length >= 3) break;
  }
  return out.slice(0, 3);
}

function latencyClass(ms: number | null): string {
  if (ms === null) return '';
  if (ms >= 1500) return 'slow2';
  if (ms >= 400) return 'slow1';
  return '';
}

/** "solve-7d9f8c6b5-x2k4q" -> ["solve-", "7d9f8c6b5-", "x2k4q"] (deployment, replicaset hash, pod id) */
export function podParts(pod: string, service: string): { prefix: string; hash: string; id: string } {
  const rest = pod.startsWith(`${service}-`) ? pod.slice(service.length + 1) : pod;
  const prefix = rest === pod ? '' : `${service}-`;
  const parts = rest.split('-');
  if (parts.length >= 2) return { prefix, hash: `${parts.slice(0, -1).join('-')}-`, id: parts[parts.length - 1] };
  return { prefix, hash: '', id: rest };
}

export function shortNode(node: string): string {
  const parts = node.split('-');
  return parts.length > 2 ? parts[parts.length - 1] : node;
}

function PodRow({ p, max, serving, vc }: { p: PodView; max: number; serving: boolean; vc: string }) {
  const { hash, id } = podParts(p.pod, p.service);
  const ago = Math.max(0, Math.round((Date.now() - p.lastSeen) / 1000));
  const tip = `${p.pod}\n${vlabel(p.version)} - node ${p.node}\n${p.hits} hit${p.hits === 1 ? '' : 's'} in 30s - last ${ago}s ago`;
  return (
    <li className={`pod-row ${vc}${p.fresh ? ' fresh' : ''}${p.stale ? ' stale' : ''}${serving ? ' serving' : ''}`} title={tip}>
      <span className="vsq" aria-hidden="true" />
      <span className="pod-name">
        <span className="hash">{hash}</span>
        <span className="id">{id}</span>
        {p.fresh && <span className="tag new">new</span>}
        {p.stale && <span className="tag">gone?</span>}
      </span>
      <span className="pod-node">{shortNode(p.node)}</span>
      <span className="pod-bar" aria-hidden="true">
        <i style={{ width: `${max ? (p.hits / max) * 100 : 0}%` }} />
      </span>
      <span className="pod-hits">{p.hits}</span>
    </li>
  );
}

function ServiceCardImpl({ s, vc, now }: { s: ServiceView; vc: (v: string) => string; now: number }) {
  const info = s.info;
  const version = typeof info?.version === 'string' ? info.version : null;
  const down = s.status === 'down';
  const deps = info?.deps && typeof info.deps === 'object' ? Object.entries(info.deps) : [];
  const uptime = typeof info?.uptimeSec === 'number' ? formatDuration(info.uptimeSec * 1000) : '-';
  const node = typeof info?.node === 'string' ? info.node : '-';
  const max = Math.max(1, ...s.pods.map((p) => p.hits));
  const ex = extras(info as Record<string, unknown> | null);
  const podsLive = s.pods.filter((p) => !p.stale).length;
  const statusLabel = { pending: 'checking...', up: 'healthy', degraded: 'degraded', down: 'down' }[s.status];

  return (
    <article className={`svc-card ${s.status}`} aria-label={`${s.name} ${statusLabel}`}>
      <header className="svc-head">
        <Dot state={s.status} pulse={s.status === 'up'} title={statusLabel} />
        <span className="svc-name">{s.name}</span>
        {version && <span className={`ver-chip ${vc(version)}`}>{vlabel(version)}</span>}
        <span className={`svc-lat ${latencyClass(s.latency)}`} title="latency of the last _info request">
          {s.latency !== null ? `${Math.round(s.latency)}ms` : down ? 'no reply' : '...'}
        </span>
      </header>

      <Sparkline values={s.latencies} className={down ? 'down' : ''} />

      {down ? (
        <div className="svc-down">
          <div className="reason">
            {s.httpStatus ? `${s.httpStatus} - ` : ''}
            {s.error ?? 'unreachable'}
          </div>
          <div className="sub">
            {s.downSince !== null && <>down for {formatDuration(Math.max(0, now - s.downSince))}</>}
            {s.lastOkAt !== null ? ` - last ok ${new Date(s.lastOkAt).toLocaleTimeString()}` : ' - never reached'}
          </div>
        </div>
      ) : (
        <dl className="svc-meta">
          <div>
            <dt>uptime</dt>
            <dd>{uptime}</dd>
          </div>
          <div>
            <dt>node</dt>
            <dd title={node}>{shortNode(node)}</dd>
          </div>
          <div className="wide">
            <dt>deps</dt>
            <dd className="deps">
              {deps.length === 0 ? (
                <span className="sub">{s.name === 'web' ? 'static - nginx' : '-'}</span>
              ) : (
                deps.map(([k, v]) => (
                  <span key={k} className={`dep ${v === 'ok' ? 'ok' : 'bad'}`}>
                    <Dot state={v === 'ok' ? 'up' : 'down'} /> {k}
                  </span>
                ))
              )}
            </dd>
          </div>
        </dl>
      )}

      <div className="svc-pods">
        <div className="svc-pods-title">
          <span>pods - last 30s</span>
          <span className="count">{podsLive}</span>
        </div>
        {s.pods.length === 0 ? (
          <div className="svc-pods-empty">{s.status === 'pending' ? 'waiting for the first reply...' : 'no pod answered'}</div>
        ) : (
          <ul>
            {s.pods.map((p) => (
              <PodRow key={p.key} p={p} max={max} serving={!down && p.pod === s.servedBy} vc={vc(p.version)} />
            ))}
          </ul>
        )}
      </div>

      {ex.length > 0 && !down && (
        <div className="svc-extra">
          {ex.map((e) => (
            <span key={e.label}>
              {e.label} <b>{e.value}</b>
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

export const ServiceCard = memo(ServiceCardImpl);
