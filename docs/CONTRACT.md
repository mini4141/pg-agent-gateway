# Caller contract

What a caller can rely on. Each numbered behaviour has one contract test in `tests/contract/contract.test.ts`; the machine-readable API is the OpenAPI 3.1 document at `/docs/json` (UI at `/docs`).

## Request

`POST /v1/tenants/:tenant/query`

| Header | Meaning |
|---|---|
| `x-api-key` | Caller key. Stored only as a SHA-256 hash. Valid for one tenant (console, agent) or all (mcp). |
| `x-caller-type` | `console`, `mcp` or `agent`. Must match the key's type, else `403`. |

Body: `{ sql, params?, maxRows?, timeoutMs?, stream? }`. Query string: `?multi=last|all`.

Per caller type (requests above the hard limit are clamped, not rejected):

| | console | mcp / agent |
|---|---|---|
| default / hard `maxRows` | 10 000 / 1 000 000 | 1 000 / 1 000 |
| default / hard `timeoutMs` | 30 000 / 60 000 | 5 000 / 5 000 |
| transaction | read-write | `READ ONLY`, on a read-only DB role |

Streaming requests default `maxRows` to the hard limit.

## Behaviours

1. **Transactions.** Every request runs inside one transaction. `BEGIN … COMMIT` inside the SQL is allowed: the gateway's `BEGIN` ignores the nested one (Postgres warns) and the caller's `COMMIT` commits. A failing statement rolls the whole request back.
2. **Multi-statement.** `select 1; select 2` returns only the last result. `?multi=all` returns `{results:[{rows,fields,rowCount,truncated}…], durationMs}`. Multi-statement SQL cannot take `params` or `stream`.
3. **Timeouts.** A query exceeding `timeoutMs` is cancelled on the server with `pg_cancel_backend` and the response is `408` with code `STATEMENT_TIMEOUT`. A client disconnect cancels the query the same way. `statement_timeout` (`SET LOCAL`, `timeoutMs + 2 s`) is a backstop.
4. **Truncation.** Past `maxRows` the response has `truncated: true` and exactly `maxRows` rows. Streams end with `{"_meta":{"rowCount":N,"truncated":bool}}`.
5. **Streaming.** `stream: true` returns `application/x-ndjson`: one JSON row per line, then the `_meta` trailer. If an error happens after the first row, the last line is `{"_error":{"code","message"}}` because the HTTP status is already sent. Errors before the first row use a normal status.
6. **Read-only callers.** `agent` and `mcp` writes fail with `403 READ_ONLY_VIOLATION`.
7. **Error shape.** Every error is `{ "error": { "code", "message", "requestId", "sqlState"?, "retryAfterSec"? } }`.
8. **Fairness.** Order of stages: auth → Redis token bucket per `(tenant, caller_type)` → per-tenant concurrency semaphore (5 slots, wait queue of 10, 2 s wait) → per-tenant pool (max 5, bounded queue). Saturation answers with `Retry-After`.
9. **Branch config.** `PUT|GET /v1/projects/:p/branches/:b/config` with `{config, secrets}`; secrets are encrypted at rest; only role `platform-worker` may read or write.
10. **Readiness and docs.** `/readyz` checks the control DB and Redis; `/docs/json` is OpenAPI 3.1.

## Errors

| HTTP | code | When | Retry |
|---|---|---|---|
| 400 | `BAD_REQUEST` | invalid body or headers | no |
| 400 | `SQL_ERROR` | Postgres rejected the SQL (`sqlState` set) | no |
| 401 | `UNAUTHORIZED` | missing or unknown key | no |
| 403 | `FORBIDDEN` | wrong tenant, caller type or role | no |
| 403 | `READ_ONLY_VIOLATION` | write by a read-only caller | no |
| 404 | `TENANT_NOT_FOUND` / `NOT_FOUND` | unknown tenant or branch | no |
| 408 | `STATEMENT_TIMEOUT` | query exceeded `timeoutMs`, cancelled | maybe, with a cheaper query |
| 413 | `RESPONSE_TOO_LARGE` | non-stream body above `MAX_RESPONSE_BYTES` | use `stream` or lower `maxRows` |
| 429 | `RATE_LIMITED` | token bucket empty | after `Retry-After` |
| 429 | `CONCURRENCY_LIMIT` | tenant slots busy and wait queue full | after `Retry-After` |
| 503 | `QUEUE_TIMEOUT` | waited 2 s for a tenant slot | after `Retry-After` |
| 503 | `POOL_SATURATED` | tenant pool queue full | after `Retry-After` |
| 503 | `OVERLOADED` | event-loop lag > 200 ms or heap limit (load shedding) | after `Retry-After` |
| 500 | `INTERNAL` | gateway fault | yes, with backoff |

## SLOs

Availability 99.5%: every `5xx` is bad, `429` is not (it is the intended shedding). Latency: p95 under 300 ms for `console` callers; for streamed responses latency is measured to the first row.
