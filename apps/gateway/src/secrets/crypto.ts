import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { config } from '../config.js';

/** Envelope encryption: a fresh data key per secret, itself wrapped by the master key (file locally, KMS on AWS). */
interface KeyProvider {
  newDataKey(): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

function aesGcmEncrypt(key: Buffer, data: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function aesGcmDecrypt(key: Buffer, blob: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

function localProvider(): KeyProvider {
  const master = Buffer.from(readFileSync(config.masterKeyFile, 'utf8').trim(), 'base64');
  if (master.length !== 32) throw new Error('master key must be 32 bytes (base64)');
  return {
    async newDataKey() {
      const plaintext = randomBytes(32);
      return { plaintext, wrapped: aesGcmEncrypt(master, plaintext) };
    },
    async unwrap(wrapped) {
      return aesGcmDecrypt(master, wrapped);
    },
  };
}

function kmsProvider(): KeyProvider {
  const kms = new KMSClient({ region: config.awsRegion });
  return {
    async newDataKey() {
      const r = await kms.send(new GenerateDataKeyCommand({ KeyId: config.kmsKeyId, KeySpec: 'AES_256' }));
      return { plaintext: Buffer.from(r.Plaintext!), wrapped: Buffer.from(r.CiphertextBlob!) };
    },
    async unwrap(wrapped) {
      const r = await kms.send(new DecryptCommand({ CiphertextBlob: wrapped, KeyId: config.kmsKeyId }));
      return Buffer.from(r.Plaintext!);
    },
  };
}

let provider: KeyProvider | undefined;
const keys = () => (provider ??= config.secretsBackend === 'aws' ? kmsProvider() : localProvider());

export async function seal(plaintext: string): Promise<{ blob: Buffer; wrappedKey: Buffer }> {
  const { plaintext: dk, wrapped } = await keys().newDataKey();
  return { blob: aesGcmEncrypt(dk, Buffer.from(plaintext, 'utf8')), wrappedKey: wrapped };
}

export async function open(blob: Buffer, wrappedKey: Buffer): Promise<string> {
  const dk = await keys().unwrap(wrappedKey);
  return aesGcmDecrypt(dk, blob).toString('utf8');
}
