import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { BaseStack } from './network.js';

/** One RDS PostgreSQL instance holds the control DB and the three tenant DBs. */
export class DataStack extends Stack {
  readonly db: rds.DatabaseInstance;
  readonly controlPassword: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: StackProps & { base: BaseStack }) {
    super(scope, id, props);
    const { base } = props;

    this.db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      vpc: base.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [base.dbSg],
      credentials: rds.Credentials.fromGeneratedSecret('pgadmin'),
      multiAz: false,
      storageEncrypted: true,
      publiclyAccessible: false,
      backupRetention: Duration.days(0),
      deleteAutomatedBackups: true,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Password of the `gateway` role that owns the control DB (created by the init-db task).
    this.controlPassword = new secretsmanager.Secret(this, 'ControlPassword', {
      description: 'control DB role password',
      generateSecretString: { passwordLength: 24, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
