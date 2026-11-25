import { describe, expect, it } from 'vitest';
import { BASE, keyFor, metric, PREFIX, query } from './client.js';

// One test per behaviour documented in docs/CONTRACT.md. tenant_c is used so load tests on a/b are not disturbed.
const T = 'tenant_c';

describe('CONTRACT.md', () => {
  it('transactions: BEGIN ... COMMIT in one request is committed', async () => {
    const sql = 'create table if not exists contract_tx (id int); delete from contract_tx; begin; insert into contract_tx values (42); commit;';
    expect((await query(T, 'console', { sql })).status).toBe(200);
    const r = await (await query(T, 'console', { sql: 'select count(*)::int as n from contract_tx where id = 42' })).json();
    expect(r.rows[0].n).toBe(1);
  });

  it('multi-statement: last result by default, all with ?multi=all', async () => {
    const last = await (await query(T, 'console', { sql: 'select 1 as a; select 2 as b' })).json();
    expect(last.rows).toEqual([{ b: 2 }]);
    const all = await (await query(T, 'console', { sql: 'select 1 as a; select 2 as b' }, '?multi=all')).json();
    expect(all.results.map((x: { rows: unknown[] }) => x.rows[0])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('timeout: 408 STATEMENT_TIMEOUT and the query is cancelled server-side', async () => {
    const before = await metric('gw_cancelled_queries_total', `tenant="${T}"`);
    const res = await query(T, 'console', { sql: 'select pg_sleep(10)', timeoutMs: 500 });
    expect(res.status).toBe(408);
    expect((await res.json()).error.code).toBe('STATEMENT_TIMEOUT');
    expect(await metric('gw_cancelled_queries_total', `tenant="${T}"`)).toBe(before + 1);
  });

  it('truncation: truncated=true past maxRows', async () => {
    const r = await (await query(T, 'console', { sql: 'select * from generate_series(1, 5000)', maxRows: 100 })).json();
    expect(r).toMatchObject({ rowCount: 100, truncated: true });
  });

  it('streaming: NDJSON rows then a _meta trailer', async () => {
    const text = await (await query(T, 'console', { sql: 'select * from generate_series(1, 1000)', stream: true })).text();
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1001);
    expect(lines.at(-1)).toEqual({ _meta: { rowCount: 1000, truncated: false } });
  });

  it('read-only agents: a write returns 403 READ_ONLY_VIOLATION', async () => {
    const res = await query(T, 'agent', { sql: 'create table agent_must_not (i int)' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('READ_ONLY_VIOLATION');
  });

  it('agent limits: maxRows is clamped to the agent hard limit', async () => {
    const r = await (await query(T, 'agent', { sql: 'select * from generate_series(1, 5000)', maxRows: 100000 })).json();
    expect(r).toMatchObject({ rowCount: 1000, truncated: true });
  });

  it('errors: SQL errors use the documented shape with a requestId', async () => {
    const res = await query(T, 'console', { sql: 'select * from no_such_table' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: 'SQL_ERROR', sqlState: '42P01', requestId: expect.any(String) });
  });

  it('auth: missing key is 401, key for another tenant is 403', async () => {
    const none = await fetch(`${BASE}/v1/tenants/${T}/query`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-caller-type': 'console' }, body: '{"sql":"select 1"}' });
    expect(none.status).toBe(401);
    const wrong = await fetch(`${BASE}/v1/tenants/${T}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-caller-type': 'console', 'x-api-key': keyFor('tenant_a', 'console') },
      body: '{"sql":"select 1"}',
    });
    expect(wrong.status).toBe(403);
  });

  it('rate limit: a burst beyond the tenant limit gets 429 with Retry-After', async () => {
    const burst = await Promise.all(Array.from({ length: 120 }, () => query(T, 'agent', { sql: 'select 1' })));
    const limited = burst.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(Number(limited[0]!.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    await Promise.all(burst.map((r) => r.arrayBuffer()));
  });

  it('branch config: round trip, platform-worker only', async () => {
    const url = `${BASE}/v1/projects/demo/branches/main/config`;
    const worker = { 'content-type': 'application/json', 'x-api-key': `${PREFIX}-worker` };
    const payload = { config: { region: 'ap-southeast-2' }, secrets: { dbPassword: 's3cret' } };
    expect((await fetch(url, { method: 'PUT', headers: worker, body: JSON.stringify(payload) })).status).toBe(204);
    expect(await (await fetch(url, { headers: worker })).json()).toEqual(payload);
    expect((await fetch(url, { headers: { 'x-api-key': keyFor(T, 'console') } })).status).toBe(403);
  });

  it('readiness and OpenAPI: /readyz is ready, /docs/json is OpenAPI 3.1', async () => {
    expect((await fetch(`${BASE}/readyz`)).status).toBe(200);
    expect((await (await fetch(`${BASE}/docs/json`)).json()).openapi).toMatch(/^3\.1/);
  });
});
