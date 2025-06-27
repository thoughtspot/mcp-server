import {
    env,
    runInDurableObject,
    createExecutionContext,
    waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
// Import your worker so you can unit test it
import worker, { ThoughtSpotMCP } from "../src";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

vi.mock('@opentelemetry/resources', () => {
    const MockResource = class {
      attributes: Record<string, any>;
      
      constructor(attributes: Record<string, any> = {}) {
        this.attributes = attributes;
      }
      
      static default() {
        return new MockResource();
      }
      
      static empty() {
        return new MockResource();
      }
      
      merge(other: any) {
        return new MockResource({ ...this.attributes, ...other.attributes });
      }
    };
  
    return {
      Resource: MockResource,
      detectResources: vi.fn(() => Promise.resolve(new MockResource())),
      envDetector: {
        detect: vi.fn(() => Promise.resolve(new MockResource())),
      },
      hostDetector: {
        detect: vi.fn(() => Promise.resolve(new MockResource())),
      },
      osDetector: {
        detect: vi.fn(() => Promise.resolve(new MockResource())),
      },
      processDetector: {
        detect: vi.fn(() => Promise.resolve(new MockResource())),
      },
    };
  });
  
  // Mock @microlabs/otel-cf-workers with hoisted function
  const mockInstrumentDO = vi.hoisted(() => {
    return (cls: any, config: any) => {
      // Create a mock class that extends the original
      class MockInstrumentedClass extends cls {
        static serve = vi.fn((path: string) => ({
          fetch: vi.fn().mockResolvedValue(new Response('Mock MCP Response', { status: 200 }))
        }));
        static serveSSE = vi.fn((path: string) => ({
          fetch: vi.fn().mockResolvedValue(new Response('Mock SSE Response', { status: 200 }))
        }));
      }
      
      // Add static methods to the class itself
      MockInstrumentedClass.serve = vi.fn((path: string) => ({
        fetch: vi.fn().mockResolvedValue(new Response('Mock MCP Response', { status: 200 }))
      }));
      MockInstrumentedClass.serveSSE = vi.fn((path: string) => ({
        fetch: vi.fn().mockResolvedValue(new Response('Mock SSE Response', { status: 200 }))
      }));
      
      return MockInstrumentedClass;
    };
  });
  
  vi.mock('@microlabs/otel-cf-workers', () => {
    return {
      instrumentDO: mockInstrumentDO,
      ResolveConfigFn: vi.fn(),
    };
  });

describe("The ThoughtSpot MCP Worker: Auth handler", () => {
    it("responds with Hello World! on '/'", async () => {
        const id = env.MCP_OBJECT.idFromName("test");
        const object = env.MCP_OBJECT.get(id);
        const result = await runInDurableObject(object, async (instance) => {
            expect(instance).toBeInstanceOf(ThoughtSpotMCP);
            const request = new IncomingRequest("https://example.com/hello");
            // Create an empty context to pass to `worker.fetch()`
            const ctx = createExecutionContext();
            return worker.fetch(request, env, ctx);
        });
        expect(result.status).toBe(200);
        expect(await result.json()).toMatchObject({
            message: "Hello, World!",
        });
    });
});
