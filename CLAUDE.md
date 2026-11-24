# CLAUDE.md — pg-agent-gateway

These are the engineering rules for Claude Code on this repository. You work **fully autonomously**. Don't stop to ask the user questions. When something is ambiguous, pick the simplest option that keeps every stack item in §2 covered. Record it in `docs/DECISIONS.md` (one line: date, decision, reason) and keep going. Read `SPECS.md` end to end before writing any code. It is the source of truth for features, architecture and proof.

## 1. Project at a glance

| | |
|---|---|
| Project | PG Agent Gateway: a multi-tenant SQL execution service for dashboards, MCP tools and AI agents |
| Repo | public GitHub repo `pg-agent-gateway`. `origin` is already configured and the default branch is `main` |
| Target role | Backend Software Engineer, reliability-focused (TypeScript/Node.js, Postgres, multi-tenant services, on-call/SLOs) |
| Pitch | A Fastify service runs SQL against many tenants' Postgres databases on behalf of a web console, an MCP server and simulated AI agents. It stays fair under agent-scale load through per-tenant pools, rate limits, statement timeouts, cancellation, streaming and load shedding. It has SLO-grade observability and ships through canary rollouts. |
| Priority | **Breadth of the tech stack beats depth of business logic.** Every technology in §2 must appear in running code and be visible in the proof. Full validation, edge cases and complete domain rules are out of scope. |

## 2. Mandatory tech stack

| Area | Technology |
|---|---|
| Language / runtime | TypeScript (strict), Node.js 24 LTS |
| HTTP | Fastify 5, `@fastify/swagger` (OpenAPI 3.1 contract), `@fastify/under-pressure` (load shedding), `@fastify/static` (console) |
| Postgres client | `pg` (node-postgres) pools per tenant, `pg-query-stream` for streaming NDJSON, `SET LOCAL statement_timeout`, `pg_cancel_backend` on timeout or client disconnect |
| Database | PostgreSQL 17: 3 tenant databases with restricted roles, plus a control DB (tenants, callers, branches) |
| Rate limiting | Redis 7: token bucket per (tenant, caller) in a Lua script, plus a per-tenant concurrency semaphore |
| Observability | pino JSON logs, prom-client metrics (tenant/caller labels with bounded cardinality), OpenTelemetry tracing (OTLP), Prometheus + Grafana + Jaeger locally; SLO recording rules + burn-rate alerts |
| MCP | `@modelcontextprotocol/sdk` MCP server exposing `list_tables`, `describe_table`, `run_sql`, which call the gateway as caller `mcp` |
| Agent traffic | autocannon-based `agent-sim` that generates bursty agent-like traffic and a noisy-neighbour scenario |
| Console | React 19 + Vite + TypeScript SQL console and live tenant metrics page |
| Branch config & secrets | Endpoint that delivers each branch's config + secrets; envelope encryption (local: AES-GCM with a local data key; AWS: Secrets Manager + KMS) |
| Tests | Vitest (unit + contract tests against compose Postgres/Redis), Playwright (console), k6 or autocannon load smoke |
| AWS | ECS Fargate (gateway **stable** + **canary** services, Redis service), ALB with **weighted target groups** for canary/staged rollout, RDS PostgreSQL, Secrets Manager, KMS, CloudWatch (logs, metrics, alarms, dashboard), X-Ray via ADOT collector sidecar, ECR |
| IaC / CI | AWS CDK v2 in TypeScript (`infra/`) · GitHub Actions |

Don't swap an item for an alternative. If a library is unavailable or broken, use the closest equivalent and log the swap in `docs/DECISIONS.md`.

## 3. Environment

- The host is a **Windows 11 PC**. Claude Code's shell is Git Bash, and the container runtime is Docker Desktop (WSL2 backend). Write automation as POSIX `bash` scripts under `scripts/` and use forward-slash paths. Add a `.gitattributes` with `* text=auto eol=lf` so scripts keep LF line endings.
- Prerequisites: Docker Desktop, Node.js 24 LTS + pnpm, AWS CLI v2, AWS CDK CLI (`npx cdk`), k6 (optional; autocannon is the default). If one is missing, install it with `winget` or the official installer and record the version in `docs/DECISIONS.md`.
- The `gh` CLI is logged in to the owner's GitHub account, and AWS CLI v2 is installed.
- Don't use Bitnami charts or images (their free catalogue has been retired). Use official upstream images and charts.

## 4. AWS account rules

