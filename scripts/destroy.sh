#!/usr/bin/env bash
# Tear everything down. Idempotent: safe to re-run after a partial failure or when nothing exists.
# Order: stop traffic + scale to 0, empty ECR, delete runtime-created secrets, cdk destroy, toolkit stack + bucket.
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/aws-env.sh

P=proof/phase3-destroy
mkdir -p "$P"
LOG="$P/destroy.log"
exec > >(redact | tee "$LOG") 2>&1

aws sts get-caller-identity --query Arn --output text || { echo "AWS credentials not usable" >&2; exit 1; }
stack_exists() { aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1; }

echo "== 1. canary weight to 0, scale services to 0"
if stack_exists PgagwService; then
  set_weights 100 0 || true
  for svc in gateway-canary gateway-stable redis; do
    aws ecs update-service --cluster "$CLUSTER" --service "$svc" --desired-count 0 >/dev/null 2>&1 && echo "scaled $svc to 0"
  done
fi

echo "== 2. empty ECR repositories"
for repo in $(aws ecr describe-repositories --query "repositories[?starts_with(repositoryName,'pg-agent-gateway') || starts_with(repositoryName,'cdk-$QUALIFIER')].repositoryName" --output text 2>/dev/null | tr -d '\r'); do
  ids=$(aws ecr list-images --repository-name "$repo" --query 'imageIds[*]' --output json)
  [ "$ids" != "[]" ] && aws ecr batch-delete-image --repository-name "$repo" --image-ids "$ids" >/dev/null && echo "emptied $repo"
done

echo "== 3. delete secrets the gateway created at runtime (pgagw/branches/*)"
for s in $(aws secretsmanager list-secrets --filters Key=name,Values=pgagw/branches/ --query 'SecretList[].ARN' --output text 2>/dev/null | tr -d '\r'); do
  aws secretsmanager delete-secret --secret-id "$s" --force-delete-without-recovery >/dev/null && echo "deleted secret ${s##*:secret:}"
done

echo "== 4. cdk destroy --all --force"
(cd infra && npx cdk destroy --all --force)

echo "== 5. toolkit stack $TOOLKIT_STACK and its staging bucket"
BUCKET=$(aws cloudformation describe-stack-resources --stack-name "$TOOLKIT_STACK" --query "StackResources[?LogicalResourceId=='StagingBucket'].PhysicalResourceId" --output text 2>/dev/null | tr -d '\r')
[ -z "$BUCKET" ] && BUCKET=$(aws s3api list-buckets --query "Buckets[?starts_with(Name,'cdk-$QUALIFIER-assets')].Name" --output text 2>/dev/null | tr -d '\r')
if stack_exists "$TOOLKIT_STACK"; then
  for repo in $(aws ecr describe-repositories --query "repositories[?starts_with(repositoryName,'cdk-$QUALIFIER')].repositoryName" --output text 2>/dev/null | tr -d '\r'); do
    ids=$(aws ecr list-images --repository-name "$repo" --query 'imageIds[*]' --output json)
    [ "$ids" != "[]" ] && aws ecr batch-delete-image --repository-name "$repo" --image-ids "$ids" >/dev/null
  done
  [ -n "$BUCKET" ] && node scripts/lib/empty-bucket.mjs "$BUCKET"
  aws cloudformation delete-stack --stack-name "$TOOLKIT_STACK"
  aws cloudformation wait stack-delete-complete --stack-name "$TOOLKIT_STACK" && echo "toolkit stack deleted"
fi
# The bootstrap bucket is retained by CloudFormation: remove it explicitly.
if [ -n "$BUCKET" ] && aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  node scripts/lib/empty-bucket.mjs "$BUCKET"
  aws s3api delete-bucket --bucket "$BUCKET" && echo "deleted bucket $BUCKET"
fi

echo "== 6. KMS key"
echo "The key is scheduled for deletion by cdk destroy (7-day minimum window): it stays in PendingDeletion and is not billed once scheduled."
aws kms describe-key --key-id alias/pgagw --query 'KeyMetadata.KeyState' --output text 2>/dev/null || echo "alias removed; see verify-destroyed.sh for the key state"

docker logout "$(aws sts get-caller-identity --query Account --output text | tr -d '\r').dkr.ecr.$AWS_REGION.amazonaws.com" >/dev/null 2>&1 || true
echo "destroy finished"
