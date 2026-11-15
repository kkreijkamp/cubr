import { HttpError, unavailable } from '@cubr/common';

/** A scramble did not finish (queue wait + search) within SCRAMBLE_TIMEOUT_MS. */
export class GenerationTimeoutError extends Error {
  constructor(message = 'scramble generation timed out') {
    super(message);
    this.name = 'GenerationTimeoutError';
  }
}

/** Too many scrambles are already queued - shed load instead of building an unbounded backlog. */
export class QueueFullError extends Error {
  constructor(message = 'scramble queue is full') {
    super(message);
    this.name = 'QueueFullError';
  }
}

/** Maps generator failures to the API error envelope (timeouts / overload -> 503 UNAVAILABLE). */
export function toHttpError(err: unknown): unknown {
  if (err instanceof HttpError) return err;
  if (err instanceof GenerationTimeoutError) return unavailable('Scramble generation timed out, please retry');
  if (err instanceof QueueFullError) return unavailable('Scramble service is busy, please retry');
  return err;
}
