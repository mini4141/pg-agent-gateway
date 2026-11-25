import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { GatewayError } from '../errors.js';

/** Token bucket. Time comes from Redis (TIME) so every gateway task shares one clock. Returns {allowed, retryAfterMs}. */
export const TOKEN_BUCKET_LUA = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local d = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
if tokens == nil then tokens = cap; ts = now end
tokens = math.min(cap, tokens + (now - ts) * rate / 1000)
local allowed = 0
local retry = 0
if tokens >= cost then tokens = tokens - cost; allowed = 1 else retry = math.ceil((cost - tokens) * 1000 / rate) end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) * 2 + 1000)
return {allowed, retry}
`;

/** Semaphore as a ZSET of holders scored by expiry; expired holders (crashed tasks) are reaped on acquire. */
const SEM_ACQUIRE_LUA = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[1]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
  return 1
end
return 0
`;

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
redis.on('error', () => undefined);

export async function tokenBucket(key: string, capacity: number, ratePerSec: number, cost = 1) {
  const [allowed, retryMs] = (await redis.eval(TOKEN_BUCKET_LUA, 1, key, capacity, ratePerSec, cost)) as [number, number];
  return { allowed: allowed === 1, retryAfterMs: retryMs };
}

const HOLD_TTL_MS = 5 * 60_000;
const waiting = new Map<string, number>();

/** Acquire one of `limit` per-tenant slots. Bounded wait queue; returns a release function. */
export async function acquireSlot(tenant: string, limit: number): Promise<() => Promise<void>> {
  const key = `sem:${tenant}`;
  const token = randomUUID();
  const tryOnce = async () => (await redis.eval(SEM_ACQUIRE_LUA, 1, key, limit, HOLD_TTL_MS, token)) === 1;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await redis.zrem(key, token).catch(() => 0);
  };

  if (await tryOnce()) return release;
  const queued = waiting.get(tenant) ?? 0;
  if (queued >= config.semaphoreQueueMax) {
    throw new GatewayError('CONCURRENCY_LIMIT', 'tenant concurrency limit reached and wait queue is full', { retryAfterSec: 1 });
  }
  waiting.set(tenant, queued + 1);
  try {
    const deadline = Date.now() + config.semaphoreWaitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      if (await tryOnce()) return release;
    }
  } finally {
    waiting.set(tenant, (waiting.get(tenant) ?? 1) - 1);
  }
  throw new GatewayError('QUEUE_TIMEOUT', 'timed out waiting for a tenant concurrency slot', { retryAfterSec: 1 });
}
