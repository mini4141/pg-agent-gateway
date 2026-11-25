#!/usr/bin/env bash
# Run every local test layer against the compose stack. Reports land in proof/phase1-local/tests/.
# Layers: typecheck+lint, unit (Vitest), contract (Vitest), e2e (Playwright), load smoke (agent-sim noisy neighbour).
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1 # Git Bash must not rewrite /proof paths passed to docker

ABS="$(pwd -W 2>/dev/null || pwd)" # Windows-style path: Node on Windows cannot use /c/... paths
OUT="${PROOF_TESTS_DIR:-proof/phase1-local/tests}"
mkdir -p "$OUT"
export GATEWAY_URL="${GATEWAY_URL:-http://localhost:8080}"

if ! curl -fsS "$GATEWAY_URL/readyz" >/dev/null 2>&1; then
  scripts/dev-up.sh
fi

echo "== build + lint"
pnpm build
pnpm lint

echo "== unit (Vitest)"
JUNIT_OUT="$ABS/$OUT/unit-junit.xml" pnpm --filter gateway test

echo "== contract (Vitest)"
JUNIT_OUT="$ABS/$OUT/contract-junit.xml" pnpm --filter tests exec vitest run

echo "== e2e (Playwright)"
PLAYWRIGHT_REPORT="$ABS/$OUT/playwright-report" pnpm --filter tests exec playwright test

echo "== load smoke: noisy neighbour (agent-sim)"
# Shared-CPU laptops and CI runners are noisy: allow one retry; both attempts are kept as reports.
for attempt in 1 2; do
  if docker compose --profile tools run --rm agent-sim --url http://gateway:8080 --duration 25s     --background-tenant tenant_b --out "/${OUT}/agent-sim-report.json" --assert; then
    break
  fi
  [ "$attempt" = 2 ] && { echo "load smoke failed twice" >&2; exit 1; }
  cp "$OUT/agent-sim-report.json" "$OUT/agent-sim-report.attempt1-failed.json"
  echo "retrying load smoke once"
done

echo "ALL TESTS PASSED"
