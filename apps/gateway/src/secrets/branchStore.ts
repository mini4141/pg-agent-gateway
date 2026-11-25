import { CreateSecretCommand, GetSecretValueCommand, PutSecretValueCommand, ResourceExistsException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { config } from '../config.js';
import { control } from '../db/control.js';
import { open, seal } from './crypto.js';

export interface BranchPayload {
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

const sm = () => new SecretsManagerClient({ region: config.awsRegion });
const secretName = (project: string, branch: string) => `pgagw/branches/${project}/${branch}`;

/** Local: secrets are envelope-encrypted into branches.enc_secrets. AWS: they live in Secrets Manager (KMS-encrypted). */
export async function putBranch(project: string, branch: string, payload: BranchPayload) {
  let enc: Buffer | null = null;
  let wrapped: Buffer | null = null;
  if (config.secretsBackend === 'aws') {
    const client = sm();
    const SecretString = JSON.stringify(payload.secrets);
    try {
      await client.send(
        new CreateSecretCommand({
          Name: secretName(project, branch),
          SecretString,
          KmsKeyId: config.kmsKeyId,
          Tags: [
            { Key: 'Project', Value: 'pg-agent-gateway' },
            { Key: 'Ephemeral', Value: 'true' },
            { Key: 'ManagedBy', Value: 'gateway' },
            { Key: 'Owner', Value: 'alvieirvansyah' },
          ],
        }),
      );
    } catch (e) {
      if (!(e instanceof ResourceExistsException)) throw e;
      await client.send(new PutSecretValueCommand({ SecretId: secretName(project, branch), SecretString }));
    }
  } else {
    const sealed = await seal(JSON.stringify(payload.secrets));
    enc = sealed.blob;
    wrapped = sealed.wrappedKey;
  }
  await control.query(
    `insert into branches (project, branch, config, enc_secrets, enc_data_key, updated_at) values ($1,$2,$3,$4,$5, now())
     on conflict (project, branch) do update set config = $3, enc_secrets = $4, enc_data_key = $5, updated_at = now()`,
    [project, branch, payload.config, enc, wrapped],
  );
}

export async function getBranch(project: string, branch: string): Promise<BranchPayload | undefined> {
  const r = await control.query('select config, enc_secrets, enc_data_key from branches where project=$1 and branch=$2', [project, branch]);
  const row = r.rows[0];
  if (!row) return undefined;
  let secrets: Record<string, unknown>;
  if (config.secretsBackend === 'aws') {
    const v = await sm().send(new GetSecretValueCommand({ SecretId: secretName(project, branch) }));
    secrets = JSON.parse(v.SecretString ?? '{}');
  } else {
    secrets = JSON.parse(await open(row.enc_secrets, row.enc_data_key));
  }
  return { config: row.config, secrets };
}
