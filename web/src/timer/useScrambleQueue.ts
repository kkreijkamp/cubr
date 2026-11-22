// Scramble queue: keeps ~5 scrambles per event from the scramble service (api.scrambles.get) and
// falls back to the client-side random-move scramblers when the service is down or slow.
import { useCallback, useEffect, useRef, useState } from 'react';
import { isWcaEvent } from '@cubr/cubestats';
import { api, ApiError } from '../lib/api';
import { offlineScramble } from './fallbackScramble';

export interface ScrambleItem {
  text: string;
  /** generated in the browser because the scramble service was unreachable */
  offline: boolean;
  /** no scramble: the service is unreachable and this kind can't be made offline (text is '') */
  unavailable?: boolean;
  /** ...because the service refused for now: too many new scrambles from here in the last minute */
  busy?: boolean;
  /** typed in by the user */
  custom?: boolean;
  /** worked out from the state a smart cube was scrambled into by hand */
  fromCube?: boolean;
}

const BATCH = 5;
/** the scrambles the service makes on request (practice types, other events): fewer at a time, as each counts against its per-minute budget */
const MADE_BATCH = 2;
/** queues, requests and shown scrambles are per event and scramble type: "333", "333/pll" */
const queues = new Map<string, ScrambleItem[]>();
const inflight = new Map<string, Promise<void>>();
/** the scramble currently shown per event (and type), so switching back and forth keeps it */
const currentByEvent = new Map<string, ScrambleItem>();
let serviceDownUntil = 0;
/** the service refused (429): too many new scrambles from here; it'll take more shortly */
let busyUntil = 0;

const queueKey = (event: string, type?: string) => (type ? `${event}/${type}` : event);
const parseKey = (key: string): [string, string | undefined] => {
  const i = key.indexOf('/');
  return i < 0 ? [key, undefined] : [key.slice(0, i), key.slice(i + 1)];
};

function refill(key: string): Promise<void> {
  const running = inflight.get(key);
  if (running) return running;
  if (Date.now() < serviceDownUntil) return Promise.resolve();
  const [event, type] = parseKey(key);
  const made = !!type || !isWcaEvent(event);
  if (made && Date.now() < busyUntil) return Promise.resolve();
  const p = api.scrambles
    .get(event, made ? MADE_BATCH : BATCH, false, { type })
    .then((r) => {
      const fresh = (r?.scrambles ?? []).filter((s) => typeof s === 'string' && s.trim()).map((text) => ({ text: text.trim(), offline: false }));
      queues.set(key, [...(queues.get(key) ?? []), ...fresh]);
      serviceDownUntil = 0;
    })
    .catch((e: unknown) => {
      // a refusal (429) isn't an outage: try again in a few seconds, and the pooled wca scrambles keep coming
      if (e instanceof ApiError && e.status === 429) busyUntil = Date.now() + 10_000;
      else serviceDownUntil = Date.now() + 30_000;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
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
async function take(key: string): Promise<ScrambleItem> {
  const queued = shiftQueued(key);
  if (queued) return queued;
  await Promise.race([refill(key), new Promise((r) => setTimeout(r, 2500))]);
  const [event, type] = parseKey(key);
  const offline = offlineScramble(event, type);
  const busy = Date.now() < busyUntil;
  return shiftQueued(key) ?? (offline ? { text: offline, offline: true } : { text: '', offline: true, unavailable: true, ...(busy ? { busy } : {}) });
}

/** Warm the queue for an event (and scramble type) without consuming anything. */
export function prefetchScrambles(event: string, type?: string): void {
  const key = queueKey(event, type);
  if ((queues.get(key)?.length ?? 0) < 2) void refill(key);
}

export interface ScrambleQueue {
  /** null while the first scramble of an event is being fetched */
  current: ScrambleItem | null;
  /** advance to the next scramble (Tab / after a solve) */
  next: () => void;
  /** go back to the previous scramble, if any */
  prev: () => void;
  hasPrev: boolean;
  /** replace the current scramble with a user-entered one */
  setCustom: (text: string) => void;
  /** replace the current scramble with one that gives the state a smart cube was scrambled into */
  setFromCube: (text: string) => void;
}

/** `type`: a practice scramble type (the event's default when absent) */
export function useScrambleQueue(event: string, type?: string): ScrambleQueue {
  return useKeyedScrambleQueue(queueKey(event, type));
}

function useKeyedScrambleQueue(event: string): ScrambleQueue {
  const [state, setState] = useState<{ event: string; item: ScrambleItem | null }>(() => ({
    event,
    item: currentByEvent.get(event) ?? null,
  }));
  const history = useRef<Map<string, ScrambleItem[]>>(new Map());
  const req = useRef(0);
  const [, force] = useState(0);

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
    if ((queues.get(event)?.length ?? 0) < 2) void refill(event);
  }, [event, load, show]);

  const item = state.event === event ? state.item : null;

  const next = useCallback(() => {
    if (item) {
      const h = history.current.get(event) ?? [];
      h.push(item);
      if (h.length > 20) h.shift();
      history.current.set(event, h);
    }
    currentByEvent.delete(event);
    load(event);
  }, [event, item, load]);

  const prev = useCallback(() => {
    const h = history.current.get(event);
    const back = h?.pop();
    if (!back) return;
    if (item && !item.custom && !item.fromCube) queues.set(event, [item, ...(queues.get(event) ?? [])]);
    req.current++;
    show(event, back);
    force((n) => n + 1);
  }, [event, item, show]);

  const replace = useCallback(
    (text: string, kind: 'custom' | 'fromCube') => {
      const t = text.trim();
      if (!t) return;
      // a scramble from the service that wasn't used goes back to the front of the queue
      if (item && !item.custom && !item.fromCube) queues.set(event, [item, ...(queues.get(event) ?? [])]);
      req.current++;
      show(event, { text: t.slice(0, 2000), offline: false, [kind]: true });
    },
    [event, item, show],
  );
  const setCustom = useCallback((text: string) => replace(text, 'custom'), [replace]);
  const setFromCube = useCallback((text: string) => replace(text, 'fromCube'), [replace]);

  return { current: item, next, prev, hasPrev: (history.current.get(event)?.length ?? 0) > 0, setCustom, setFromCube };
}
