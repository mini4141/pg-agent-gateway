/** Tiny HTTP helper shared by contract tests. Runs against GATEWAY_URL (compose locally, the ALB in the cloud). */
export const BASE = process.env.GATEWAY_URL ?? 'http://localhost:8080';
export const PREFIX = process.env.SEED_KEY_PREFIX ?? 'dev';

export type Caller = 'console' | 'agent' | 'mcp';

export interface QueryBody {
  sql: string;
  params?: unknown[];
  maxRows?: number;
  timeoutMs?: number;
  stream?: boolean;
}

export const keyFor = (tenant: string, caller: Caller) => (caller === 'mcp' ? `${PREFIX}-mcp` : `${PREFIX}-${tenant.slice(-1)}-${caller}`);

export function query(tenant: string, caller: Caller, body: QueryBody, qs = '') {
  return fetch(`${BASE}/v1/tenants/${tenant}/query${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': keyFor(tenant, caller), 'x-caller-type': caller },
    body: JSON.stringify(body),
  });
}

export async function metric(name: string, labelFilter = ''): Promise<number> {
  const text = await (await fetch(`${BASE}/metrics`)).text();
  return text
    .split('\n')
    .filter((l) => l.startsWith(name) && l.includes(labelFilter))
    .reduce((sum, l) => sum + Number(l.split(' ').pop()), 0);
}
