import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
  setData: (d: T | undefined) => void;
}

/** Whether `next` deps differ from `prev` (null: the first run), compared like React compares deps. */
export function depsChanged(prev: readonly unknown[] | null, next: readonly unknown[]): boolean {
  return !prev || prev.length !== next.length || next.some((d, i) => !Object.is(d, prev[i]));
}

/**
 * Runs an async loader whenever `deps` change; aborts stale requests. Keeps the data on hand while
 * a load runs, so a page doesn't flash empty between selections. But a load for new deps that fails
 * drops the last selection's data, so a widget shows the error rather than the old selection's
 * numbers under the new one's label (the October review's #17); a failed reload() of the same deps
 * keeps its data.
 */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const lastDeps = useRef<unknown[] | null>(null);
  /** the data on hand was loaded (or set) for the current deps */
  const current = useRef(false);

  useEffect(() => {
    if (depsChanged(lastDeps.current, deps)) current.current = false;
    lastDeps.current = deps;
    const ctrl = new AbortController();
    setLoading(true);
    setError(undefined);
    fnRef
      .current(ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return;
        current.current = true;
        setData(d);
      })
      .catch((e: Error) => {
        if (ctrl.signal.aborted || e.name === 'AbortError') return;
        if (!current.current) setData(undefined);
        setError(e);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((d: T | undefined) => {
    current.current = true;
    setData(d);
  }, []);
  return { data, error, loading, reload, setData: set };
}