- Profile: **`pg-agent-gateway-deployer`**. Always pass it explicitly, either as `--profile pg-agent-gateway-deployer` or by exporting `AWS_PROFILE=pg-agent-gateway-deployer` inside the scripts. Never use the default profile or any other profile.
- Region: **`ap-southeast-2`** for everything except global services such as CloudFront and IAM.
- The profile has `PowerUserAccess` + `IAMFullAccess`. Start Phase 2 with `aws sts get-caller-identity --profile pg-agent-gateway-deployer`. If that fails, stop and write the reason at the top of `PROGRESS.md`.
- Use AWS only. Where a requirement names Azure, GCP or another hyperscaler, use the AWS equivalent stated in `SPECS.md`.
- IaC: AWS CDK v2 (TypeScript). Bootstrap with a **project-specific qualifier and toolkit stack name** (`cdk bootstrap --qualifier pgagw --toolkit-stack-name CDKToolkit-pg-agent-gateway`) and delete that toolkit stack and its bucket in Phase 3. Don't create resources by hand in the console: every cloud resource comes from code in `infra/`. Keep IaC state local and gitignored.
- Tag every resource with `Project=pg-agent-gateway`, `Ephemeral=true`, `ManagedBy=<tool>` and `Owner=alvieirvansyah`.
- Deployment runs **from this PC via scripts** (`scripts/deploy.sh`, `scripts/destroy.sh`). GitHub Actions only builds and tests, and never holds AWS credentials.

## 5. Phases and gates

Work strictly in order. A phase is done only when its proof exists (§8) and its items are ticked in `PROGRESS.md`. Commit and push at the end of every phase.

1. **Phase 0, scaffold.** Set up the repo layout from `SPECS.md` §4. Create `README.md`, `PROGRESS.md` (copy every checklist item from `SPECS.md` §2 and §9–§11 into it), `docs/DECISIONS.md`, `.gitignore`, `.gitattributes`, `.env.example` and the CI workflow.
2. **Phase 1, local.** Build every feature in `SPECS.md` §5. Everything runs on this PC with Docker and local tooling, and makes **no AWS calls**: use the local stand-ins listed in `SPECS.md`. Run the full test suite, then capture proof into `proof/phase1-local/`. Phase 1 counts as "ready for next" only when `scripts/test-all.sh` is green, the CI run on `main` is green, and the proof index is complete.
3. **Phase 2, AWS showcase.** Deploy with `scripts/deploy.sh`, run the smoke/e2e tests against the cloud endpoints and capture proof into `proof/phase2-cloud/`. Keep the stack alive only as long as capturing takes, with a target of **under 2 hours**.
4. **Phase 3, destroy.** Right after capturing, run `scripts/destroy.sh` and then `scripts/verify-destroyed.sh`, and save the output to `proof/phase3-destroy/`. This phase is **mandatory even if Phase 2 partly failed**. Never end a session with cloud resources running.
5. **Phase 4, write-up.** Write `docs/PORTFOLIO.md`. It needs the problem, an architecture diagram (Mermaid), a stack → requirement table, the key screenshots (relative links into `proof/`), what was hard, the approximate AWS cost and how to reproduce. This file becomes a technical page on alvieirvansyah.com.

## 6. Engineering rules

- Keep it simple and conventional: idiomatic layout for each language, small modules, no premature abstraction, no dead code.
- Configure through environment variables, with a committed `.env.example`. Real `.env` files are gitignored.
- **Never commit secrets.** That includes credentials, IaC state, `.terraform/`, `cdk.out/`, kubeconfigs, private keys and certificates. Generate local dev keys and certs into a gitignored `.local/` folder.
- Every HTTP service exposes a health endpoint (`/healthz` or the framework idiom) and logs structured JSON to stdout.
- Pin versions: commit lockfiles and pin container images to at least a minor tag.
- Use one command for each job:
  - `scripts/dev-up.sh` starts everything locally and `scripts/dev-down.sh` stops it.
  - `scripts/seed.sh` loads demo data. Start-up may run it automatically so that demos never start empty.
  - `scripts/test-all.sh` runs every test layer.
  - `scripts/capture-proof.sh <phase>` captures the proof for a phase.
- Keep `README.md` current. It covers what the project is, the architecture diagram, a quickstart, deploy/destroy, a link to `proof/README.md` and `docs/PORTFOLIO.md`, and the CI badge.
- Don't put the hiring company's name anywhere in the repo. Describe the target role generically.
- `docs/AI_USAGE.md`: briefly note how AI coding tools were used and how their output was reviewed and tested.

## 7. Testing rules

- Tests are **shallow by design**: one happy-path test per feature or flow is enough. Don't write exhaustive validation or edge-case tests.
- Required layers: Vitest unit (rate limiter, contract serializer), Vitest contract tests (one per documented behaviour in `docs/CONTRACT.md`), Playwright (console runs a query, sees streamed rows), and a load smoke (noisy-neighbour: tenant B p95 stays under its SLO while tenant A floods).
- `scripts/test-all.sh` runs every local layer and exits non-zero on failure. CI runs every layer that doesn't need the cloud.
- Save test output as files (JUnit XML, an HTML report or a plain log) under the current phase's `proof/.../tests/`.

## 8. Proof rules

Proof is the deliverable. Use this folder layout:

```
proof/
  README.md                 # index: each artifact on one line, with what it proves
  phase1-local/
    screenshots/            # PNG, named NN-what-it-shows.png
    logs/                   # captured service logs and CLI output
    tests/                  # test reports
  phase2-cloud/
    screenshots/  logs/  tests/
    resources.txt           # deployed AWS resources (from IaC outputs / describe calls)
  phase3-destroy/
    verify-destroyed.txt
```

