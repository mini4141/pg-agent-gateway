import { poolUsage } from '../pg/tenantPools.js';

interface Sample { t: number; ms: number; code: number }
const WINDOW_MS = 10_000;
const samples = new Map<string, Sample[]>();

export function record(tenant: string, ms: number, code: number) {
  const list = samples.get(tenant) ?? [];
  const now = Date.now();
  list.push({ t: now, ms, code });
  while (list.length && list[0]!.t < now - 60_000) list.shift();
  samples.set(tenant, list);
}

/** Per-tenant live numbers over the last 10 s, for the console's /tenants page. Per gateway instance. */
export function snapshot() {
  const now = Date.now();
  const pools = poolUsage();
  return Object.fromEntries(
    [...new Set([...samples.keys(), ...Object.keys(pools)])].sort().map((tenant) => {
      const recent = (samples.get(tenant) ?? []).filter((s) => s.t >= now - WINDOW_MS);
      const sorted = recent.map((s) => s.ms).sort((a, b) => a - b);
      const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]! : 0;
      return [
        tenant,
        {
          rps: +(recent.length / (WINDOW_MS / 1000)).toFixed(1),
          p95Ms: Math.round(p95),
          rateLimited: recent.filter((s) => s.code === 429).length,
          errors5xx: recent.filter((s) => s.code >= 500).length,
          pool: pools[tenant] ?? { inUse: 0, waiting: 0, total: 0 },
        },
      ];
    }),
  );
}
