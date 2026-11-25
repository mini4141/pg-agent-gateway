// Steady background traffic through the ALB during a canary bake, so the canary track has requests to judge.
// Usage: node traffic.mjs <baseUrl> <keyPrefix> <seconds> [rps]
const [base, prefix, seconds, rps = '20'] = process.argv.slice(2);
const end = Date.now() + Number(seconds) * 1000;
const counts = {};
const fire = async () => {
  try {
    const r = await fetch(`${base}/v1/tenants/tenant_c/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-caller-type': 'console', 'x-api-key': `${prefix}-c-console` },
      body: JSON.stringify({ sql: 'select count(*)::int as n from orders where customer_id < 100' }),
    });
    await r.arrayBuffer();
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  } catch {
    counts.error = (counts.error ?? 0) + 1;
  }
};
while (Date.now() < end) {
  void fire();
  await new Promise((r) => setTimeout(r, 1000 / Number(rps)));
}
await new Promise((r) => setTimeout(r, 2000));
console.log(`traffic done: ${JSON.stringify(counts)}`);
