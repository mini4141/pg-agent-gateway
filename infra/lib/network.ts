import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';

/** VPC without NAT (tasks run in public subnets with public IPs), security groups, the ECR repo and the KMS key. */
export class BaseStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly albSg: ec2.SecurityGroup;
  readonly appSg: ec2.SecurityGroup;
  readonly dbSg: ec2.SecurityGroup;
  readonly repo: ecr.Repository;
  readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc: this.vpc, description: 'ALB: HTTP from the internet' });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'public HTTP');

    this.appSg = new ec2.SecurityGroup(this, 'AppSg', { vpc: this.vpc, description: 'Gateway and Redis tasks' });
    this.appSg.addIngressRule(this.albSg, ec2.Port.tcp(8080), 'ALB to gateway');
    this.appSg.addIngressRule(this.appSg, ec2.Port.tcp(6379), 'gateway to Redis (Service Connect)');

    // Databases are private: only the app tier may connect.
    this.dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc: this.vpc, description: 'RDS: app tier only' });
    this.dbSg.addIngressRule(this.appSg, ec2.Port.tcp(5432), 'app tier to Postgres');

    this.repo = new ecr.Repository(this, 'Repo', {
      repositoryName: 'pg-agent-gateway',
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    this.key = new kms.Key(this, 'Key', {
      alias: 'alias/pgagw',
      description: 'pg-agent-gateway envelope encryption (tenant credentials, branch secrets)',
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7), // the minimum: the key goes to PendingDeletion on destroy
    });
  }
}
