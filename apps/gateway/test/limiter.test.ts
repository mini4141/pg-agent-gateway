import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { acquireSlot, redis, tokenBucket } from '../src/pipeline/limiter.js';

afterAll(() => redis.quit());

describe('token bucket (Redis Lua)', () => {
  it('allows N requests, then denies with a retry hint', async () => {
    const key = `test:rl:${randomUUID()}`;
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await tokenBucket(key, 3, 1)); // capacity 3, refill 1/s
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results[3]!.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('tenant semaphore (Redis)', () => {
  it('grants up to the limit and frees a slot on release', async () => {
    const tenant = `test-${randomUUID()}`;
    const a = await acquireSlot(tenant, 1);
    await expect(acquireSlot(tenant, 1)).rejects.toMatchObject({ code: 'QUEUE_TIMEOUT' }); // waits 2 s, then sheds
    await a();
    const b = await acquireSlot(tenant, 1);
    await b();
  }, 10_000);
});