- Capture screenshots with a script (`scripts/capture-proof.sh`, driving Playwright headless), never by hand, so they can be reproduced. The screenshots listed in `SPECS.md` are the minimum.
- There is no AWS console login, so render AWS-side visuals from the CLI. For example, `aws cloudwatch get-metric-widget-image` renders a metrics graph as a PNG. Otherwise save CLI `describe`/`get` output as logs.
- Before saving logs or CLI output, redact 12-digit AWS account IDs (`sed -E 's/[0-9]{12}/<ACCOUNT_ID>/g'`), access keys, tokens, passwords and the deployer's public IP.
- Proof must show the system **working**, with real data flowing through it, and not just "deployed".

## 9. Cost and safety guardrails (AWS)

- Use the smallest viable sizes: RDS `db.t4g.micro` single-AZ 20 GB gp3, Fargate tasks 0.25–0.5 vCPU / 0.5–1 GB, 1 task per service, one ALB, CloudWatch dashboard (≤ 3 free tier).
- **No NAT gateways.** Also no multi-AZ databases, provisioned IOPS, reserved capacity or Savings Plans, Route 53 domains, or Marketplace subscriptions.
- Databases: `deletion_protection = false`, skip the final snapshot and keep backup retention minimal. S3 buckets are force-destroyable and ECR repos force-deletable. CloudWatch log groups get 1-day retention and are created by IaC, so they get destroyed with it.
- Public app endpoints are fine for the showcase. Keep databases private: their security groups admit only the app tier. Don't open SSH or database ports to `0.0.0.0/0` and don't use SSH at all. Use SSM if you need a shell.
- Don't send real emails or SMS, and don't call paid third-party APIs. Anything external is mocked unless `SPECS.md` says otherwise.
- `scripts/destroy.sh` must be idempotent and safe to re-run. It first deletes anything that would block the IaC destroy: set the canary weight to 0 and scale services to 0, empty the ECR repos, then `cdk destroy --all --force`, then delete the `CDKToolkit-pg-agent-gateway` stack and empty+delete its staging bucket.
- `scripts/verify-destroyed.sh` lists anything still tagged `Project=pg-agent-gateway` (`aws resourcegroupstaggingapi get-resources`) and runs the specific checks in `SPECS.md` §11. It exits non-zero if anything billable remains. The tagging API can show resources for a few minutes after deletion, so confirm each hit with a direct describe call before failing.

## 10. Git and CI

- Use Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `infra:`, `chore:`). Commit small and often, and push to `origin main` at least at the end of every phase.
- `.github/workflows/ci.yml` runs build, lint and the cloud-free tests on every push and pull request. Keep it green.
- Never force-push `main`. Never commit build output, dependency folders (`node_modules`, `target`, `bin`, `obj`, `.venv`) or state files.

## 11. Project-specific rules

- **The contract is a first-class artifact.** `docs/CONTRACT.md` states exactly how the service behaves for transactions (`BEGIN … COMMIT` in one request), multi-statement queries (only the last result is returned, or all of them with `?multi=all`), timeouts (HTTP 408, error code `STATEMENT_TIMEOUT`, query cancelled server-side), row truncation (`truncated: true` past `maxRows`), and error shapes. Each behaviour has one contract test.
- Fairness first: every query passes through (1) the caller API-key auth, (2) the Redis token bucket for the (tenant, caller), (3) the per-tenant concurrency semaphore, (4) the per-tenant pool with a bounded queue. If any stage is saturated it returns `429` or `503` with `Retry-After`. Never let one tenant exhaust a shared resource.
- Agent callers (`caller_type=agent|mcp`) run in `READ ONLY` transactions by default with a lower `statement_timeout` and a lower `maxRows`.
- Tenant DB credentials are stored **encrypted** in the control DB (envelope encryption). The data key comes from KMS in AWS and from `.local/dev-master.key` locally. Never log SQL parameters or credentials.
- Metrics labels: `tenant` and `caller_type` only (never raw caller IDs or SQL), so cardinality stays bounded.
- Canary: `scripts/canary.sh <image-tag>` deploys to the canary service, then shifts ALB weights 10% → 50% → 100% with a 3-minute bake at each step. It rolls back automatically if the CloudWatch alarm `canary-5xx` fires. Phase 2 proof must include one successful promotion **and** one rollback, using a deliberately broken image tag (`FAULT=500` env).

## 12. Definition of done

- [ ] Every stack item in §2 is used in running code. Cross-check with the coverage matrix in `SPECS.md` §2 and tick each row in `PROGRESS.md`.
- [ ] Phase 1 proof is complete, and all tests are green locally and in CI.
- [ ] Phase 2 proof is complete: cloud screenshots, a cloud test run and the resource list.
- [ ] Phase 3: everything is destroyed and `verify-destroyed.txt` shows nothing billable left.
- [ ] `docs/PORTFOLIO.md` and `README.md` are written, and everything is committed and pushed.
