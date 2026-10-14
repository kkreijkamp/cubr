// Cluster monitor for the status page. Polls every service's `_info` endpoint once a second and
// turns the responses into what Kubernetes is doing: which pods answer (load balancing), new pods
// (scale-out / self-healing), pods that stop answering (deletions, scale-in) and service outages.
import { api, ApiError, SERVICE_INFO_PATHS } from '../../../lib/api';
import { createStore, type Store } from '../../../lib/store';
import type { ServiceInfo } from '../../../lib/types';

export const WINDOW_MS = 30_000;
export const POLL_MS = 1000;
const WARMUP_MS = 8000;
const HISTORY = 60;
const TIMEOUT_MS = 2500;
const MAX_PROBES = 6;
/**
 * A pod that has not answered for this long looks gone. Each pod gets ~probes/livePods hits per
 * second; 12 expected hits without one is a ~1e-5 fluke under random load balancing.
 */
const staleAfter = (livePods: number) => {
  const perPodRate = Math.min(MAX_PROBES, Math.max(1, livePods)) / Math.max(1, livePods);
  return Math.min(25_000, Math.max(8000, (12 / perPodRate) * POLL_MS));
};

export type ServiceStatus = 'pending' | 'up' | 'degraded' | 'down';

interface Hit {
  t: number;
  pod: string;
}
interface PodMeta {
  service: string;
  pod: string;
  node: string;
  version: string;
  firstSeen: number;
  lastSeen: number;
  /** discovered while warming up (no "new pod" highlight) */
  initial: boolean;
  stale: boolean;
}
interface Runtime {
  name: string;
  path: string;
  status: ServiceStatus;
  info: ServiceInfo | null;
  servedBy: string | null;
  latency: number | null;
  latencies: (number | null)[];
  error: string | null;
  httpStatus: number | null;
  lastOkAt: number | null;
  downSince: number | null;
  consecutiveFailures: number;
  hits: Hit[];
  inFlight: boolean;
  checks: number;
  failures: number;
  partialErrors: number;
  /** requests in the last probe batch */
  probes: number;
  /** consecutive batches disagreeing with the current up/degraded status */
  statusStreak: number;
}

export interface PodView {
  key: string;
  service: string;
  pod: string;
  node: string;
  version: string;
  hits: number;
  firstSeen: number;
  lastSeen: number;
  /** appeared after warm-up within the last few seconds → glow */
  fresh: boolean;
  stale: boolean;
}
export interface ServiceView {
  name: string;
  path: string;
  status: ServiceStatus;
  info: ServiceInfo | null;
  servedBy: string | null;
  latency: number | null;
  latencies: (number | null)[];
  error: string | null;
  httpStatus: number | null;
  lastOkAt: number | null;
  downSince: number | null;
  pods: PodView[];
  checks: number;
  failures: number;
  /** failed requests while other pods of the service answered */
  partialErrors: number;
  probes: number;
}
export interface MonitorState {
  services: ServiceView[];
  running: boolean;
  /** why polling is paused */
  pausedReason: 'user' | 'hidden' | null;
  warm: boolean;
  now: number;
}

/** "1.2.0" → "v1.2.0"; non-semver builds ("dev", git shas) stay as they are */
export const vlabel = (v: string) => (/^\d/.test(v) ? `v${v}` : v);

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v : fallback);

function describeError(e: unknown): { message: string; status: number | null } {
  if (e instanceof ApiError) {
    if (e.status === 0) return { message: 'unreachable', status: null };
    return { message: e.message || `HTTP ${e.status}`, status: e.status };
  }
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return { message: `timeout (${TIMEOUT_MS / 1000}s)`, status: null };
  return { message: e instanceof Error ? e.message : 'request failed', status: null };
}

export function shortPod(pod: string): string {
  // "solve-7d9f8c6b5-x2k4q" → "x2k4q"; docker hostnames (12 hex chars) stay as-is
  const parts = pod.split('-');
  return parts.length >= 3 ? parts[parts.length - 1] : pod;
}

export class ClusterMonitor {
  readonly store: Store<MonitorState>;
  private rts: Runtime[];
  private pods = new Map<string, PodMeta>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private warmUntil = 0;
  private pausedAt: number | null = null;
  private userPaused = false;
  private hidden = false;
  private disposed = false;
  private started = false;

