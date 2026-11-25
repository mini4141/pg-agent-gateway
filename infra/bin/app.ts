import { App, Tags } from 'aws-cdk-lib';
import { BaseStack } from '../lib/network.js';
import { DataStack } from '../lib/data.js';
import { ServiceStack } from '../lib/service.js';

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-southeast-2' };

const base = new BaseStack(app, 'PgagwBase', { env });
const data = new DataStack(app, 'PgagwData', { env, base });
new ServiceStack(app, 'PgagwService', {
  env,
  base,
  data,
  stableTag: app.node.tryGetContext('stableTag') ?? 'good',
});

Tags.of(app).add('Project', 'pg-agent-gateway');
Tags.of(app).add('Ephemeral', 'true');
Tags.of(app).add('ManagedBy', 'cdk');
Tags.of(app).add('Owner', 'alvieirvansyah');
