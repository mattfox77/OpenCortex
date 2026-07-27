import { randomBytes } from 'crypto';
import { hostname } from 'os';
import packageJson from '../package.json';

export interface TraceContext {
  traceId: string;
  parentSpanId: string;
}

type SpanStatus = 'ok' | 'error';

const OTEL_ENDPOINT =
  process.env.OTEL_ENDPOINT ??
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
  '';
const OTEL_SERVICE_NAME =
  process.env.OTEL_SERVICE_NAME ??
  'opencortex-orchestrator';

export function newTraceContext(): TraceContext {
  return {
    traceId: randomHex(16),
    parentSpanId: randomHex(8),
  };
}

export function childTraceContext(context?: TraceContext): TraceContext | undefined {
  if (!context) {
    return undefined;
  }
  return {
    traceId: context.traceId,
    parentSpanId: randomHex(8),
  };
}

export async function withTraceSpan<T>(
  name: string,
  context: TraceContext | undefined,
  attributes: Record<string, string | number | boolean | null | undefined>,
  run: (spanContext: TraceContext | undefined) => Promise<T>,
): Promise<T> {
  const startTimeUnixNano = unixNano();
  const spanId = randomHex(8);
  const spanContext = context
    ? { traceId: context.traceId, parentSpanId: spanId }
    : undefined;
  try {
    const result = await run(spanContext);
    void emitSpan(name, context, spanId, startTimeUnixNano, 'ok', attributes);
    return result;
  } catch (error) {
    void emitSpan(name, context, spanId, startTimeUnixNano, 'error', {
      ...attributes,
      'error.message': error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function emitSpan(
  name: string,
  context: TraceContext | undefined,
  spanId: string,
  startTimeUnixNano: string,
  status: SpanStatus,
  attributes: Record<string, string | number | boolean | null | undefined>,
): Promise<void> {
  if (!OTEL_ENDPOINT || !context) {
    return;
  }

  const endpoint = `${OTEL_ENDPOINT.replace(/\/$/, '')}/v1/traces`;
  const payload = {
    resourceSpans: [{
      resource: {
        attributes: [
          attr('service.name', OTEL_SERVICE_NAME),
          attr('service.version', packageJson.version),
          attr('host.name', hostname()),
        ],
      },
      scopeSpans: [{
        scope: {
          name: 'opencortex-orchestrator',
          version: packageJson.version,
        },
        spans: [{
          traceId: context.traceId,
          spanId,
          parentSpanId: context.parentSpanId,
          name,
          kind: 3,
          startTimeUnixNano,
          endTimeUnixNano: unixNano(),
          status: { code: status === 'ok' ? 1 : 2 },
          attributes: Object.entries(attributes)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => attr(key, value as string | number | boolean)),
        }],
      }],
    }],
  };

  await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

function attr(key: string, value: string | number | boolean): {
  key: string;
  value: { stringValue?: string; intValue?: number; boolValue?: boolean };
} {
  if (typeof value === 'number') {
    return { key, value: { intValue: value } };
  }
  if (typeof value === 'boolean') {
    return { key, value: { boolValue: value } };
  }
  return { key, value: { stringValue: value } };
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function unixNano(): string {
  return String(Date.now() * 1_000_000);
}
