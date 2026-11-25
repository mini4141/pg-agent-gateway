# Decisions

One line each: date, decision, reason.

- 2026-11-25 — pnpm workspace monorepo (apps/*, tools/*, infra, tests) — conventional, one lockfile.
- 2026-11-25 — Per-tenant DB roles `<tenant>_rw` / `<tenant>_ro` instead of one shared `tenant_rw` — stronger isolation; agents/MCP use the `_ro` role plus a READ ONLY transaction.
- 2026-11-25 — Console is built with Vite and served by the gateway through `@fastify/static` — one deployable, one ALB target.
- 2026-11-25 — Per-tenant concurrency semaphore lives in Redis (ZSET + Lua) rather than in-process — correct across stable and canary tasks.
- 2026-11-25 — Tenant DB passwords are generated at seed time and stored envelope-encrypted; DB init runs from the gateway image (`init-db` CLI) both locally and as a one-off ECS task — one code path.
- 2026-11-25 — OTel manual spans (no auto-instrumentation) — avoids ESM loader hooks, gives exactly the spans the spec lists.
- 2026-11-25 — Demo API keys are `<SEED_KEY_PREFIX>-<x>-console|agent`, `-mcp`, `-admin`, `-worker`; the prefix is random on AWS — no static credentials on a public ALB.
