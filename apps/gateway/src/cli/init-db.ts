/**
 * Creates the control DB and three tenant DBs with restricted roles, loads sample data and seeds
 * tenants + demo API keys. Idempotent. Runs the same way locally (docker compose run) and on AWS (one-off ECS task).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { hashKey } from '../db/control.js';
import { seal } from '../secrets/crypto.js';

const env = process.env;
const need = (n: string) => env[n] ?? (() => { throw new Error(`${n} is required`); })();

const dbHost = env.DB_HOST ?? 'postgres'; // host the gateway uses to reach tenant DBs
const dbPort = Number(env.DB_PORT ?? 5432);
// Admin connection (superuser locally, rds_superuser on AWS), `postgres` database.
const adminUrl =
  env.ADMIN_DATABASE_URL ??
  `postgres://${encodeURIComponent(need('ADMIN_DB_USER'))}:${encodeURIComponent(need('ADMIN_DB_PASSWORD'))}@${dbHost}:${dbPort}/postgres`;
const controlPassword = need('CONTROL_DB_PASSWORD');
const keyPrefix = env.SEED_KEY_PREFIX ?? 'dev';
const sqlDir = env.DB_SQL_DIR ?? 'db';
const sql = (f: string) => readFileSync(path.join(sqlDir, f), 'utf8');

const tenants = [
  { id: 'tenant_a', rps: 50 },
  { id: 'tenant_b', rps: 100 },
  { id: 'tenant_c', rps: 50 },
];

const q = (ident: string) => `"${ident.replaceAll('"', '""')}"`;
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;

async function withClient<T>(connectionString: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const withDb = (db: string, fn: (c: pg.Client) => Promise<void>) => {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  return withClient(u.toString(), fn);
};

async function ensureRole(c: pg.Client, role: string, password: string) {
  const exists = (await c.query('select 1 from pg_roles where rolname = $1', [role])).rowCount;
  await c.query(`${exists ? 'alter' : 'create'} role ${q(role)} login password ${lit(password)}`);
  await c.query(`grant ${q(role)} to current_user`).catch(() => undefined); // RDS admin must be a member to own databases
}

async function ensureDb(c: pg.Client, db: string, owner: string) {
  if (!(await c.query('select 1 from pg_database where datname = $1', [db])).rowCount) {
    await c.query(`create database ${q(db)} owner ${q(owner)}`);
  }
  await c.query(`revoke connect on database ${q(db)} from public`);
}

const controlUrl = () => {
  const u = new URL(adminUrl);
  u.username = 'gateway';
  u.password = controlPassword;
  u.pathname = '/control';
  return u.toString();
};

async function main() {
  await withDb('postgres', async (c) => {
    await ensureRole(c, 'gateway', controlPassword);
    await ensureDb(c, 'control', 'gateway');
  });
  await withClient(controlUrl(), (c) => c.query(sql('control.sql')).then(() => undefined));

  for (const t of tenants) {
    const known = await withClient(controlUrl(), async (c) => (await c.query('select 1 from tenants where id = $1', [t.id])).rowCount);
    if (known) continue; // already provisioned: keep passwords stable for running gateways
    const rw = `${t.id}_rw`;
    const ro = `${t.id}_ro`;
    const pw = { rw: randomBytes(18).toString('base64url'), ro: randomBytes(18).toString('base64url') };

    await withDb('postgres', async (c) => {
      await ensureRole(c, rw, pw.rw);
      await ensureRole(c, ro, pw.ro);
      await c.query(`alter role ${q(ro)} set default_transaction_read_only = on`);
      await ensureDb(c, t.id, rw);
      await c.query(`grant connect on database ${q(t.id)} to ${q(rw)}, ${q(ro)}`);
    });
    await withDb(t.id, async (c) => {
      if ((await c.query("select to_regclass('public.customers') as t")).rows[0].t) return;
      await c.query(`set role ${q(rw)}`);
      await c.query(sql('tenant.sql').replaceAll('__TENANT__', t.id));
      await c.query('reset role');
      await c.query(`grant usage on schema public to ${q(ro)}`);
      await c.query(`grant select on all tables in schema public to ${q(ro)}`);
    });

    const { blob, wrappedKey } = await seal(JSON.stringify(pw));
    await withClient(controlUrl(), (c) =>
      c.query(
        `insert into tenants (id, name, db_host, db_port, db_name, db_user, db_ro_user, enc_password, enc_data_key, rate_limit_rps, max_concurrency)
         values ($1,$1,$2,$3,$1,$4,$5,$6,$7,$8,5)`,
        [t.id, dbHost, dbPort, rw, ro, blob, wrappedKey, t.rps],
      ),
    );
  }

  const callers: [string | null, string, string, string][] = [
    ...tenants.flatMap((t) => [
      [t.id, 'console', 'user', `${keyPrefix}-${t.id.slice(-1)}-console`],
      [t.id, 'agent', 'user', `${keyPrefix}-${t.id.slice(-1)}-agent`],
    ] as [string, string, string, string][]),
    [null, 'mcp', 'user', `${keyPrefix}-mcp`],
    [null, 'admin', 'admin', `${keyPrefix}-admin`],
    [null, 'worker', 'platform-worker', `${keyPrefix}-worker`],
  ];
  await withClient(controlUrl(), async (c) => {
    for (const [tenant, type, role, key] of callers) {
      await c.query('insert into callers (tenant_id, type, role, api_key_hash) values ($1,$2,$3,$4) on conflict (api_key_hash) do nothing', [tenant, type, role, hashKey(key)]);
    }
  });
  console.log(JSON.stringify({ msg: 'init-db complete', tenants: tenants.map((t) => t.id), keyPrefix }));
}

await main();
