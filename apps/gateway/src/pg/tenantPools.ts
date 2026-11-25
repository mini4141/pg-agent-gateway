import pg from 'pg';
import { config } from '../config.js';
import type { Tenant } from '../db/control.js';
import { GatewayError } from '../errors.js';
import { open } from '../secrets/crypto.js';

export type Mode = 'rw' | 'ro';
const pools = new Map<string, { tenant: string; pool: pg.Pool }>();
const creds = new Map<string, Promise<Record<Mode, string>>>();

const passwords = (t: Tenant) => {
  let c = creds.get(t.id);
  if (!c) {
    c = open(t.encPassword, t.encDataKey).then((s) => JSON.parse(s) as Record<Mode, string>);
    creds.set(t.id, c);
  }
  return c;
};

const connInfo = async (t: Tenant, mode: Mode) => ({
  host: t.dbHost,
  port: t.dbPort,
  database: t.dbName,
  user: mode === 'ro' ? t.dbRoUser : t.dbUser,
  password: (await passwords(t))[mode],
});

/** One pg.Pool per (tenant, mode). Agents and MCP use the `ro` role; credentials are decrypted once per tenant. */
export async function getPool(tenant: Tenant, mode: Mode): Promise<pg.Pool> {
  const key = `${tenant.id}:${mode}`;
  let entry = pools.get(key);
  if (!entry) {
    const pool = new pg.Pool({
      ...(await connInfo(tenant, mode)),
      max: config.poolMax,
      idleTimeoutMillis: config.poolIdleMs,
      application_name: `gateway-${tenant.id}`,
    });
    pool.on('error', () => undefined); // idle-client errors must not crash the process
    entry = pools.get(key) ?? { tenant: tenant.id, pool };
    pools.set(key, entry);
  }
  return entry.pool;
}

/** Acquire with a bounded wait queue: shed instead of queueing without limit. */
export async function acquire(pool: pg.Pool): Promise<pg.PoolClient> {
  if (pool.totalCount >= config.poolMax && pool.waitingCount >= config.poolQueueMax) {
    throw new GatewayError('POOL_SATURATED', 'tenant connection pool queue is full', { retryAfterSec: 1 });
  }
  return pool.connect();
}

/** Cancel a running backend over a one-off connection, so a saturated pool cannot block the cancel. */
export async function cancelBackend(tenant: Tenant, mode: Mode, pid: number): Promise<void> {
  const c = new pg.Client(await connInfo(tenant, mode));
  await c.connect();
  try {
    await c.query('select pg_cancel_backend($1)', [pid]);
  } finally {
    await c.end();
  }
}

export function poolUsage(): Record<string, { inUse: number; waiting: number; total: number }> {
  const out: Record<string, { inUse: number; waiting: number; total: number }> = {};
  for (const { tenant, pool } of pools.values()) {
    const cur = out[tenant] ?? { inUse: 0, waiting: 0, total: 0 };
    out[tenant] = {
      inUse: cur.inUse + pool.totalCount - pool.idleCount,
      waiting: cur.waiting + pool.waitingCount,
      total: cur.total + pool.totalCount,
    };
  }
  return out;
}
