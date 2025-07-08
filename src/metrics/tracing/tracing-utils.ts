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
  const tracer = trace.getTracer('thoughtspot-mcp-server');
  
  // For simplicity, we'll just use startActiveSpan which handles context automatically
  // The parentSpan parameter is kept for backward compatibility but not used
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

// Decorator version of withSpan
// Usage: @WithSpan('my-operation')
export function WithSpan(name: string) {
  return <T extends any[], R>(
    target: any,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<(...args: T) => Promise<R>>
  ) => {
    const originalMethod = descriptor.value;
    
    if (!originalMethod) {
      throw new Error('WithSpan can only be applied to methods');
    }
    
    descriptor.value = async function (...args: T): Promise<R> {
      const tracer = trace.getTracer('thoughtspot-mcp-server');
      
      return tracer.startActiveSpan(name, async (span) => {
        try {
          return await originalMethod.apply(this, args);
        } catch (err) {
          span.recordException(err as Error);
          throw err;
        } finally {
          span.end();
        }
      });
    };
    
    return descriptor;
  };
}

// Function version that takes name as parameter (for functional style)
// Usage: const mySpanFunction = withSpanNamed('my-operation');
//        const result = await mySpanFunction(async (span) => { /* work */ });
export function withSpanNamed(name: string) {
  return async <T>(fn: (span: Span) => Promise<T>, parentSpan?: Span): Promise<T> => withSpan(name, fn, parentSpan);
}

/**
 * Example usage:
 * 
 * // Using as decorator:
 * class MyService {
 *   @WithSpan('fetch-user-data')
 *   async fetchUserData(userId: string) {
 *     // This method will be automatically wrapped in a span
 *     const user = await this.userRepository.findById(userId);
 *     return user;
 *   }
 * }
 * 
 * // Using functional style:
 * const fetchWithSpan = withSpanNamed('fetch-data');
 * const result = await fetchWithSpan(async (span) => {
 *   span.setAttribute('url', 'https://api.example.com');
 *   return await fetch('https://api.example.com');
 * });
 * 
 * // Traditional usage (unchanged):
 * const result = await withSpan('my-operation', async (span) => {
 *   span.setAttribute('key', 'value');
 *   return await doSomeWork();
 * });
 */
