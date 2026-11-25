import client from 'prom-client';
import { poolUsage } from '../pg/tenantPools.js';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

/** Labels are limited to tenant and caller_type (never caller IDs or SQL) so cardinality stays bounded. */
export const requestsTotal = new client.Counter({
  name: 'gw_requests_total',
  help: 'Requests by tenant, caller type and status code',
  labelNames: ['tenant', 'caller_type', 'code'],
  registers: [registry],
});
export const requestDuration = new client.Histogram({
  name: 'gw_request_duration_seconds',
  help: 'Request duration',
  labelNames: ['tenant', 'caller_type'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});
export const poolInUse = new client.Gauge({
  name: 'gw_pool_in_use',
  help: 'Checked-out connections per tenant pool',
  labelNames: ['tenant'],
  registers: [registry],
  collect() {
    for (const [tenant, u] of Object.entries(poolUsage())) this.set({ tenant }, u.inUse);
  },
});
export const ratelimitedTotal = new client.Counter({
  name: 'gw_ratelimited_total',
  help: 'Requests rejected by the rate limit or concurrency stages',
  labelNames: ['tenant', 'caller_type', 'stage'],
  registers: [registry],
});
export const cancelledTotal = new client.Counter({
  name: 'gw_cancelled_queries_total',
  help: 'Queries cancelled server-side with pg_cancel_backend',
  labelNames: ['tenant', 'reason'],
  registers: [registry],
});
