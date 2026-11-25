#!/usr/bin/env bash
# Start the whole local stack (compose) and seed it. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p .local
if [ ! -f .local/dev-master.key ]; then
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" > .local/dev-master.key
  echo "generated .local/dev-master.key"
fi

docker compose up -d --build
scripts/seed.sh

echo "waiting for gateway readiness..."
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:${GATEWAY_PORT:-8080}/readyz >/dev/null 2>&1; then
    echo "ready: console http://localhost:${GATEWAY_PORT:-8080}/console  grafana http://localhost:3000  jaeger http://localhost:16686"
    exit 0
  fi
  sleep 1
done
echo "gateway did not become ready" >&2
docker compose logs --tail 40 gateway >&2
exit 1
