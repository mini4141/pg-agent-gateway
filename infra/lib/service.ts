import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { CanaryRouting } from './canary.js';
import type { DataStack } from './data.js';
import type { BaseStack } from './network.js';

const ADOT_CONFIG = `
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  awsxray:
    region: ap-southeast-2
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [awsxray]
`;

interface Props extends StackProps {
  base: BaseStack;
  data: DataStack;
  stableTag: string;
}

/** ECS Fargate: gateway-stable, gateway-canary, a Redis service (Service Connect), the ALB and CloudWatch. */
export class ServiceStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { base, data, stableTag } = props;

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: base.vpc,
      clusterName: 'pgagw',
      defaultCloudMapNamespace: { name: 'pgagw.local', useForServiceConnect: true },
    });

    const logGroup = (name: string) =>
      new logs.LogGroup(this, `Logs${name}`, {
        logGroupName: `/pgagw/${name.toLowerCase()}`,
        retention: logs.RetentionDays.ONE_DAY,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    const placement = { assignPublicIp: true, vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, securityGroups: [base.appSg] };

    // ---- Redis (token bucket + semaphore), reached as redis:6379 through Service Connect
    const redisTd = new ecs.FargateTaskDefinition(this, 'RedisTd', { cpu: 256, memoryLimitMiB: 512 });
    redisTd.addContainer('redis', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/redis:7.4-alpine'),
      command: ['redis-server', '--save', '', '--appendonly', 'no'],
      portMappings: [{ containerPort: 6379, name: 'redis' }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'redis', logGroup: logGroup('Redis') }),
    });
    const redis = new ecs.FargateService(this, 'Redis', { cluster, serviceName: 'redis', taskDefinition: redisTd, desiredCount: 1, minHealthyPercent: 0, maxHealthyPercent: 100, circuitBreaker: { rollback: true }, ...placement });
    redis.enableServiceConnect({ services: [{ portMappingName: 'redis', dnsName: 'redis', port: 6379 }] });

    // ---- Gateway task definition (one per track: same image, different Track and, for drills, FAULT)
    const gatewayEnv = (track: string): Record<string, string> => ({
      PORT: '8080',
      REDIS_URL: 'redis://redis:6379',
      DB_HOST: data.db.dbInstanceEndpointAddress,
      SECRETS_BACKEND: 'aws',
      KMS_KEY_ID: base.key.keyArn,
      AWS_REGION: this.region,
      PGSSLMODE: 'no-verify', // RDS enforces TLS; the in-VPC endpoint is not validated against the RDS CA bundle
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      TRACE_SAMPLE_RATIO: '1',
      EMF_ENABLED: 'true',
      GATEWAY_TRACK: track,
    });

    const gatewayTd = (track: 'stable' | 'canary') => {
      const td = new ecs.FargateTaskDefinition(this, `Td${track}`, { cpu: 512, memoryLimitMiB: 1024, family: `gateway-${track}` });
      td.addContainer('gateway', {
        image: ecs.ContainerImage.fromEcrRepository(base.repo, stableTag),
        portMappings: [{ containerPort: 8080 }],
        environment: gatewayEnv(track),
        secrets: { CONTROL_DB_PASSWORD: ecs.Secret.fromSecretsManager(data.controlPassword) },
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: track, logGroup: logGroup(`Gateway${track}`) }),
      });
      // ADOT collector sidecar: receives OTLP from the gateway and exports to X-Ray. Non-essential.
      td.addContainer('adot', {
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-observability/aws-otel-collector:v0.43.1'),
        essential: false,
        environment: { AOT_CONFIG_CONTENT: ADOT_CONFIG },
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: `${track}-adot`, logGroup: logGroup(`Adot${track}`) }),
      });
      td.taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'));
      base.key.grantEncryptDecrypt(td.taskRole);
      td.taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:GetSecretValue', 'secretsmanager:TagResource'],
          resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:pgagw/branches/*`],
        }),
      );
      return td;
    };

    const routing = new CanaryRouting(this, 'Routing', { vpc: base.vpc, albSg: base.albSg });
    const gatewayService = (track: 'stable' | 'canary', tg: CanaryRouting['stableTg']) => {
      const svc = new ecs.FargateService(this, `Gateway${track}`, {
        cluster,
        serviceName: `gateway-${track}`,
        taskDefinition: gatewayTd(track),
        desiredCount: 1,
        healthCheckGracePeriod: Duration.seconds(60),
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { rollback: true },
        ...placement,
      });
      svc.enableServiceConnect();
      svc.attachToApplicationTargetGroup(tg);
      svc.node.addDependency(redis);
      return svc;
    };
    gatewayService('stable', routing.stableTg);
    gatewayService('canary', routing.canaryTg);

    // ---- One-off task: create DBs/roles, load sample data, seed tenants and demo keys (run by scripts/deploy.sh)
    const initTd = new ecs.FargateTaskDefinition(this, 'InitTd', { cpu: 256, memoryLimitMiB: 512, family: 'gateway-init-db' });
    initTd.addContainer('init-db', {
      image: ecs.ContainerImage.fromEcrRepository(base.repo, stableTag),
      command: ['node', 'dist/cli/init-db.js'],
      environment: {
        DB_HOST: data.db.dbInstanceEndpointAddress,
        SECRETS_BACKEND: 'aws',
        KMS_KEY_ID: base.key.keyArn,
        AWS_REGION: this.region,
        PGSSLMODE: 'no-verify',
        SEED_KEY_PREFIX: 'set-at-run-time',
      },
      secrets: {
        ADMIN_DB_USER: ecs.Secret.fromSecretsManager(data.db.secret!, 'username'),
        ADMIN_DB_PASSWORD: ecs.Secret.fromSecretsManager(data.db.secret!, 'password'),
        CONTROL_DB_PASSWORD: ecs.Secret.fromSecretsManager(data.controlPassword),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'init', logGroup: logGroup('Init') }),
    });
    base.key.grantEncryptDecrypt(initTd.taskRole);

    // ---- CloudWatch dashboard (EMF metrics emitted by the gateway, plus ALB)
    const track = (metricName: string, stat: string, t: string) =>
      new cloudwatch.Metric({ namespace: 'PgAgentGateway', metricName, dimensionsMap: { Track: t }, statistic: stat, period: Duration.minutes(1), label: `${t} ${metricName}` });
    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'pg-agent-gateway',
      widgets: [
        [
          new cloudwatch.GraphWidget({ title: 'Requests per minute by track', left: [track('Requests', 'Sum', 'stable'), track('Requests', 'Sum', 'canary')], width: 12 }),
          new cloudwatch.GraphWidget({ title: 'Latency p95 (ms) by track', left: [track('LatencyMs', 'p95', 'stable'), track('LatencyMs', 'p95', 'canary')], width: 12 }),
        ],
        [
          new cloudwatch.GraphWidget({ title: '5xx per minute by track (canary-5xx alarm)', left: [track('Errors5xx', 'Sum', 'stable'), track('Errors5xx', 'Sum', 'canary')], leftAnnotations: [routing.alarm.toAnnotation()], width: 12 }),
          new cloudwatch.GraphWidget({ title: 'ALB target response time', left: [routing.alb.metrics.targetResponseTime()], width: 12 }),
        ],
      ],
    });

    const out = (name: string, value: string) => new CfnOutput(this, name, { value });
    out('AlbDns', routing.alb.loadBalancerDnsName);
    out('ListenerArn', routing.listener.listenerArn);
    out('StableTgArn', routing.stableTg.targetGroupArn);
    out('CanaryTgArn', routing.canaryTg.targetGroupArn);
    out('ClusterName', cluster.clusterName);
    out('InitTaskDefFamily', 'gateway-init-db');
    out('PublicSubnets', base.vpc.publicSubnets.map((s) => s.subnetId).join(','));
    out('AppSecurityGroup', base.appSg.securityGroupId);
    out('RepoUri', base.repo.repositoryUri);
    out('KmsKeyId', base.key.keyId);
    out('DbEndpoint', data.db.dbInstanceEndpointAddress);
  }
}
