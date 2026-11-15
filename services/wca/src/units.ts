import { EVENTS, getEvent, type EventInfo } from '@cubr/cubestats';

/**
 * Unit conversion between the WCA export and the cubr API.
 *
 *   WCA export (raw)                          API
 *   timed events: centiseconds (1234)    ->   milliseconds (12340)
 *   333fm single: moves (22)             ->   moves (22)
 *   333fm average: moves x 100 (2467)    ->   moves (24.67)
 *
 * Only the events cubr supports (cubestats EVENTS) are served; 333mbf (packed
 * points/time encoding) and retired events are never exposed.
 */
export type Kind = 'single' | 'average';
export const KINDS: Kind[] = ['single', 'average'];
export type Unit = EventInfo['unit']; // 'time' | 'moves'

/** The events the wca service serves, in cubr's display order. */
export const WCA_EVENTS: EventInfo[] = EVENTS;

export function supportedEvent(id: string): EventInfo | undefined {
  return getEvent(id);
}

export function unitOf(eventId: string): Unit {
  return getEvent(eventId)?.unit ?? 'time';
}

/** How many raw WCA units make one API unit (time: 1 cs = 10 ms, fm average: 100 raw = 1 move). */
function rawPerApiUnit(eventId: string, kind: Kind): number {
  if (unitOf(eventId) === 'moves') return kind === 'average' ? 100 : 1;
  return 0.1; // 1 ms = 0.1 cs
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Raw WCA value -> API value (integer ms for timed events, moves for 333fm). */
export function wcaToApi(eventId: string, kind: Kind, raw: number): number {
  if (unitOf(eventId) === 'moves') return round2(raw / rawPerApiUnit(eventId, kind));
  return Math.round(raw * 10);
}

/** Like wcaToApi but passes null through. */
export function wcaToApiOrNull(eventId: string, kind: Kind, raw: number | null | undefined): number | null {
  return raw === null || raw === undefined ? null : wcaToApi(eventId, kind, raw);
}

/**
 * API value -> raw WCA units. The result may be fractional (12345 ms = 1234.5 cs), it is
 * rounded to 6 decimals to remove floating-point noise (24.67 * 100 = 2466.9999999999995).
 */
export function apiToWca(eventId: string, kind: Kind, value: number): number {
  return Math.round(value * rawPerApiUnit(eventId, kind) * 1e6) / 1e6;
}

/**
 * Integer thresholds for strict comparisons against the integer `best` column:
 *   best <  fasterBelow   <=> strictly faster than the value
 *   best >  slowerAbove   <=> strictly slower than the value
 * e.g. 12345 ms = 1234.5 cs: faster = best <= 1234 (fasterBelow 1235), slower = best >= 1235.
 * Keeping the bounds integer lets Postgres use the (event_id, best) index.
 */
export function rawThresholds(raw: number): { fasterBelow: number; slowerAbove: number } {
  return { fasterBelow: Math.ceil(raw), slowerAbove: Math.floor(raw) };
}

/** Allowed `value` range per unit (ms for timed events, moves for 333fm). */
export function validateApiValue(eventId: string, value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return 'value must be a positive number';
  if (unitOf(eventId) === 'moves') {
    if (value > 100) return 'value must be at most 100 moves for 333fm';
    return null;
  }
  if (!Number.isInteger(value)) return 'value must be an integer number of milliseconds';
  if (value > 86_400_000) return 'value must be at most 86400000 ms';
  return null;
}
