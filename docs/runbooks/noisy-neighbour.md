# Runbook: noisy neighbour (one tenant floods the gateway)

**Alert:** `TenantThrottled` (info). Other tenants' p95 may also page via `ConsoleLatencySLOBreach`.

## What it means
One tenant is sending more than its token-bucket allows. Excess is answered with `429` + `Retry-After`; that is the system working, not an outage. The risk is collateral damage to other tenants.

## Check (2 minutes)
1. Grafana **Gateway SLO** → *429 rate-limited/s by tenant* and *p95 latency by tenant*. Is any other tenant's p95 above 300 ms?
2. `/tenants` page in the console: RPS, 429s and pool usage per tenant.
3. Which stage rejects? Panel *Rejections by stage*: `token_bucket` (rate) vs `semaphore` (concurrency).
4. Logs: `docker compose logs gateway | grep '"tenant":"tenant_a"'` (locally) or the CloudWatch log group; filter on `tenant` and `callerType`.
5. Jaeger/X-Ray: a slow victim request shows where it waited (`semaphore_wait`, `pool_acquire`, `query`).

## Act
- Victims healthy, flooder throttled: no action. Tell the flooding tenant's owner (agents should honour `Retry-After`).
- Victims slow: lower the flooder's `rate_limit_rps` or `max_concurrency` in the control DB (`tenants` table; cached for 10 s), then watch p95 recover.
- Gateway CPU high (event-loop lag, `OVERLOADED` 503s): scale the ECS service out; check that rate limiting runs in `onRequest` (cheap rejection path).

## Verify
Victim p95 back under 300 ms for 10 minutes; flooder's 429 rate steady at (offered − limit).
