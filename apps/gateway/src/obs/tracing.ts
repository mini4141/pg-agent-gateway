import { context, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { config } from '../config.js';

/** OTLP/HTTP tracing: Jaeger locally, an ADOT collector sidecar (-> X-Ray) on AWS. Spans are created manually. */
export function startTracing(): NodeSDK | undefined {
  if (!config.otlpEndpoint) return undefined;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': 'pg-agent-gateway', 'deployment.track': config.track }),
    sampler: new TraceIdRatioBasedSampler(config.traceSampleRatio),
    traceExporter: new OTLPTraceExporter({ url: `${config.otlpEndpoint.replace(/\/$/, '')}/v1/traces` }),
  });
  sdk.start();
  return sdk;
}

const tracer = trace.getTracer('gateway');

export const startRequestSpan = (name: string): Span => tracer.startSpan(name);

/** Run `fn` inside a child span of `parent`. */
export async function span<T>(parent: Span, name: string, fn: () => Promise<T>): Promise<T> {
  const s = tracer.startSpan(name, {}, trace.setSpan(context.active(), parent));
  try {
    return await fn();
  } catch (e) {
    s.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
    throw e;
  } finally {
    s.end();
  }
}
