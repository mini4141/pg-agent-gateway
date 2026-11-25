const env = process.env;
const int = (name: string, def: number) => (env[name] ? Number(env[name]) : def);

export const config = {
  port: int('PORT', 8080),
  controlDatabaseUrl: env.CONTROL_DATABASE_URL ?? 'postgres://gateway:control-dev-only@localhost:5432/control',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  secretsBackend: (env.SECRETS_BACKEND ?? 'local') as 'local' | 'aws',
  masterKeyFile: env.MASTER_KEY_FILE ?? '.local/dev-master.key',
  kmsKeyId: env.KMS_KEY_ID ?? '',
  awsRegion: env.AWS_REGION ?? 'ap-southeast-2',
  maxResponseBytes: int('MAX_RESPONSE_BYTES', 10 * 1024 * 1024),
  poolMax: int('POOL_MAX', 5),
  poolIdleMs: int('POOL_IDLE_MS', 30_000),
  poolQueueMax: int('POOL_QUEUE_MAX', 10),
  semaphoreWaitMs: int('SEMAPHORE_WAIT_MS', 2000),
  semaphoreQueueMax: int('SEMAPHORE_QUEUE_MAX', 10),
  maxEventLoopDelayMs: int('MAX_EVENT_LOOP_DELAY_MS', 200),
  maxHeapUsedBytes: int('MAX_HEAP_USED_BYTES', 768 * 1024 * 1024),
  fault: env.FAULT ?? '',
  track: env.GATEWAY_TRACK ?? 'local',
  emf: env.EMF_ENABLED === 'true',
  traceSampleRatio: env.TRACE_SAMPLE_RATIO ? Number(env.TRACE_SAMPLE_RATIO) : 0.1,
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
  staticDir: env.STATIC_DIR ?? 'public',
  logLevel: env.LOG_LEVEL ?? 'info',
};

export type CallerType = 'console' | 'mcp' | 'agent';

/** Per-caller-type limits. Agents and MCP are stricter: lower timeout, lower maxRows, read-only. */
export const callerLimits: Record<
  CallerType,
  { defaultMaxRows: number; hardMaxRows: number; defaultTimeoutMs: number; hardTimeoutMs: number; readOnly: boolean }
> = {
  console: { defaultMaxRows: 10_000, hardMaxRows: 1_000_000, defaultTimeoutMs: 30_000, hardTimeoutMs: 60_000, readOnly: false },
  mcp: { defaultMaxRows: 1000, hardMaxRows: 1000, defaultTimeoutMs: 5000, hardTimeoutMs: 5000, readOnly: true },
  agent: { defaultMaxRows: 1000, hardMaxRows: 1000, defaultTimeoutMs: 5000, hardTimeoutMs: 5000, readOnly: true },
};
