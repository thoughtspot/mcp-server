import {
    env,
    runInDurableObject,
    createExecutionContext,
    waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("The ThoughtSpot MCP Worker: Auth handler", () => {
    it("responds with Hello World! on '/hello'", async () => {
        // Clear module cache and import fresh
        vi.resetModules();
        
        // Import the worker dynamically to get fresh instance
        const { default: worker, ThoughtSpotMCP } = await import("../src/index.js");
        
        // Type assertion for worker to have fetch method
        const typedWorker = worker as { fetch: (request: Request, env: any, ctx: any) => Promise<Response> };
        
        const request = new IncomingRequest("https://example.com/hello");
        const ctx = createExecutionContext();
        
        // Call the worker fetch directly without using Durable Object
        const result = await typedWorker.fetch(request, env, ctx);
        
        expect(result.status).toBe(200);
        const response = await result.json();
        expect(response).toMatchObject({
            success: true,
            statusCode: 200,
            data: { message: "Hello, World!" },
            message: "Hello world response generated successfully"
        });
    });
});
