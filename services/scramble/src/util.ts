export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Rejects with `onTimeout()` if `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), Math.max(0, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Readable error text (connection failures arrive as an AggregateError with an empty message). */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.message || (err as { code?: string }).code || err.name;
}
