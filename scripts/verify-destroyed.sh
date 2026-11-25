#!/usr/bin/env bash
# Verify nothing billable remains. Exits non-zero if anything does. Output: proof/phase3-destroy/verify-destroyed.txt
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/aws-env.sh

P=proof/phase3-destroy
mkdir -p "$P"
exec > >(redact | tee "$P/verify-destroyed.txt") 2>&1

FAIL=0
check() { # check <label> <count-of-leftovers> [detail]
  if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1: $2 left ${3:-}"; FAIL=1; fi
}
count() { [ -z "$1" ] && echo 0 || echo "$1" | wc -w | tr -d ' '; }
TAGF="Name=tag:Project,Values=pg-agent-gateway"

echo "verify-destroyed $(date -u +%FT%TZ)  region=$AWS_REGION"
aws sts get-caller-identity --query Arn --output text

# Direct describe calls are authoritative: the tagging API can show deleted resources for a few minutes.
check "ECS clusters named $CLUSTER" "$(count "$(aws ecs describe-clusters --clusters $CLUSTER --query "clusters[?status=='ACTIVE'].clusterName" --output text | tr -d '\r')")"
check "load balancers (project tag or name)" "$(count "$(aws elbv2 describe-load-balancers --query "LoadBalancers[?contains(LoadBalancerName,'Pgagw')].LoadBalancerArn" --output text 2>/dev/null | tr -d '\r')")"
check "target groups" "$(count "$(aws elbv2 describe-target-groups --query "TargetGroups[?contains(TargetGroupName,'Pgagw')].TargetGroupArn" --output text 2>/dev/null | tr -d '\r')")"
check "RDS instances" "$(count "$(aws rds describe-db-instances --query "DBInstances[?contains(DBInstanceIdentifier,'pgagw')].DBInstanceIdentifier" --output text | tr -d '\r')")"
check "Secrets Manager secrets (pgagw*, rds db secret, branch secrets)" "$(count "$(aws secretsmanager list-secrets --query "SecretList[?contains(Name,'pgagw') || contains(Name,'Pgagw') || (Tags[?Key=='Project'&&Value=='pg-agent-gateway'])].Name" --output text | tr -d '\r')")"
check "VPCs tagged Project=pg-agent-gateway" "$(count "$(aws ec2 describe-vpcs --filters $TAGF --query 'Vpcs[].VpcId' --output text | tr -d '\r')")"
check "NAT gateways" "$(count "$(aws ec2 describe-nat-gateways --filter $TAGF 'Name=state,Values=pending,available' --query 'NatGateways[].NatGatewayId' --output text | tr -d '\r')")"
check "Elastic IPs" "$(count "$(aws ec2 describe-addresses --filters $TAGF --query 'Addresses[].AllocationId' --output text | tr -d '\r')")"
check "ECR repositories" "$(count "$(aws ecr describe-repositories --query "repositories[?contains(repositoryName,'pg-agent-gateway') || contains(repositoryName,'$QUALIFIER')].repositoryName" --output text 2>/dev/null | tr -d '\r')")"
check "CloudFormation stacks (Pgagw*, $TOOLKIT_STACK)" "$(count "$(aws cloudformation list-stacks --query "StackSummaries[?(starts_with(StackName,'Pgagw') || StackName=='$TOOLKIT_STACK') && StackStatus!='DELETE_COMPLETE'].StackName" --output text | tr -d '\r')")"
check "S3 buckets (cdk-$QUALIFIER-*)" "$(count "$(aws s3api list-buckets --query "Buckets[?starts_with(Name,'cdk-$QUALIFIER')].Name" --output text | tr -d '\r')")"
check "CloudWatch log groups /pgagw/*" "$(count "$(aws logs describe-log-groups --log-group-name-prefix /pgagw/ --query 'logGroups[].logGroupName' --output text | tr -d '\r')")"
check "CloudWatch alarm canary-5xx" "$(count "$(aws cloudwatch describe-alarms --alarm-names canary-5xx --query 'MetricAlarms[].AlarmName' --output text | tr -d '\r')")"
check "CloudWatch dashboards" "$(count "$(aws cloudwatch list-dashboards --dashboard-name-prefix pg-agent-gateway --query 'DashboardEntries[].DashboardName' --output text | tr -d '\r')")"

KEY_STATE=$(aws kms list-aliases --query "Aliases[?AliasName=='alias/pgagw'].TargetKeyId" --output text | tr -d '\r')
if [ -z "$KEY_STATE" ]; then
  # The alias is gone with the stack; find the key by tag and confirm it is PendingDeletion.
  NOT_PENDING=0
  for arn in $(aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=pg-agent-gateway --resource-type-filters kms:key --query 'ResourceTagMappingList[].ResourceARN' --output text | tr -d '\r'); do
    state=$(aws kms describe-key --key-id "$arn" --query 'KeyMetadata.KeyState' --output text 2>/dev/null | tr -d '\r')
    echo "INFO  KMS key ${arn##*/} state=$state"
    [ "$state" = "PendingDeletion" ] || NOT_PENDING=$((NOT_PENDING + 1))
  done
  check "KMS keys not in PendingDeletion" "$NOT_PENDING"
else
  check "KMS alias/pgagw removed" 1
fi

echo "--- tagging API view (informational: can lag a few minutes after deletion)"
aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=pg-agent-gateway --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n'

[ "$FAIL" = 0 ] && echo "RESULT: nothing billable remains" || echo "RESULT: leftovers found"
exit "$FAIL"
