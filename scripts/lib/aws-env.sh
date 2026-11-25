#!/usr/bin/env bash
# Shared environment for the AWS scripts. Source it; never run it. Always the project profile and region.
export AWS_PROFILE=pg-agent-gateway-deployer
export AWS_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
export AWS_PAGER=""
export MSYS_NO_PATHCONV=1 # Git Bash must not rewrite ARNs or /paths passed to the AWS CLI

TOOLKIT_STACK=CDKToolkit-pg-agent-gateway
QUALIFIER=pgagw
CLUSTER=pgagw

# Redact 12-digit account IDs from anything that is saved as proof.
redact() { sed -E 's/[0-9]{12}/<ACCOUNT_ID>/g'; }

# Output value of the PgagwService stack.
svc_out() {
  aws cloudformation describe-stacks --stack-name PgagwService \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text | tr -d '\r'
}

# Put weights on the ALB listener: set_weights <stable> <canary>
set_weights() {
  local stable_tg canary_tg listener
  stable_tg=$(svc_out StableTgArn); canary_tg=$(svc_out CanaryTgArn); listener=$(svc_out ListenerArn)
  aws elbv2 modify-listener --listener-arn "$listener" --default-actions \
    "Type=forward,ForwardConfig={TargetGroups=[{TargetGroupArn=$stable_tg,Weight=$1},{TargetGroupArn=$canary_tg,Weight=$2}]}" >/dev/null
  echo "$(date -u +%H:%M:%S) ALB weights: stable=$1 canary=$2"
}
