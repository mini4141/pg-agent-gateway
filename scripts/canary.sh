#!/usr/bin/env bash
# Staged canary rollout: scripts/canary.sh <image-tag>
#  1. update the canary service to the new image and wait until it is stable and healthy
#  2. shift ALB weights 10 -> 50 -> 100 with a bake (default 3 minutes) at each step, generating traffic
#  3. check the CloudWatch alarm `canary-5xx` throughout
#  4. success: promote the tag to stable and reset weights to 100/0.  alarm: weights back to 100/0 and log ROLLBACK
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/aws-env.sh

TAG="${1:?usage: canary.sh <image-tag>}"
BAKE="${BAKE_SECONDS:-180}"
PREFIX=$(cat .local/cloud-key-prefix)
ALB=$(svc_out AlbDns)
TRAFFIC_PID=""
trap '[ -n "$TRAFFIC_PID" ] && kill "$TRAFFIC_PID" 2>/dev/null || true' EXIT

log() { echo "$(date -u +%H:%M:%S) $*"; }
alarm_state() { aws cloudwatch describe-alarms --alarm-names canary-5xx --query 'MetricAlarms[0].StateValue' --output text | tr -d '\r'; }

wait_targets_healthy() { # wait_targets_healthy <target-group-arn>
  for _ in $(seq 1 36); do
    states=$(aws elbv2 describe-target-health --target-group-arn "$1" --query 'TargetHealthDescriptions[].TargetHealth.State' --output text | tr -d '\r')
    [ -n "$states" ] && [ "$(echo "$states" | tr '\t' '\n' | grep -vc '^healthy$')" = 0 ] && return 0
    sleep 5
  done
  return 1
}

rollback() {
  set_weights 100 0
  stable_td=$(aws ecs describe-services --cluster "$CLUSTER" --services gateway-stable --query 'services[0].taskDefinition' --output text | tr -d '\r')
  aws ecs update-service --cluster "$CLUSTER" --service gateway-canary --task-definition "$stable_td" >/dev/null
  log "ROLLBACK: alarm canary-5xx fired while rolling out tag '$TAG' at $1; weights restored to stable=100 canary=0, canary service reverted to the stable task definition"
  exit 1
}

log "canary rollout of tag '$TAG' started (bake ${BAKE}s per step)"
# A previous rollback leaves the alarm in ALARM until its metric window clears: wait for a clean slate.
for _ in $(seq 1 40); do [ "$(alarm_state)" != "ALARM" ] && break; log "waiting for alarm canary-5xx to clear"; sleep 15; done

td=$(node scripts/lib/taskdef.mjs gateway-canary "$TAG")
aws ecs update-service --cluster "$CLUSTER" --service gateway-canary --task-definition "$td" --force-new-deployment >/dev/null
log "canary service updated to $TAG; waiting for it to become stable"
aws ecs wait services-stable --cluster "$CLUSTER" --services gateway-canary
wait_targets_healthy "$(svc_out CanaryTgArn)" || { log "canary targets never became healthy"; rollback "health check"; }
log "canary healthy"

for pct in 10 50 100; do
  set_weights $((100 - pct)) "$pct"
  node scripts/lib/traffic.mjs "http://$ALB" "$PREFIX" "$BAKE" 20 &
  TRAFFIC_PID=$!
  end=$((SECONDS + BAKE))
  while [ $SECONDS -lt $end ]; do
    sleep 15
    state=$(alarm_state)
    log "step ${pct}%: alarm canary-5xx = $state"
    [ "$state" = "ALARM" ] && rollback "${pct}%"
  done
  wait "$TRAFFIC_PID" || true
  TRAFFIC_PID=""
  [ "$(alarm_state)" = "ALARM" ] && rollback "${pct}% (end of bake)"
  log "step ${pct}% passed"
done

td=$(node scripts/lib/taskdef.mjs gateway-stable "$TAG")
aws ecs update-service --cluster "$CLUSTER" --service gateway-stable --task-definition "$td" --force-new-deployment >/dev/null
aws ecs wait services-stable --cluster "$CLUSTER" --services gateway-stable
wait_targets_healthy "$(svc_out StableTgArn)" || true
set_weights 100 0
log "PROMOTED: tag '$TAG' is now stable; weights stable=100 canary=0"
