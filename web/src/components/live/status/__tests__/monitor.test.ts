import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type RawResponse } from '../../../../lib/api';
import type { ServiceInfo } from '../../../../lib/types';
import { ClusterMonitor } from '../monitor';

const SERVICES = [{ name: 'solve', path: '/api/solves/_info' }];

function reply(pod: string): RawResponse<ServiceInfo> {
  return {
    data: { service: 'solve', version: '1.2.0', pod, node: 'node-a', startedAt: '2026-01-01T00:00:00.000Z', uptimeSec: 60, deps: { postgres: 'ok' } },
    status: 200,
    headers: new Headers({ 'x-served-by': pod }),
    servedBy: pod,
    ms: 12,
  };
}

/** Starts a monitor on fake timers and lets `ms` of polling happen. */
async function run(fetchInfo: ConstructorParameters<typeof ClusterMonitor>[0], ms: number) {
  const monitor = new ClusterMonitor(fetchInfo, SERVICES);
  monitor.start();
  await vi.advanceTimersByTimeAsync(ms);
  monitor.dispose();
  return monitor.store.get().services[0];
}

describe('ClusterMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a request timeout as a timeout, not as an unreachable service', async () => {
    vi.useFakeTimers();
    const svc = await run(() => Promise.reject(new ApiError(0, 'TIMEOUT', 'Request timed out')), 100);
    expect(svc.status).toBe('down');
    expect(svc.error).toBe('timeout (2.5s)');
    expect(svc.httpStatus).toBeNull();
  });

  it('reports a network failure as unreachable', async () => {
    vi.useFakeTimers();
    const svc = await run(() => Promise.reject(new ApiError(0, 'NETWORK', 'Network error - is the server reachable?')), 100);
    expect(svc.status).toBe('down');
    expect(svc.error).toBe('unreachable');
  });

  it('marks a service up and lists the pods that answered', async () => {
    vi.useFakeTimers();
    let n = 0;
    const svc = await run(() => Promise.resolve(reply(n++ % 2 ? 'solve-7d9f8c6b5-x2k4q' : 'solve-7d9f8c6b5-p9m3z')), 3500);
    expect(svc.status).toBe('up');
    expect(svc.latency).toBe(12);
    expect(svc.pods.map((p) => p.pod).sort()).toEqual(['solve-7d9f8c6b5-p9m3z', 'solve-7d9f8c6b5-x2k4q']);
  });
});
