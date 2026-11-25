import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import QueryStream from 'pg-query-stream';
import { callerLimits, config, type CallerType } from '../config.js';
import { getCaller, getTenant, type Caller, type Tenant } from '../db/control.js';
import { fromPgError, GatewayError } from '../errors.js';
import { cancelledTotal, ratelimitedTotal } from '../obs/metrics.js';
import { span } from '../obs/tracing.js';
import { acquire, cancelBackend, getPool } from '../pg/tenantPools.js';
import { acquireSlot, tokenBucket } from './limiter.js';

export interface QueryInput {
  sql: string;
  params?: unknown[];
  maxRows?: number;
  timeoutMs?: number;
  stream?: boolean;
  multi?: 'last' | 'all';
}

const clamp = (v: number | undefined, def: number, max: number) => Math.min(Math.max(1, v ?? def), max);

/** Stage 1a: API-key auth. Throws 401 for a missing or unknown key. */
export async function authenticateCaller(req: FastifyRequest): Promise<Caller> {
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || !key) throw new GatewayError('UNAUTHORIZED', 'missing x-api-key');
  const caller = await getCaller(key);
  if (!caller) throw new GatewayError('UNAUTHORIZED', 'unknown api key');
  return caller;
}

/** Stage 1b: the key must be valid for this tenant and for the declared x-caller-type. */
async function authorize(req: FastifyRequest, tenantId: string) {
  const caller = await authenticateCaller(req);
  if (caller.tenantId && caller.tenantId !== tenantId) throw new GatewayError('FORBIDDEN', 'api key is not valid for this tenant');
  if (req.headers['x-caller-type'] !== caller.type) throw new GatewayError('FORBIDDEN', 'x-caller-type does not match the api key');
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new GatewayError('TENANT_NOT_FOUND', `unknown tenant ${tenantId}`);
  return { caller, tenant };
}

/**
 * Stages 1-2 (auth, token bucket) run as an onRequest hook, before the body is parsed or validated,
 * so a flooding tenant's rejected requests cost as little as possible.
 */
export async function admit(req: FastifyRequest, tenantId: string): Promise<void> {
  const root = req.ctx.span;
  const { caller, tenant } = await span(root, 'auth', () => authorize(req, tenantId));
  const type = caller.type as CallerType;
  req.ctx.tenant = tenant.id;
  req.ctx.callerType = type;
  req.ctx.admitted = { caller, tenant };

  await span(root, 'ratelimit', async () => {
    const r = await tokenBucket(`rl:${tenant.id}:${type}`, tenant.rateLimitRps, tenant.rateLimitRps);
    if (!r.allowed) {
      ratelimitedTotal.inc({ tenant: tenant.id, caller_type: type, stage: 'token_bucket' });
      throw new GatewayError('RATE_LIMITED', 'rate limit exceeded for this tenant and caller type', {
        retryAfterSec: Math.max(1, Math.ceil(r.retryAfterMs / 1000)),
      });
    }
  });
}

/** Stages 3-4: per-tenant concurrency semaphore, then the tenant pool with a bounded queue. */
export async function runQuery(req: FastifyRequest, reply: FastifyReply, input: QueryInput) {
  const root = req.ctx.span;
  const { caller, tenant } = req.ctx.admitted!;
  const type = caller.type as CallerType;
  const limits = callerLimits[type];
  const maxRows = clamp(input.maxRows, input.stream ? limits.hardMaxRows : limits.defaultMaxRows, limits.hardMaxRows);
  const timeoutMs = clamp(input.timeoutMs, limits.defaultTimeoutMs, limits.hardTimeoutMs);

  const release = await span(root, 'semaphore_wait', () => acquireSlot(tenant.id, tenant.maxConcurrency)).catch((e) => {
    ratelimitedTotal.inc({ tenant: tenant.id, caller_type: type, stage: 'semaphore' });
    throw e;
  });

  const run = { req, reply, tenant, caller, mode: limits.readOnly ? ('ro' as const) : ('rw' as const), maxRows, timeoutMs, input };
  try {
    return input.stream ? await streamQuery(run, release) : await jsonQuery(run, release);
  } catch (e) {
    await release();
    throw e;
  }
}

interface Run {
  req: FastifyRequest;
  reply: FastifyReply;
  tenant: Tenant;
  caller: Caller;
  mode: 'ro' | 'rw';
  maxRows: number;
  timeoutMs: number;
  input: QueryInput;
}

