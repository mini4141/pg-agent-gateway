# Runbook: slow or stuck queries

**Alert:** `ConsoleLatencySLOBreach` (console p95 above 300 ms for 5 m). Also `gw_cancelled_queries_total` rising.

## Check
1. Grafana → *p95 latency by tenant* and *Queries cancelled*. `reason="timeout"` means callers send queries above their timeout; `client_disconnect` means callers give up first.
2. Trace a slow request: the `query` span is the database; `semaphore_wait` and `pool_acquire` are queueing in the gateway.
3. On the tenant DB: `select pid, state, now() - query_start as age, left(query, 80) from pg_stat_activity where state <> 'idle' order by age desc;` (queries carry a `/* gw:<requestId> */` prefix that maps to a gateway log line).

## Act
- A runaway query that survived: `select pg_cancel_backend(<pid>)`. The gateway already does this at `timeoutMs`; if it did not, check that the cancel connection could authenticate (`cancel failed` warning in logs).
- Missing index or heavy report: ask the tenant to add `LIMIT`/index, or lower `timeoutMs` for that caller type.
- Many waiters at the semaphore: the tenant's queries are slow, not numerous. Do not raise `max_concurrency` before fixing the queries.

## Verify
p95 under 300 ms; no growth in `gw_cancelled_queries_total`.
