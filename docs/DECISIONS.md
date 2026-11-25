# Decisions

One line each: date, decision, reason.

- 2026-11-25 — pnpm workspace monorepo (apps/*, tools/*, infra, tests) — conventional, one lockfile.
- 2026-11-25 — Per-tenant DB roles `<tenant>_rw` / `<tenant>_ro` instead of one shared `tenant_rw` — stronger isolation; agents/MCP use the `_ro` role plus a READ ONLY transaction.
- 2026-11-25 — Console is built with Vite and served by the gateway through `@fastify/static` — one deployable, one ALB target.
- 2026-11-25 — Per-tenant concurrency semaphore lives in Redis (ZSET + Lua) rather than in-process — correct across stable and canary tasks.
- 2026-11-25 — Tenant DB passwords are generated at seed time and stored envelope-encrypted; DB init runs from the gateway image (`init-db` CLI) both locally and as a one-off ECS task — one code path.
- 2026-11-25 — OTel manual spans (no auto-instrumentation) — avoids ESM loader hooks, gives exactly the spans the spec lists.
- 2026-11-25 — Demo API keys are `<SEED_KEY_PREFIX>-<x>-console|agent`, `-mcp`, `-admin`, `-worker`; the prefix is random on AWS — no static credentials on a public ALB.
- 2026-11-26 — Early admission (auth + token bucket) in an `onRequest` hook — cheap rejection path kept the victim tenant under its SLO during a flood.
- 2026-11-26 — Cancels are conditional on a per-request SQL comment tag — a late `pg_cancel_backend` can never hit a reused connection's next query.
- 2026-11-26 — Streams are measured to first row for latency SLOs — long result sets are not latency violations.
- 2026-11-26 — ECS service-linked role created in `deploy.sh` (account-level, idempotent) — first ECS use in a fresh account races it.
- 2026-11-26 — Redis image from `public.ecr.aws/docker/library/redis` — avoids Docker Hub anonymous-pull limits from Fargate.
- 2026-11-26 — Branch secrets created at runtime on AWS (`pgagw/branches/*`) are deleted by `destroy.sh`, not by CDK.
- 2026-11-26 — Tool versions: Node 24.12, pnpm 12.3.4, TypeScript 5.9 (TS 7 skipped for tooling compatibility), AWS CLI 2.42.1, Docker 29.7.
