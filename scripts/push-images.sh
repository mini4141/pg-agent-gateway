#!/usr/bin/env bash
# Build the gateway image and push two tags to ECR: `good`, and `bad` (the same image with FAULT=500 baked in,
# used to prove the automatic canary rollback).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/aws-env.sh

ACCOUNT=$(aws sts get-caller-identity --query Account --output text | tr -d '\r')
REGISTRY="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"
REPO="$REGISTRY/pg-agent-gateway"

aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

docker build -t "$REPO:good" .
docker push "$REPO:good"

printf 'FROM %s:good\nENV FAULT=500\n' "$REPO" | docker build -t "$REPO:bad" -
docker push "$REPO:bad"
echo "pushed $REPO:good and $REPO:bad"
