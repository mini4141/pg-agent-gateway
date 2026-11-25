import { config } from './config.js';
import { control } from './db/control.js';
import { startTracing } from './obs/tracing.js';
import { redis } from './pipeline/limiter.js';
import { buildServer } from './server.js';

const sdk = startTracing();
const app = await buildServer();
await app.listen({ port: config.port, host: '0.0.0.0' });

// Graceful shutdown: stop accepting, drain in-flight requests, then close dependencies.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    await Promise.allSettled([control.end(), redis.quit(), sdk?.shutdown()]);
    process.exit(0);
  });
}