  constructor(
    private fetchInfo: (path: string, timeoutMs: number) => ReturnType<typeof api.info> = api.info,
    services = SERVICE_INFO_PATHS,
  ) {
    this.rts = services.map((s) => ({
      name: s.name,
      path: s.path,
      status: 'pending',
      info: null,
      servedBy: null,
      latency: null,
      latencies: [],
      error: null,
      httpStatus: null,
      lastOkAt: null,
      downSince: null,
      consecutiveFailures: 0,
      hits: [],
      inFlight: false,
      checks: 0,
      failures: 0,
      partialErrors: 0,
      probes: 1,
      statusStreak: 0,
    }));
    this.store = createStore<MonitorState>(this.buildState(Date.now()));
  }

  /** Starts polling (safe to call again after dispose — React StrictMode remounts). */
  start(): void {
    this.disposed = false;
    if (!this.started) {
      this.started = true;
      this.warmUntil = Date.now() + WARMUP_MS;
    }
    this.applyRunning();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.timer = null;
    this.publishTimer = null;
  }

  setUserPaused(paused: boolean): void {
    if (this.userPaused === paused) return;
    this.userPaused = paused;
    this.applyRunning();
  }

  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.applyRunning();
  }

  /** Poll everything right now (e.g. after resuming). */
  refresh(): void {
    this.tick();
  }

  private applyRunning(): void {
    const shouldRun = !this.userPaused && !this.hidden && !this.disposed;
    if (shouldRun && !this.timer) this.resumeLoop();
    else if (!shouldRun && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.pausedAt = Date.now();
    }
    this.schedulePublish();
  }

  private resumeLoop(): void {
    if (this.pausedAt !== null) {
      // measure staleness in polling time: shift every timestamp by the pause length
      const shift = Date.now() - this.pausedAt;
      for (const p of this.pods.values()) {
        p.lastSeen += shift;
        p.firstSeen += shift;
      }
      for (const rt of this.rts) {
        rt.hits.forEach((h) => (h.t += shift));
        if (rt.downSince !== null) rt.downSince += shift;
      }
      this.pausedAt = null;
    }
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.tick();
  }

  private tick(): void {
    if (this.disposed) return;
    for (const rt of this.rts) if (!rt.inFlight) void this.poll(rt);
    this.maintain(Date.now());
    this.schedulePublish();
  }

  private livePods(service: string): number {
    let n = 0;
    for (const p of this.pods.values()) if (p.service === service && !p.stale) n++;
    return n;
  }

  /**
   * One probe batch per service per tick: as many parallel requests as the service has live pods
   * (capped), so every pod gets ~1 hit/s — new pods show up within a second or two and a pod
   * that stops answering can be flagged quickly without false alarms.
   */
  private async poll(rt: Runtime): Promise<void> {
    rt.inFlight = true;
    const k = Math.min(MAX_PROBES, Math.max(1, this.livePods(rt.name)));
    rt.probes = k;
    try {
      const settled = await Promise.allSettled(Array.from({ length: k }, () => this.fetchInfo(rt.path, TIMEOUT_MS)));
      if (this.disposed || !this.timer) return;
      const ok: Awaited<ReturnType<typeof api.info>>[] = [];
      const errors: unknown[] = [];
      for (const r of settled) {
        if (r.status === 'rejected') errors.push(r.reason);
        else if (!r.value.data || typeof r.value.data !== 'object') errors.push(new ApiError(r.value.status, 'INVALID', 'invalid _info response'));
        else ok.push(r.value);
      }
      if (ok.length === 0) {
        this.onFailure(rt, errors[0]);
        return;
      }
      for (const res of ok) this.onSuccess(rt, res.data, res.servedBy, res.headers.get('x-service'));
      this.updateStatus(rt, ok.map((r) => r.data));
      const ms = ok.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)];
      rt.latency = ms;
      rt.latencies = [...rt.latencies, ms].slice(-HISTORY);
      if (errors.length) {
        // some pods failed while others answered (e.g. a pod terminating without draining)
        rt.partialErrors += errors.length;
      }
    } finally {
      rt.inFlight = false;
      this.schedulePublish();
    }
  }

  private onSuccess(rt: Runtime, d: ServiceInfo, servedBy: string | null, xService: string | null): void {
    const now = Date.now();
    const warm = now >= this.warmUntil;
    const pod = str(d.pod, servedBy ?? 'unknown');
    const version = str(d.version, xService?.split('@')[1] ?? '?');
    const node = str(d.node, '?');
    rt.checks++;
    rt.consecutiveFailures = 0;
    rt.info = d;
    rt.servedBy = servedBy ?? pod;
    rt.error = null;
    rt.httpStatus = 200;
    rt.lastOkAt = now;
    rt.hits.push({ t: now, pod });

    // pods
    const key = `${rt.name}|${pod}`;
    const meta = this.pods.get(key);
    if (!meta) {
      this.pods.set(key, { service: rt.name, pod, node, version, firstSeen: now, lastSeen: now, initial: !warm, stale: false });
    } else {
      meta.stale = false;
      meta.lastSeen = now;
      meta.version = version;
      meta.node = node;
    }
  }

  /**
   * Up vs degraded from the whole probe batch (any pod reporting a dependency down = degraded).
   * Recovery from down is immediate; up ↔ degraded must persist for two batches, so one pod's
   * slow health check doesn't make the card flap.
   */
  private updateStatus(rt: Runtime, infos: ServiceInfo[]): void {
    const downDeps = new Set<string>();
    for (const d of infos) {
      const deps = d.deps && typeof d.deps === 'object' ? d.deps : {};
      for (const [k, v] of Object.entries(deps)) if (v !== 'ok') downDeps.add(k);
    }
    const next: ServiceStatus = downDeps.size ? 'degraded' : 'up';
    const prev = rt.status;
    if (prev === 'down' || prev === 'pending') {
      rt.status = next;
      rt.statusStreak = 0;
    } else if (next !== prev) {
      rt.statusStreak++;
      if (rt.statusStreak >= 2) {
        rt.status = next;
        rt.statusStreak = 0;
      }
    } else rt.statusStreak = 0;
    rt.downSince = null;
  }

  private onFailure(rt: Runtime, e: unknown): void {
    const now = Date.now();
    const { message, status } = describeError(e);
    rt.checks++;
    rt.failures++;
    rt.consecutiveFailures++;
    rt.error = message;
    rt.httpStatus = status;
    rt.latencies = [...rt.latencies, null].slice(-HISTORY);
    rt.latency = null;
    // one lost request is a blip; two in a row (or the very first check) is an outage
    if (rt.status !== 'down' && (rt.consecutiveFailures >= 2 || rt.status === 'pending')) {
      const wasKnown = rt.status !== 'pending';
      rt.status = 'down';
      rt.downSince = rt.lastOkAt && wasKnown ? Math.max(rt.lastOkAt, now - 2 * POLL_MS) : now;
    }
  }

  /** prune the window and detect pods that stopped answering */
  private maintain(now: number): void {
    for (const rt of this.rts) {
      rt.hits = rt.hits.filter((h) => now - h.t <= WINDOW_MS);
      const podCount = this.livePods(rt.name);
      for (const p of this.pods.values()) {
        if (p.service !== rt.name) continue;
        const silent = now - p.lastSeen;
        if (silent > WINDOW_MS) {
          this.pods.delete(`${p.service}|${p.pod}`);
          continue;
        }
        // only flag while the service itself answers (otherwise the outage explains it)
        if (!p.stale && silent > staleAfter(podCount) && rt.status !== 'down' && rt.status !== 'pending') {
          p.stale = true;
        }
      }
    }
  }

  private schedulePublish(): void {
    if (this.publishTimer || this.disposed) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.store.set(this.buildState(Date.now()));
    }, 40);
  }

  private buildState(now: number): MonitorState {
    const services: ServiceView[] = this.rts.map((rt) => {
      const counts = new Map<string, number>();
      for (const h of rt.hits) counts.set(h.pod, (counts.get(h.pod) ?? 0) + 1);
      const pods: PodView[] = [...this.pods.values()]
        .filter((p) => p.service === rt.name)
        .map((p) => ({
          key: `${p.service}|${p.pod}`,
          service: p.service,
          pod: p.pod,
          node: p.node,
          version: p.version,
          hits: counts.get(p.pod) ?? 0,
          firstSeen: p.firstSeen,
          lastSeen: p.lastSeen,
          fresh: !p.initial && now - p.firstSeen < 6000,
          stale: p.stale,
        }))
        .sort((a, b) => Number(a.stale) - Number(b.stale) || a.firstSeen - b.firstSeen || a.pod.localeCompare(b.pod));
      return {
        name: rt.name,
        path: rt.path,
        status: rt.status,
        info: rt.info,
        servedBy: rt.servedBy,
        latency: rt.latency,
        latencies: rt.latencies,
        error: rt.error,
        httpStatus: rt.httpStatus,
        lastOkAt: rt.lastOkAt,
        downSince: rt.downSince,
        pods,
        checks: rt.checks,
        failures: rt.failures,
        partialErrors: rt.partialErrors,
        probes: rt.probes,
      };
    });
    return {
      services,
      running: this.timer !== null,
      pausedReason: this.timer ? null : this.userPaused ? 'user' : this.hidden ? 'hidden' : null,
      warm: now >= this.warmUntil,
      now,
    };
  }
}