/** Holds one checked-out connection plus the watchdog that cancels it on timeout or client disconnect. */
async function checkout(run: Run) {
  const { req, reply, tenant, mode, timeoutMs } = run;
  const pool = await getPool(tenant, mode);
  const client = await span(req.ctx.span, 'pool_acquire', () => acquire(pool));
  const pid = (client as unknown as { processID: number }).processID;
  const state = { timedOut: false, done: false, cancelled: false };
  // Unique marker prepended to the SQL so a late cancel can never hit the connection's next query.
  const tag = `/* gw:${req.id} */ `;

  const cancel = (reason: 'timeout' | 'client_disconnect') => {
    if (state.done || state.cancelled) return;
    state.cancelled = true;
    cancelledTotal.inc({ tenant: tenant.id, reason });
    req.log.info({ tenant: tenant.id, backendPid: pid, reason }, 'pg_cancel_backend');
    cancelBackend(tenant, mode, pid, tag).catch((err) => req.log.warn({ err: err.message }, 'cancel failed'));
  };
  const timer = setTimeout(() => {
    state.timedOut = true;
    cancel('timeout');
  }, timeoutMs);
  const onClose = () => {
    if (!reply.raw.writableEnded) cancel('client_disconnect');
  };
  reply.raw.on('close', onClose);

  /** `broken` destroys the connection instead of returning it to the pool. */
  const finish = (broken: boolean) => {
    state.done = true;
    clearTimeout(timer);
    reply.raw.off('close', onClose);
    client.release(broken);
  };
  const begin = async () => {
    await client.query(run.mode === 'ro' ? 'BEGIN READ ONLY' : 'BEGIN');
    // Backstop only: the watchdog above cancels at timeoutMs via pg_cancel_backend.
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs + 2000}`);
  };
  return { client, state, begin, finish, tag };
}

const fieldsOf = (r: pg.QueryResult) => r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }));

async function jsonQuery(run: Run, release: () => Promise<void>) {
  const { req, reply, input, maxRows } = run;
  const started = performance.now();
  const { client, state, begin, finish, tag } = await checkout(run);
  let broken = false;
  try {
    const results = await span(req.ctx.span, 'query', async () => {
      await begin();
      const r = input.params ? await client.query(tag + input.sql, input.params) : await client.query(tag + input.sql);
      await client.query('COMMIT');
      return Array.isArray(r) ? r : [r];
    });
    state.done = true;
    const shape = (r: pg.QueryResult) => {
      const truncated = r.rows.length > maxRows;
      const rows = truncated ? r.rows.slice(0, maxRows) : r.rows;
      return { rows, fields: fieldsOf(r), rowCount: rows.length, truncated };
    };
    const durationMs = Math.round(performance.now() - started);
    const body = JSON.stringify(
      input.multi === 'all' ? { results: results.map(shape), durationMs } : { ...shape(results[results.length - 1]!), durationMs },
    );
    if (Buffer.byteLength(body) > config.maxResponseBytes) {
      throw new GatewayError('RESPONSE_TOO_LARGE', `result exceeds ${config.maxResponseBytes} bytes; use stream=true or a lower maxRows`);
    }
    return reply.type('application/json').send(body);
  } catch (e) {
    broken = !(await client.query('ROLLBACK').then(() => true, () => false));
    throw e instanceof GatewayError ? e : fromPgError(e, state.timedOut);
  } finally {
    finish(broken);
    await release();
  }
}

/** NDJSON: one line per row, then a `{_meta:{rowCount,truncated}}` trailer. Backpressure comes from Readable.from. */
async function streamQuery(run: Run, release: () => Promise<void>) {
  const { req, reply, input, maxRows } = run;
  const { client, state, begin, finish, tag } = await checkout(run);

  async function* lines(): AsyncGenerator<string> {
    let started = false;
    let broken = false;
    try {
      await begin();
      const qs = client.query(new QueryStream(tag + input.sql, input.params ?? [], { batchSize: 500 }));
      let count = 0;
      let truncated = false;
      for await (const row of qs) {
        if (state.timedOut) throw new GatewayError('STATEMENT_TIMEOUT', 'stream exceeded its timeout', { sqlState: '57014' });
        if (count >= maxRows) {
          truncated = true;
          broken = true; // connection holds an open cursor: discard it
          qs.destroy();
          break;
        }
        count++;
        started = true;
        yield JSON.stringify(row) + '\n';
      }
      state.done = true;
      if (!truncated) await client.query('COMMIT');
      yield JSON.stringify({ _meta: { rowCount: count, truncated } }) + '\n';
    } catch (e) {
      broken = true;
      const err = e instanceof GatewayError ? e : fromPgError(e, state.timedOut);
      if (!started) throw err;
      yield JSON.stringify({ _error: { code: err.code, message: err.message } }) + '\n'; // headers already sent
    } finally {
      if (!state.done) broken = true; // aborted mid-flight (client disconnect)
      finish(broken);
      await release();
    }
  }

  const it = lines();
  // Peek the first line so SQL errors and timeouts surface as a real HTTP status instead of a broken stream.
  const first = await span(req.ctx.span, 'query', () => it.next());
  async function* chained() {
    if (!first.done) yield first.value;
    yield* it;
  }
  return reply.type('application/x-ndjson').send(Readable.from(chained(), { objectMode: false }));
}
