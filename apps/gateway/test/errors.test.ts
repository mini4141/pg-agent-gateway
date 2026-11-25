import { describe, expect, it } from 'vitest';
import { fromPgError, GatewayError, toErrorBody } from '../src/errors.js';

describe('contract error serializer', () => {
  it('renders the documented error shape', () => {
    const body = toErrorBody(new GatewayError('RATE_LIMITED', 'slow down', { retryAfterSec: 2 }), 'req-1');
    expect(body).toEqual({ error: { code: 'RATE_LIMITED', message: 'slow down', requestId: 'req-1', retryAfterSec: 2 } });
  });

  it('maps postgres errors to contract codes', () => {
    expect(fromPgError({ code: '57014' }, false).code).toBe('STATEMENT_TIMEOUT');
    expect(fromPgError({ code: '25006' }, false).status).toBe(403);
    expect(fromPgError({ code: '42P01', message: 'no table' }, false)).toMatchObject({ code: 'SQL_ERROR', status: 400 });
  });
});
