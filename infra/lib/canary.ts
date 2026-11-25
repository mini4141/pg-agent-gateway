import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

/**
 * Public ALB whose listener forwards to two target groups with weights stable 100 / canary 0.
 * scripts/canary.sh shifts the weights (10 -> 50 -> 100) and watches the `canary-5xx` alarm.
 */
export class CanaryRouting extends Construct {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly listener: elbv2.ApplicationListener;
  readonly stableTg: elbv2.ApplicationTargetGroup;
  readonly canaryTg: elbv2.ApplicationTargetGroup;
  readonly alarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: { vpc: ec2.IVpc; albSg: ec2.ISecurityGroup }) {
    super(scope, id);

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const tg = (name: string) =>
      new elbv2.ApplicationTargetGroup(this, name, {
        vpc: props.vpc,
        port: 8080,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: Duration.seconds(5),
        healthCheck: { path: '/healthz', interval: Duration.seconds(10), healthyThresholdCount: 2, unhealthyThresholdCount: 3 },
      });
    this.stableTg = tg('StableTg');
    this.canaryTg = tg('CanaryTg');

    this.listener = this.alb.addListener('Http', { port: 80, open: false });
    this.listener.addAction('Weighted', {
      action: elbv2.ListenerAction.weightedForward([
        { targetGroup: this.stableTg, weight: 100 },
        { targetGroup: this.canaryTg, weight: 0 },
      ]),
    });

    // Gateway emits one EMF line per request with Track=canary|stable (see apps/gateway/src/server.ts).
    this.alarm = new cloudwatch.Alarm(this, 'Canary5xx', {
      alarmName: 'canary-5xx',
      alarmDescription: 'Canary track served 5xx responses: roll back',
      metric: new cloudwatch.Metric({
        namespace: 'PgAgentGateway',
        metricName: 'Errors5xx',
        dimensionsMap: { Track: 'canary' },
        statistic: 'Sum',
        period: Duration.minutes(1),
      }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
