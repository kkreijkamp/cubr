import { describe, expect, it } from 'vitest';
import { depsChanged } from '../useAsync';

// useAsync drops the last selection's data when a load for new deps fails (the October review's #17);
// whether the deps are new is decided here, the way React compares them.
describe('depsChanged', () => {
  it('counts the first run as a change', () => {
    expect(depsChanged(null, [])).toBe(true);
    expect(depsChanged(null, ['333'])).toBe(true);
  });

  it('compares each dep with Object.is', () => {
    const user = { id: 'u1' };
    expect(depsChanged(['333', user], ['333', user])).toBe(false);
    expect(depsChanged(['333', user], ['444', user])).toBe(true);
    expect(depsChanged(['333', user], ['333', { id: 'u1' }])).toBe(true); // a new object is a new dep
    expect(depsChanged([NaN, 0], [NaN, 0])).toBe(false);
    expect(depsChanged([0], [-0])).toBe(true);
    expect(depsChanged([undefined], [null])).toBe(true);
  });

  it('counts a different number of deps as a change', () => {
    expect(depsChanged(['333'], ['333', 1])).toBe(true);
    expect(depsChanged([], [])).toBe(false);
  });
});
