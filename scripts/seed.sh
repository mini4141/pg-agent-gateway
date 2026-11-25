#!/usr/bin/env bash
# Create control + tenant databases, roles, sample data and demo API keys. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d postgres redis
docker compose run --rm --no-deps \
  -e ADMIN_DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD:-postgres-dev-only}@postgres:5432/postgres" \
  -e CONTROL_DB_PASSWORD="${CONTROL_DB_PASSWORD:-control-dev-only}" \
  -e SEED_KEY_PREFIX="${SEED_KEY_PREFIX:-dev}" \
  -e DB_HOST=postgres \
  gateway node dist/cli/init-db.js
