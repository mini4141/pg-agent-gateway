# Runbook: high 5xx rate (error budget burning)

**Alerts:** `AvailabilityFastBurn` (page: 14.4x burn over 5 m and 1 h), `AvailabilitySlowBurn` (ticket: 6x over 30 m and 6 h). Canary: CloudWatch alarm `canary-5xx`.

## Check
1. Grafana **Gateway SLO** → *5xx per second* by tenant. One tenant or all?
2. Which code? `gw_requests_total{code=~"5.."}`: `500 INTERNAL` (bug), `503 OVERLOADED` (load shedding), `503 POOL_SATURATED` / `QUEUE_TIMEOUT` (tenant saturation).
3. Did a deploy just happen? On AWS compare the `Track=canary` and `Track=stable` metrics in CloudWatch (namespace `PgAgentGateway`).
4. `GET /readyz`: control DB or Redis down gives 503 on every request.
5. Logs for `"statusCode":500` and the `requestId` from a failing response; open that trace.

## Act
- **Bad canary:** `scripts/canary.sh` rolls back automatically on the alarm. If it did not, set weights to stable 100 / canary 0 and scale canary to 0.
- **Redis or control DB down:** restore the dependency; the gateway recovers without restart (clients reconnect).
- **Load shedding (`OVERLOADED`):** scale out the stable service; identify the traffic source with *Requests/s by tenant*.
- **Pool saturation on one tenant:** the tenant's DB is slow; check its long-running queries (`pg_stat_activity`) and lower its concurrency.

## Verify
`gw:error_ratio:rate5m` below 0.5%; both burn-rate alerts resolved.
