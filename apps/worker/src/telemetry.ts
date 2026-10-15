import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";

const exporterEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    "service.name": process.env.OTEL_SERVICE_NAME ?? "hookforge-worker",
  }),
  spanProcessors: exporterEndpoint
    ? [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: `${exporterEndpoint.replace(/\/$/, "")}/v1/traces`,
          }),
        ),
      ]
    : [],
});
provider.register();
const tracer = trace.getTracer("hookforge-worker");

export interface TraceCarrier {
  traceparent: string | null;
  tracestate: string | null;
}

export function extractTraceContext(carrier: TraceCarrier): Context {
  if (!carrier.traceparent) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, {
    traceparent: carrier.traceparent,
    ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
  });
}

export function injectTraceHeaders(headers: Record<string, string>): void {
  propagation.inject(context.active(), headers);
}

export function activeTraceIds(): {
  traceId: string | null;
  spanId: string | null;
} {
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan) return { traceId: null, spanId: null };
  const spanContext = activeSpan.spanContext();
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

export async function withSpan<T>(
  name: string,
  callback: (span: Span) => Promise<T>,
  parent: Context = context.active(),
): Promise<T> {
  const span = tracer.startSpan(name, { kind: SpanKind.INTERNAL }, parent);
  const spanContext = trace.setSpan(parent, span);
  return context.with(spanContext, async () => {
    try {
      return await callback(span);
    } catch (error) {
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function shutdownTelemetry(): Promise<void> {
  await provider.shutdown();
}
