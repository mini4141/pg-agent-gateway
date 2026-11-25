import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { GatewayError } from '../errors.js';
import { registry } from '../obs/metrics.js';
import { snapshot } from '../obs/stats.js';
import { admit, authenticateCaller, runQuery } from '../pipeline/execute.js';
import { getBranch, putBranch } from '../secrets/branchStore.js';
import { config } from '../config.js';

export async function healthRoutes(app: FastifyInstance, opts: { deps: { control: pg.Pool; redis: Redis } }) {
  app.get('/healthz', { schema: { tags: ['ops'], summary: 'Liveness' } }, async () => ({ status: 'ok', track: config.track }));
  app.get('/readyz', { schema: { tags: ['ops'], summary: 'Readiness: control DB and Redis' } }, async (_req, reply) => {
    try {
      await opts.deps.control.query('select 1');
      await opts.deps.redis.ping();
      return { status: 'ready' };
    } catch (e) {
      return reply.status(503).send({ status: 'not ready', reason: (e as Error).message });
    }
  });
  app.get('/metrics', { schema: { tags: ['ops'], summary: 'Prometheus metrics' } }, async (_req, reply) => {
    return reply.type(registry.contentType).send(await registry.metrics());
  });
}

const queryBody = {
  type: 'object',
  required: ['sql'],
  properties: {
    sql: { type: 'string', minLength: 1 },
    params: { type: 'array' },
    maxRows: { type: 'integer', minimum: 1 },
    timeoutMs: { type: 'integer', minimum: 1 },
    stream: { type: 'boolean' },
  },
} as const;

const headers = {
  type: 'object',
  properties: { 'x-caller-type': { type: 'string', enum: ['console', 'mcp', 'agent'] } },
  required: ['x-caller-type'],
} as const;

export async function queryRoutes(app: FastifyInstance) {
  app.post<{ Params: { tenant: string }; Querystring: { multi?: 'last' | 'all' }; Body: { sql: string; params?: unknown[]; maxRows?: number; timeoutMs?: number; stream?: boolean } }>(
    '/v1/tenants/:tenant/query',
    {
      onRequest: async (req) => admit(req, (req.params as { tenant: string }).tenant),
      schema: {
        tags: ['query'],
        summary: 'Run SQL for a tenant',
        description:
          'Response: `{rows, fields, rowCount, truncated, durationMs}`, or NDJSON rows plus a `{_meta}` trailer when `stream=true`. Errors: `{error:{code,message,requestId}}`.',
        headers,
        querystring: { type: 'object', properties: { multi: { type: 'string', enum: ['last', 'all'] } } },
        body: queryBody,
      },
    },
    (req, reply) => runQuery(req, reply, { ...req.body, multi: req.query.multi }),
  );

  app.get<{ Params: { tenant: string } }>(
    '/v1/tenants/:tenant/tables',
    {
      onRequest: async (req) => admit(req, (req.params as { tenant: string }).tenant),
      schema: { tags: ['query'], summary: 'List tables of a tenant database', headers },
    },
    (req, reply) =>
      runQuery(req, reply, {
        sql: "select table_name, table_type from information_schema.tables where table_schema = 'public' order by table_name",
      }),
  );
}

export async function adminRoutes(app: FastifyInstance) {
  app.get('/v1/admin/stats', { schema: { tags: ['admin'], summary: 'Live per-tenant stats (last 10 s, this instance)' } }, async (req) => {
    const caller = await authenticateCaller(req);
    if (caller.role !== 'admin') throw new GatewayError('FORBIDDEN', 'admin role required');
    return { track: config.track, tenants: snapshot() };
  });
}

export async function branchRoutes(app: FastifyInstance) {
  const guard = async (req: Parameters<typeof authenticateCaller>[0]) => {
    const caller = await authenticateCaller(req);
    if (caller.role !== 'platform-worker') throw new GatewayError('FORBIDDEN', 'platform-worker role required');
  };
  type P = { Params: { project: string; branch: string } };

  app.put<P & { Body: { config: Record<string, unknown>; secrets: Record<string, unknown> } }>(
    '/v1/projects/:project/branches/:branch/config',
    {
      schema: {
        tags: ['branches'],
        summary: 'Store branch config and (encrypted) secrets',
        body: { type: 'object', required: ['config', 'secrets'], properties: { config: { type: 'object' }, secrets: { type: 'object' } } },
      },
    },
    async (req, reply) => {
      await guard(req);
      await putBranch(req.params.project, req.params.branch, req.body);
      return reply.status(204).send();
    },
  );

  app.get<P>(
    '/v1/projects/:project/branches/:branch/config',
    { schema: { tags: ['branches'], summary: 'Deliver decrypted branch config and secrets (platform-worker only)' } },
    async (req) => {
      await guard(req);
      const b = await getBranch(req.params.project, req.params.branch);
      if (!b) throw new GatewayError('NOT_FOUND', 'branch not found');
      return b;
    },
  );
}
