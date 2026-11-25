export type ErrorCode =
  | 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'TENANT_NOT_FOUND' | 'NOT_FOUND' | 'READ_ONLY_VIOLATION'
  | 'SQL_ERROR' | 'STATEMENT_TIMEOUT' | 'RATE_LIMITED' | 'CONCURRENCY_LIMIT' | 'QUEUE_TIMEOUT'
  | 'POOL_SATURATED' | 'RESPONSE_TOO_LARGE' | 'OVERLOADED' | 'INTERNAL';

export const statusFor: Record<ErrorCode, number> = {
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, TENANT_NOT_FOUND: 404, NOT_FOUND: 404, READ_ONLY_VIOLATION: 403,
  SQL_ERROR: 400, STATEMENT_TIMEOUT: 408, RATE_LIMITED: 429, CONCURRENCY_LIMIT: 429, QUEUE_TIMEOUT: 503,
  POOL_SATURATED: 503, RESPONSE_TOO_LARGE: 413, OVERLOADED: 503, INTERNAL: 500,
};

export class GatewayError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public opts: { retryAfterSec?: number; sqlState?: string } = {},
  ) {
    super(message);
  }
  get status() {
    return statusFor[this.code];
  }
}

/** The one error shape callers see: { error: { code, message, requestId, sqlState?, retryAfterSec? } }. */
export function toErrorBody(err: GatewayError, requestId: string) {
  return {
    error: {
      code: err.code,
      message: err.message,
      requestId,
      ...(err.opts.sqlState ? { sqlState: err.opts.sqlState } : {}),
      ...(err.opts.retryAfterSec ? { retryAfterSec: err.opts.retryAfterSec } : {}),
    },
  };
}

/** Map a node-postgres error to a GatewayError. `timedOut` is set by our own watchdog. */
export function fromPgError(e: unknown, timedOut: boolean): GatewayError {
  const err = e as { code?: string; message?: string };
  if (timedOut || err.code === '57014') {
    return new GatewayError('STATEMENT_TIMEOUT', 'statement exceeded its timeout and was cancelled', { sqlState: '57014' });
  }
  if (err.code === '25006' || err.code === '42501') {
    return new GatewayError('READ_ONLY_VIOLATION', 'this caller is read-only', { sqlState: err.code });
  }
  if (err.code && /^[0-9A-Z]{5}$/.test(err.code)) {
    return new GatewayError('SQL_ERROR', err.message ?? 'sql error', { sqlState: err.code });
  }
  return new GatewayError('INTERNAL', 'internal error');
}
