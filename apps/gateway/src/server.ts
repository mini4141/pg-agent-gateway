import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import underPressure from '@fastify/under-pressure';
import type { Span } from '@opentelemetry/api';
import Fastify from 'fastify';
import { config } from './config.js';
import { control, type Caller, type Tenant } from './db/control.js';
import { GatewayError, toErrorBody } from './errors.js';
import { requestDuration, requestsTotal } from './obs/metrics.js';
import { record } from './obs/stats.js';
import { startRequestSpan } from './obs/tracing.js';
import { redis } from './pipeline/limiter.js';
import { adminRoutes, branchRoutes, healthRoutes, queryRoutes } from './routes/index.js';

interface Ctx {
  tenant: string;
  callerType: string;
  span: Span;
  tracked: boolean;
  admitted?: { caller: Caller; tenant: Tenant };
  latencyMs?: number; // set early for streamed responses (time to first row)
}
declare module 'fastify' {
  interface FastifyRequest {
    ctx: Ctx;
  }
}

export async function buildServer() {
  const app = Fastify({
    logger: { level: config.logLevel, redact: ['req.headers["x-api-key"]'] },
    disableRequestLogging: true,
    genReqId: () => randomUUID(),
    requestIdLogLabel: 'reqId',
  });

  app.decorateRequest('ctx', undefined as never);
  app.addHook('onRequest', async (req) => {
    const tracked = req.url.startsWith('/v1/');
    req.ctx = { tenant: 'unknown', callerType: 'unknown', span: startRequestSpan(`${req.method} ${req.url.split('?')[0]}`), tracked };
  });

  // Fault injection for the canary rollback drill: every /v1 request fails; health checks stay green.
  if (config.fault === '500') {
    app.addHook('onRequest', async (req, reply) => {
      if (req.ctx.tracked) {
        return reply.status(500).send({ error: { code: 'INTERNAL', message: 'fault injected (FAULT=500)', requestId: req.id } });
      }
    });
  }

  await app.register(underPressure, {
    maxEventLoopDelay: config.maxEventLoopDelayMs,
    maxHeapUsedBytes: config.maxHeapUsedBytes,
    retryAfter: 2,
    pressureHandler: (req, reply, type, value) => {
      if (!req.url.startsWith('/v1/')) return; // keep health and metrics reachable
      req.log.warn({ type, value }, 'shedding load');
      return reply
        .status(503)
        .header('retry-after', 2)
        .send(toErrorBody(new GatewayError('OVERLOADED', `service under pressure (${type})`), req.id));
    },
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'PG Agent Gateway', version: '1.0.0', description: 'Multi-tenant SQL execution. See docs/CONTRACT.md.' },
      components: { securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } } },
      security: [{ apiKey: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((err: Error, req, reply) => {
    let gw: GatewayError;
    if (err instanceof GatewayError) gw = err;
    else if ((err as { validation?: unknown }).validation) gw = new GatewayError('BAD_REQUEST', err.message);
    else {
      req.log.error({ err }, 'unhandled error');
      gw = new GatewayError('INTERNAL', 'internal error');
    }
    if (gw.opts.retryAfterSec) reply.header('retry-after', gw.opts.retryAfterSec);
    return reply.status(gw.status).send(toErrorBody(gw, req.id));
  });

  app.addHook('onResponse', async (req, reply) => {
    req.ctx.span.setAttribute('http.status_code', reply.statusCode);
    req.ctx.span.setAttribute('tenant', req.ctx.tenant);
    req.ctx.span.end();
    if (!req.ctx.tracked) return;
    const { tenant, callerType } = req.ctx;
    const ms = req.ctx.latencyMs ?? reply.elapsedTime;
    requestsTotal.inc({ tenant, caller_type: callerType, code: String(reply.statusCode) });
    requestDuration.observe({ tenant, caller_type: callerType }, ms / 1000);
    record(tenant, ms, reply.statusCode);
    // 429s are shedding by design and already counted in gw_ratelimited_total: log them at debug to keep floods cheap.
    req.log[reply.statusCode === 429 ? 'debug' : 'info']({ tenant, callerType, statusCode: reply.statusCode, durationMs: Math.round(ms) }, 'request');
    if (config.emf) {
      // CloudWatch Embedded Metric Format: one stdout line becomes three metrics, dimensioned by track.
      process.stdout.write(
        JSON.stringify({
          _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [{
              Namespace: 'PgAgentGateway',
              Dimensions: [['Track']],
              Metrics: [{ Name: 'Requests', Unit: 'Count' }, { Name: 'Errors5xx', Unit: 'Count' }, { Name: 'LatencyMs', Unit: 'Milliseconds' }],
            }],
          },
          Track: config.track,
          Requests: 1,
          Errors5xx: reply.statusCode >= 500 ? 1 : 0,
          LatencyMs: Math.round(ms),
        }) + '\n',
      );
    }
  });

  await app.register(healthRoutes, { deps: { control, redis } });
  await app.register(queryRoutes);
  await app.register(adminRoutes);
  await app.register(branchRoutes);

  const staticRoot = path.resolve(config.staticDir);
  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, { root: staticRoot, prefix: '/static/' });
    const index = (_req: unknown, reply: { sendFile: (f: string) => unknown }) => reply.sendFile('index.html');
    for (const p of ['/console', '/tenants']) app.get(p, { schema: { hide: true } }, index as never);
    app.get('/', { schema: { hide: true } }, (_req, reply) => reply.redirect('/console'));
  }
  return app;
}
