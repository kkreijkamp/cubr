export type ErrorCode =
  'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'PAYLOAD_TOO_LARGE' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INTERNAL';

/** Throw from any handler; the shared error handler turns it into `{error:{code,message}}`. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg = 'Bad request') => new HttpError(400, 'BAD_REQUEST', msg);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (msg = 'Conflict') => new HttpError(409, 'CONFLICT', msg);
export const rateLimited = (msg = 'Too many requests') => new HttpError(429, 'RATE_LIMITED', msg);
export const unavailable = (msg = 'Service unavailable') => new HttpError(503, 'UNAVAILABLE', msg);
