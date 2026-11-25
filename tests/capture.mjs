// Headless screenshot capture for proof. Usage: node capture.mjs <step> <out.png>
// Steps: console | tenants | grafana | jaeger | docs. Env: GATEWAY_URL, GRAFANA_URL, JAEGER_URL.
import { chromium } from '@playwright/test';

const [step, out] = process.argv.slice(2);
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const GRAFANA = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const JAEGER = process.env.JAEGER_URL ?? 'http://localhost:16686';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript((p) => localStorage.setItem('keyPrefix', p), process.env.SEED_KEY_PREFIX ?? 'dev'); // console demo-key prefix

async function bestTraceId() {
  const res = await fetch(`${JAEGER}/api/traces?service=pg-agent-gateway&tags=${encodeURIComponent('{"tenant":"tenant_b"}')}&limit=50&lookback=1h`);
  const traces = (await res.json()).data;
  // Prefer a trace that shows every pipeline stage.
  const wanted = ['auth', 'ratelimit', 'semaphore_wait', 'pool_acquire', 'query'];
  const full = traces.filter((t) => wanted.every((w) => t.spans.some((s) => s.operationName === w)));
  const pick = (full.length ? full : traces).sort((a, b) => b.spans.length - a.spans.length)[0];
  if (!pick) throw new Error('no traces in Jaeger yet');
  return pick.traceID;
}

switch (step) {
  case 'console':
    await page.goto(`${GATEWAY}/console`);
    await page.getByLabel('tenant').selectOption('tenant_a');
    await page.getByRole('button', { name: 'Run' }).click();
    await page.getByTestId('counter').filter({ hasText: 'done' }).waitFor({ timeout: 60_000 });
    break;
  case 'tenants':
    await page.goto(`${GATEWAY}/tenants`);
    await page.locator('tbody tr').first().waitFor();
    await page.waitForTimeout(2500);
    break;
  case 'grafana':
    await page.setViewportSize({ width: 1600, height: 1250 });
    await page.goto(`${GRAFANA}/d/gateway-slo/gateway-slo?orgId=1&from=now-6m&to=now&kiosk`);
    await page.waitForTimeout(9000);
    break;
  case 'jaeger':
    await page.goto(`${JAEGER}/trace/${await bestTraceId()}`);
    await page.waitForTimeout(4000);
    break;
  case 'docs':
    await page.goto(`${GATEWAY}/docs`);
    await page.getByText('PG Agent Gateway').first().waitFor();
    await page.waitForTimeout(1000);
    break;
  default:
    throw new Error(`unknown step ${step}`);
}
await page.screenshot({ path: out, fullPage: step !== 'jaeger' });
await browser.close();
console.log(`captured ${step} -> ${out}`);
