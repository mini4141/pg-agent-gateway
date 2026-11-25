# Postmortem: noisy neighbour drill (tenant_a floods, tenant_b is the victim)

Blameless, written from a planned drill on the local stack (Phase 1). Raw data: `proof/phase1-local/tests/agent-sim-report.json`, `proof/phase1-local/logs/alertmanager-webhook.log`, Grafana screenshot `03-grafana-slo.png`.

## Summary
A simulated agent swarm sent bursty traffic (mean 300 rps, peaks 540 rps) to `tenant_a` for 30 s while `tenant_b` ran a steady 20 rps. Final run: `tenant_a` served 689 requests and was rejected 8 995 times with 429; `tenant_b` served all 600 requests with p95 66 ms (SLO 300 ms) and 0 errors. The `TenantThrottled` alert fired and resolved through Alertmanager. No customer impact in the final design; the findings below were hit while getting there.

## Timeline of the drill (what we saw while building it)
1. First run, rejections done after body parsing and validation: `tenant_b` p95 was 0.8-2.4 s. Server traces showed `ratelimit` and `semaphore_wait` spans stretching, i.e. the gateway event loop was busy rejecting `tenant_a`.
2. Fix 1: admission (auth + token bucket) moved to an `onRequest` hook, before the body is parsed or validated. Rejected requests became cheap. `tenant_b` p95 dropped to 130-200 ms.
3. Fix 2: the load generator itself was a bottleneck (one process, many connections, synchronized bursts). Each tenant's load now runs in its own process with few connections.
4. Fix 3: Redis scripts use `EVALSHA` with auto-pipelining; semaphore wait polls every 10 ms instead of 25 ms; `BEGIN` and `SET LOCAL` share one round trip; 429s are logged at debug, not info.
5. A late `pg_cancel_backend` (from a disconnecting client) once cancelled the next request on the same pooled connection (a spurious 408). Fix: every statement carries a `/* gw:<requestId> */` tag and the cancel only fires while that tagged statement is still active.

## Impact
None in production terms (local drill). In the first designs, the victim tenant's p95 breached the 300 ms SLO during the flood.

## Root causes
- Rejection path did too much work per request (parse, validate, serialize) on a single-threaded event loop shared by all tenants.
- Cancellation by backend pid alone is racy with connection reuse.
- Measurement: a single-process load generator inflated client-side latency; server-side histograms and traces were needed to see the truth.

## What went well
- Per-tenant buckets and the Redis semaphore kept `tenant_a`'s admitted work bounded (about 50 rps, at most 5 concurrent), so Postgres was never the bottleneck.
- Traces with named spans (auth, ratelimit, semaphore_wait, pool_acquire, query) found the problem in minutes.
- The alert fired with a runbook link.

## Action items
| Action | Status |
|---|---|
| Cheap rejection path in `onRequest` | done |
| Tagged, conditional `pg_cancel_backend` | done |
| Keep the noisy-neighbour assertion in `scripts/test-all.sh` (one retry for noisy CI hosts) | done |
| Per-tenant latency SLO alert (today only the console SLO and burn rates alert) | open |
| Scale the stable ECS service out on event-loop lag | open |
