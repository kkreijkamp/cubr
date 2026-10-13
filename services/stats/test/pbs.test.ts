import { describe, expect, it } from 'vitest';
import { isImprovement, rollingFromPayload } from '../src/domain/pbs.js';

describe('incremental helpers', () => {
  it('isImprovement', () => {
    expect(isImprovement(9000, null)).toBe(true);
    expect(isImprovement(9000, 9500)).toBe(true);
    expect(isImprovement(9500, 9500)).toBe(false);
    expect(isImprovement(Number.POSITIVE_INFINITY, null)).toBe(false);
    expect(isImprovement(null, null)).toBe(false);
    expect(isImprovement(-1, null)).toBe(false);
  });

  it('rollingFromPayload maps -1 / null to "no candidate"', () => {
    expect(rollingFromPayload(10234)).toBe(10234);
    expect(rollingFromPayload(-1)).toBeNull();
    expect(rollingFromPayload(null)).toBeNull();
    expect(rollingFromPayload(undefined)).toBeNull();
  });
});
