#!/usr/bin/env bash
# Capture proof for a phase. Usage: scripts/capture-proof.sh phase1
# phase1: runs a noisy-neighbour drill against the local stack and records screenshots, logs and reports.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

PHASE="${1:?usage: capture-proof.sh phase1}"
[ "$PHASE" = "phase1" ] || { echo "phase2 proof is captured by scripts/deploy.sh" >&2; exit 2; }

DIR=proof/phase1-local
SHOTS="$DIR/screenshots"; LOGS="$DIR/logs"; TESTS="$DIR/tests"
mkdir -p "$SHOTS" "$LOGS" "$TESTS"
capture() { (cd tests && node capture.mjs "$1" "../$SHOTS/$2"); }
G=http://localhost:8080

curl -fsS $G/readyz >/dev/null || scripts/dev-up.sh
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ) # alert log below only shows this drill

echo "== 05 openapi docs"; capture docs 05-openapi-docs.png

echo "== timeout + cancel (pg_cancel_backend, 408)"
{
  echo "# request: select pg_sleep(10) with timeoutMs=500 as a console caller on tenant_a"
  curl -s -w '\nHTTP %{http_code}\n' -H 'content-type: application/json' -H 'x-caller-type: console' -H 'x-api-key: dev-a-console' \
    $G/v1/tenants/tenant_a/query -d '{"sql":"select pg_sleep(10)","timeoutMs":500}'
  echo "# gateway log lines for that request:"
  sleep 1
  docker compose logs gateway --no-log-prefix --tail 40 | grep -E 'pg_cancel_backend|"statusCode":408' | tail -2
  echo "# metric:"
  curl -s $G/metrics | grep '^gw_cancelled_queries_total'
} | tee "$LOGS/timeout-cancel.log"

echo "== 01 console streams 50k rows"; capture console 01-console-stream.png

echo "== MCP demo client"
(cd apps/mcp-server && GATEWAY_URL=$G npx tsx scripts/demo-client.ts) 2>&1 | tee "$LOGS/mcp-demo-client.log"

echo "== noisy-neighbour assertion run (nothing else running on the machine; up to 3 attempts on a noisy laptop)"
for attempt in 1 2 3; do
  docker compose --profile tools run --rm agent-sim --url http://gateway:8080 --duration 30s     --background-tenant tenant_b --out "/$TESTS/agent-sim-report.json" --assert > "$LOGS/agent-sim.log" 2>&1 && break
  echo "attempt $attempt failed its assertions; retrying"
  [ "$attempt" = 3 ] && { cat "$LOGS/agent-sim.log"; exit 1; }
done
tail -25 "$LOGS/agent-sim.log"

echo "== live drill: tenant_a floods while screenshots are taken (no assertions: the browser competes for CPU)"
docker compose --profile tools run --rm agent-sim --url http://gateway:8080 --duration 40s   --background-tenant tenant_b --out "/$LOGS/agent-sim-during-capture.json" > /dev/null 2>&1 &
SIM=$!
sleep 22
capture tenants 02-tenants-live.png
wait $SIM

echo "== grafana + jaeger + alerts"
capture grafana 03-grafana-slo.png
capture jaeger 04-jaeger-trace.png
sleep 15 # let Alertmanager group_wait elapse
docker compose logs webhook-logger --no-log-prefix --since "$STARTED" | tee "$LOGS/alertmanager-webhook.log"
docker compose logs gateway --no-log-prefix --tail 300 | grep -v '"msg":"request"' | head -40 > "$LOGS/gateway-sample.log" || true
curl -s $G/metrics | grep -E '^gw_(requests_total|ratelimited_total|cancelled_queries_total)' | sort > "$LOGS/metrics-sample.txt"
echo "phase1 proof captured under $DIR"
