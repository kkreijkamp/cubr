// Scramble queue: keeps ~5 scrambles per event from the scramble service (api.scrambles.get) and
// falls back to the client-side random-move scramblers when the service is down or slow.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { fallbackScramble } from './fallbackScramble';

export interface ScrambleItem {
  text: string;
  /** generated in the browser because the scramble service was unreachable */
  offline: boolean;
}

const BATCH = 5;
const queues = new Map<string, ScrambleItem[]>();
const inflight = new Map<string, Promise<void>>();
/** the scramble currently shown per event, so switching events back and forth keeps it */
const currentByEvent = new Map<string, ScrambleItem>();
let serviceDownUntil = 0;

function refill(event: string): Promise<void> {
  const running = inflight.get(event);
  if (running) return running;
  if (Date.now() < serviceDownUntil) return Promise.resolve();
  const p = api.scrambles
    .get(event, BATCH)
    .then((r) => {
      const fresh = (r?.scrambles ?? []).filter((s) => typeof s === 'string' && s.trim()).map((text) => ({ text: text.trim(), offline: false }));
      queues.set(event, [...(queues.get(event) ?? []), ...fresh]);
      serviceDownUntil = 0;
    })
    .catch(() => {
      serviceDownUntil = Date.now() + 30_000;
    })
    .finally(() => inflight.delete(event));
  inflight.set(event, p);
  return p;
}

function shiftQueued(event: string): ScrambleItem | null {
  const q = queues.get(event);
  if (!q || q.length === 0) return null;
  const item = q.shift()!;
  if (q.length < 2) void refill(event);
  return item;
}

/** Next scramble: from the queue, else wait briefly for the service, else generate offline. */
async function take(event: string): Promise<ScrambleItem> {
  const queued = shiftQueued(event);
  if (queued) return queued;
  await Promise.race([refill(event), new Promise((r) => setTimeout(r, 2500))]);
  return shiftQueued(event) ?? { text: fallbackScramble(event), offline: true };
}

/** Warm the queue for an event (e.g. on page load) without consuming anything. */
export function prefetchScrambles(event: string): void {
  if ((queues.get(event)?.length ?? 0) < 2) void refill(event);
}

export interface ScrambleQueue {
  /** null while the first scramble of an event is being fetched */
  current: ScrambleItem | null;
  /** advance to the next scramble (Tab / after a solve) */
  next: () => void;
}

export function useScrambleQueue(event: string): ScrambleQueue {
  const [state, setState] = useState<{ event: string; item: ScrambleItem | null }>(() => ({
    event,
    item: currentByEvent.get(event) ?? null,
  }));
  const req = useRef(0);

  const show = useCallback((ev: string, item: ScrambleItem | null) => {
    if (item) currentByEvent.set(ev, item);
    setState({ event: ev, item });
  }, []);

  const load = useCallback(
    (ev: string) => {
      const id = ++req.current;
      const ready = shiftQueued(ev);
      if (ready) {
        show(ev, ready);
        return;
      }
      show(ev, null);
      void take(ev).then((item) => {
        if (id === req.current) show(ev, item);
        else queues.set(ev, [item, ...(queues.get(ev) ?? [])]); // not needed any more: keep it
      });
    },
    [show],
  );

  useEffect(() => {
    const existing = currentByEvent.get(event);
    if (existing) {
      req.current++;
      show(event, existing);
    } else load(event);
    prefetchScrambles(event);
  }, [event, load, show]);

  const item = state.event === event ? state.item : null;

  const next = useCallback(() => {
    currentByEvent.delete(event);
    load(event);
  }, [event, load]);

  return { current: item, next };
}
