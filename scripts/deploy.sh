#!/usr/bin/env bash
# Deploy to AWS from this PC: bootstrap, CDK deploy, images, DB init, smoke test, then the two canary drills
# (a good tag that is promoted, a FAULT=500 tag that is rolled back). Logs go to proof/phase2-cloud/logs.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/aws-env.sh

P=proof/phase2-cloud
mkdir -p "$P/logs" "$P/tests" "$P/screenshots" .local

aws sts get-caller-identity --query Arn --output text | redact
ACCOUNT=$(aws sts get-caller-identity --query Account --output text | tr -d '\r')

# Random demo-key prefix: no static credentials on a public ALB. Kept only in the gitignored .local/.
[ -f .local/cloud-key-prefix ] || echo "k$(node -e "process.stdout.write(require('node:crypto').randomBytes(5).toString('hex'))")" > .local/cloud-key-prefix
PREFIX=$(cat .local/cloud-key-prefix)

cd infra
{
  echo "== cdk bootstrap (qualifier $QUALIFIER, toolkit stack $TOOLKIT_STACK)"
  npx cdk bootstrap "aws://$ACCOUNT/$AWS_REGION" --qualifier "$QUALIFIER" --toolkit-stack-name "$TOOLKIT_STACK" \
    --tags Project=pg-agent-gateway --tags Ephemeral=true --tags ManagedBy=cdk --tags Owner=alvieirvansyah
  echo "== cdk deploy PgagwBase (VPC, ECR, KMS)"
  npx cdk deploy PgagwBase --require-approval never
} 2>&1 | redact | tee "../$P/logs/cdk-deploy.log"
cd ..

echo "== build and push images" 2>&1 | tee -a "$P/logs/cdk-deploy.log"
scripts/push-images.sh 2>&1 | redact | tee -a "$P/logs/cdk-deploy.log"

cd infra
{
  echo "== cdk deploy PgagwData PgagwService (RDS, ECS, ALB, CloudWatch)"
  npx cdk deploy PgagwData PgagwService --require-approval never -c stableTag=good
} 2>&1 | redact | tee -a "../$P/logs/cdk-deploy.log"
cd ..

echo "== DB init: one-off ECS task"
SUBNETS=$(svc_out PublicSubnets); SG=$(svc_out AppSecurityGroup)
TASK=$(aws ecs run-task --cluster "$CLUSTER" --task-definition gateway-init-db --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"init-db\",\"environment\":[{\"name\":\"SEED_KEY_PREFIX\",\"value\":\"$PREFIX\"}]}]}" \
  --query 'tasks[0].taskArn' --output text | tr -d '\r')
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text | tr -d '\r')
aws logs tail /pgagw/init --since 15m | redact | tee "$P/logs/init-db.log"
[ "$EXIT_CODE" = "0" ] || { echo "init-db task failed (exit $EXIT_CODE)" >&2; exit 1; }

ALB=$(svc_out AlbDns)
echo "== smoke: waiting for http://$ALB/readyz"
for _ in $(seq 1 60); do curl -fsS "http://$ALB/readyz" >/dev/null 2>&1 && break; sleep 5; done
curl -fsS "http://$ALB/readyz"; echo
echo "$ALB" > .local/cloud-alb

echo "== canary drill 1: good tag -> promotion"
scripts/canary.sh good 2>&1 | redact | tee "$P/logs/canary-promote.log"

echo "== canary drill 2: FAULT=500 tag -> automatic rollback"
if scripts/canary.sh bad 2>&1 | redact | tee "$P/logs/canary-rollback.log"; then
  echo "expected the bad tag to be rolled back" >&2; exit 1
fi
grep -q ROLLBACK "$P/logs/canary-rollback.log"

echo "deploy complete: http://$ALB/console (key prefix in .local/cloud-key-prefix)"
