# PROGRESS

Resume from the first unticked item. Phases: 0 scaffold → 1 local → 2 AWS → 3 destroy → 4 write-up.

## Phase status
- [x] Phase 0 scaffold
- [x] Phase 1 local
- [ ] Phase 2 AWS showcase
- [ ] Phase 3 destroy
- [ ] Phase 4 write-up

## Coverage matrix (SPECS §2)
- [x] Run SQL against customers' Postgres for dashboard, MCP and agents (F1–F4)
- [x] Reliable, observable, fair between tenants at agent scale (F5 + noisy-neighbour test)
- [x] Connection reuse, limit/stream large results, isolate and rate-limit tenants
- [x] SLOs + observability: per-tenant/per-caller metrics, alerts, searchable logs (F6)
- [x] Canary and staged rollouts, safe deploys (F8)
- [x] Written contract with callers: transactions, multi-statement, timeouts, errors
- [x] Rate limiting, timeouts, memory limits, graceful degradation
- [x] Branch config and secrets for code-first workflows (F7)
- [x] On-call, runbooks, incidents, postmortems (3 runbooks + postmortem)
- [x] Securing a service that runs SQL for callers

## Stack coverage (CLAUDE §2)
- [x] TypeScript strict / Node 24
- [x] Fastify 5, @fastify/swagger (OpenAPI 3.1), under-pressure, static
- [x] pg pools per tenant, pg-query-stream, SET LOCAL statement_timeout, pg_cancel_backend
- [x] PostgreSQL 17: 3 tenant DBs + control DB
- [x] Redis 7 token bucket (Lua) + concurrency semaphore
- [x] pino, prom-client, OpenTelemetry/OTLP, Prometheus, Grafana, Jaeger, SLO rules + burn-rate alerts
- [x] MCP server (list_tables, describe_table, run_sql)
- [x] autocannon agent-sim with noisy-neighbour scenario
- [x] React 19 + Vite console
- [x] Branch config endpoint + envelope encryption (local AES-GCM; AWS Secrets Manager + KMS)
- [x] Vitest unit + contract, Playwright, load smoke
- [ ] AWS: ECS Fargate stable + canary + Redis, ALB weighted TGs, RDS, Secrets Manager, KMS, CloudWatch, X-Ray/ADOT, ECR
- [ ] AWS CDK v2 + GitHub Actions

## Phase 1 (SPECS §9)
- [x] `tests/`: Vitest JUnit, Playwright report, `agent-sim-report.json`
- [x] `screenshots/01-console-stream.png`
- [x] `screenshots/02-tenants-live.png`
- [x] `screenshots/03-grafana-slo.png`
- [x] `screenshots/04-jaeger-trace.png`
- [x] `screenshots/05-openapi-docs.png`
- [x] `logs/mcp-demo-client.log`
- [x] `logs/timeout-cancel.log` (pg_cancel_backend + 408)
- [x] `logs/alertmanager-webhook.log`
- [x] `docs/postmortems/…-noisy-neighbour.md` written from the drill
- [x] 3 runbooks in `docs/runbooks/`
- [x] `docs/CONTRACT.md` + one contract test per behaviour
- [x] `scripts/test-all.sh` green; CI green on `main` (verify after push); `proof/README.md` complete

## Phase 2 (SPECS §10)
- [ ] `logs/canary-promote.log`
- [ ] `logs/canary-rollback.log`
- [ ] `logs/cdk-deploy.log` (redacted)
- [ ] `resources.txt`
- [ ] `screenshots/01-cloud-console.png`
- [ ] `screenshots/02-cloudwatch-latency.png`
- [ ] `screenshots/03-cloudwatch-5xx-during-rollback.png`
- [ ] `logs/xray-trace-summary.json`
- [ ] `tests/cloud-contract/`

## Phase 3 (SPECS §11)
- [ ] `cdk destroy --all --force`
- [ ] CDKToolkit-pg-agent-gateway and its bucket deleted
- [ ] KMS key scheduled for deletion (PendingDeletion)
- [ ] `proof/phase3-destroy/verify-destroyed.txt` shows nothing billable

## Phase 4
- [ ] `docs/PORTFOLIO.md`
- [ ] `README.md` final; everything committed and pushed

## Definition of done (CLAUDE §12)
- [ ] Every stack item used in running code
- [ ] Phase 1 proof complete; tests green locally and in CI
- [ ] Phase 2 proof complete
- [ ] Phase 3 destroyed and verified
- [ ] PORTFOLIO.md and README.md written, pushed

## Log
- 2026-11-25 Phase 0 started.
