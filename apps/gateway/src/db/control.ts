import { createHash } from 'node:crypto';
import pg from 'pg';
import { config, type CallerType } from '../config.js';

export const control = new pg.Pool({ connectionString: config.controlDatabaseUrl, max: 5, idleTimeoutMillis: 30_000 });

export interface Tenant {
  id: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbRoUser: string;
  encPassword: Buffer;
  encDataKey: Buffer;
  rateLimitRps: number;
  maxConcurrency: number;
}
export interface Caller {
  id: number;
  tenantId: string | null; // null = valid for every tenant (mcp, admin, worker)
  type: CallerType | 'admin' | 'worker';
  role: string;
}

/** Tiny TTL cache so the hot path does not hit the control DB on every request. */
function cached<V>(ttlMs: number, load: (k: string) => Promise<V | undefined>) {
  const m = new Map<string, { v: V | undefined; exp: number }>();
  return async (k: string) => {
    const hit = m.get(k);
    if (hit && hit.exp > Date.now()) return hit.v;
    const v = await load(k);
    m.set(k, { v, exp: Date.now() + ttlMs });
    return v;
  };
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export const getTenant = cached<Tenant>(10_000, async (id) => {
  const r = await control.query(
    `select id, db_host, db_port, db_name, db_user, db_ro_user, enc_password, enc_data_key, rate_limit_rps, max_concurrency
       from tenants where id = $1`,
    [id],
  );
  const t = r.rows[0];
  return (
    t && {
      id: t.id, dbHost: t.db_host, dbPort: t.db_port, dbName: t.db_name, dbUser: t.db_user, dbRoUser: t.db_ro_user,
      encPassword: t.enc_password, encDataKey: t.enc_data_key, rateLimitRps: t.rate_limit_rps, maxConcurrency: t.max_concurrency,
    }
  );
});

export const getCaller = cached<Caller>(30_000, async (apiKey) => {
  const r = await control.query('select id, tenant_id, type, role from callers where api_key_hash = $1', [hashKey(apiKey)]);
  const c = r.rows[0];
  return c && { id: c.id, tenantId: c.tenant_id, type: c.type, role: c.role };
});
