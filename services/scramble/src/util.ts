import type { FastifyBaseLogger } from 'fastify';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Rejects with `onTimeout()` if `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), Math.max(0, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Logs a warning at most once per `intervalMs` (per key) — keeps outage logs readable. */
export function throttledWarn(log: FastifyBaseLogger, intervalMs = 10_000) {
  const last = new Map<string, number>();
  return (key: string, obj: Record<string, unknown>, msg: string) => {
    const now = Date.now();
    if (now - (last.get(key) ?? 0) < intervalMs) return;
    last.set(key, now);
    log.warn(obj, msg);
  };
}

/** Readable error text (connection failures arrive as an AggregateError with an empty message). */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.message || (err as { code?: string }).code || err.name;
}
