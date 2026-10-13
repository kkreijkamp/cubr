/** PB kinds in display order (SPEC §7.3 CHECK constraint). */
export const PB_KINDS = ['single', 'mo3', 'ao5', 'ao12', 'ao50', 'ao100'] as const;
export type PbKind = (typeof PB_KINDS)[number];

/** True when `candidate` is a real (finite, positive) time that beats `current` (null = no PB yet). */
export function isImprovement(candidate: number | null | undefined, current: number | null | undefined): boolean {
  if (candidate === null || candidate === undefined || !Number.isFinite(candidate) || candidate <= 0) return false;
  return current === null || current === undefined || candidate < current;
}

/** Payload `rolling.ao5/ao12` → candidate ms (positive number), DNF (-1) / null → null. */
export function rollingFromPayload(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}
