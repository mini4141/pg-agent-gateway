/**
 * agent-sim: bursty agent-like traffic with a noisy-neighbour scenario, built on autocannon.
 *   tsx src/cli.ts --tenant tenant_a --rps 300 --duration 60s --pattern bursty \
 *                  --background-tenant tenant_b --background-rps 20 --out report.json --assert
 * Each tenant's load runs in its own process so the load generator itself never becomes the bottleneck.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import autocannon from 'autocannon';

const { values: v } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8080' },
    prefix: { type: 'string', default: 'dev' },
    tenant: { type: 'string', default: 'tenant_a' },
    rps: { type: 'string', default: '300' },
    duration: { type: 'string', default: '30s' },
    pattern: { type: 'string', default: 'bursty' },
    'background-tenant': { type: 'string' },
    'background-rps': { type: 'string', default: '20' },
    out: { type: 'string', default: 'agent-sim-report.json' },
    assert: { type: 'boolean', default: false },
    'p95-slo-ms': { type: 'string', default: '300' },
    worker: { type: 'string' }, // internal: "tenant:rps:pattern"
  },
});

const duration = Number(v.duration!.replace(/s$/, ''));

// Bursty: 3 s windows alternating 1.8x and 0.2x of the target rate (mean = target). Steady: one constant run.
const BURST = [1.8, 0.2];
const SEGMENT_S = 3;

interface Stats { latencies: number[]; status: Record<string, number>; errors: number }

async function load(tenant: string, rps: number, pattern: string): Promise<Stats> {
  const stats: Stats = { latencies: [], status: {}, errors: 0 };
  const sql = 'select pg_sleep(0.01), count(*)::int as n from orders where customer_id < 200';
  const segmentS = pattern === 'bursty' ? SEGMENT_S : duration;
  for (let i = 0; i < Math.ceil(duration / segmentS); i++) {
    const rate = Math.max(1, Math.round(rps * (pattern === 'bursty' ? BURST[i % BURST.length]! : 1)));
    const inst = (autocannon as unknown as (o: object) => EventEmitter)({
      url: `${v.url}/v1/tenants/${tenant}/query`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-caller-type': 'agent', 'x-api-key': `${v.prefix}-${tenant.slice(-1)}-agent` },
      body: JSON.stringify({ sql }),
      connections: pattern === 'bursty' ? 40 : 4, // few connections: spread arrivals instead of synchronized bursts
      duration: Math.min(segmentS, duration - i * segmentS),
      overallRate: rate,
    });
    inst.on('response', (_c: unknown, code: number, _bytes: number, ms: number) => {
      stats.status[code] = (stats.status[code] ?? 0) + 1;
      stats.latencies.push(ms);
    });
    inst.on('reqError', () => stats.errors++);
    await new Promise<void>((resolve) => inst.on('done', () => resolve()));
  }
  return stats;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)]! : 0;
};

function summarize(tenant: string, s: Stats) {
  const total = s.latencies.length + s.errors;
  const ok = Object.entries(s.status).filter(([c]) => c.startsWith('2')).reduce((n, [, k]) => n + k, 0);
  const throttled = (s.status['429'] ?? 0) + (s.status['503'] ?? 0);
  return {
    tenant,
    requests: total,
    status: s.status,
    ok,
    throttled,
    errorRate: total ? +((total - ok - throttled) / total).toFixed(4) : 0, // failures other than deliberate shedding
    latencyMs: { p50: pct(s.latencies, 0.5), p95: pct(s.latencies, 0.95), p99: pct(s.latencies, 0.99) },
  };
}

function runWorker(tenant: string, rps: string, pattern: string): Promise<Stats> {
  const args = [
    ...process.execArgv, fileURLToPath(import.meta.url),
    '--worker', `${tenant}:${rps}:${pattern}`, '--url', v.url!, '--prefix', v.prefix!, '--duration', v.duration!,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker exited ${code}`))));
  });
}

if (v.worker) {
  const [tenant, rps, pattern] = v.worker.split(':');
  process.stdout.write(JSON.stringify(await load(tenant!, Number(rps), pattern!)));
} else {
  const jobs = [runWorker(v.tenant!, v.rps!, v.pattern!).then((s) => summarize(v.tenant!, s))];
  if (v['background-tenant']) {
    jobs.push(runWorker(v['background-tenant'], v['background-rps']!, 'steady').then((s) => summarize(v['background-tenant']!, s)));
  }
  const [noisy, quiet] = await Promise.all(jobs);

  const slo = Number(v['p95-slo-ms']);
  const checks = {
    noisyTenantThrottled: (noisy!.throttled ?? 0) > 0,
    quietTenantP95UnderSlo: quiet ? quiet.latencyMs.p95 < slo : null,
    quietTenantErrorsUnder1Pct: quiet ? quiet.errorRate < 0.01 : null,
  };
  const report = { startedAt: new Date().toISOString(), options: { ...v, durationSeconds: duration }, noisy, quiet, sloP95Ms: slo, checks };
  writeFileSync(v.out!, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (v.assert && Object.values(checks).some((c) => c === false)) {
    console.error('agent-sim: assertions failed');
    process.exit(1);
  }
}
