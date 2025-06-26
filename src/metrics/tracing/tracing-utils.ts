// tracing-utils.ts
import { type Span, trace, context } from '@opentelemetry/api';

export function getActiveSpan(spanOverride?: Span): Span | undefined {
  return spanOverride ?? trace.getSpan(context.active());
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  parentSpan?: Span
): Promise<T> {
  return trace.getTracer('thoughtspot-mcp-server').startActiveSpan(name, { parent: parentSpan }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}
