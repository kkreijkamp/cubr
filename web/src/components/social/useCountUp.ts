import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './util';

/** Animates from the previous value to `target` (ease-out cubic). null keeps the current value. */
export function useCountUp(target: number | null, durationMs = 1400): number {
  const [value, setValue] = useState(0);
  const current = useRef(0);

  useEffect(() => {
    if (target === null || !Number.isFinite(target)) return;
    const from = current.current;
    if (prefersReducedMotion() || from === target) {
      current.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      const v = from + (target - from) * eased;
      current.current = v;
      setValue(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}
