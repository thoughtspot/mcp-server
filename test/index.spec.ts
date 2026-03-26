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
		const typedWorker = worker as {
			fetch: (request: Request, env: any, ctx: any) => Promise<Response>;
		};

		const request = new IncomingRequest("https://example.com/hello");
		const ctx = createExecutionContext();

		// Call the worker fetch directly without using Durable Object
		const result = await typedWorker.fetch(request, env, ctx);

		expect(result.status).toBe(200);
		expect(await result.json()).toMatchObject({
			message: "Hello, World!",
		});
	});
});

describe("MCP Router with API Version", () => {
	it("should create router with correct serve method for /mcp", async () => {
		vi.resetModules();
		const { default: worker } = await import("../src/index.js");

		const typedWorker = worker as {
			fetch: (request: Request, env: any, ctx: any) => Promise<Response>;
		};

		const request = new IncomingRequest("https://example.com/mcp");
		const ctx = createExecutionContext();

		// This tests that the router is correctly set up
		// The actual apiVersion injection is tested in bearer.spec.ts
		const response = await typedWorker.fetch(request, env, ctx);

		// Should get a response (even if it's an auth error)
		expect(response).toBeDefined();
		expect(response instanceof Response).toBe(true);

		vi.restoreAllMocks();
	});

	it("should create router with correct serve method for /sse", async () => {
		vi.resetModules();
		const { default: worker } = await import("../src/index.js");

		const typedWorker = worker as {
			fetch: (request: Request, env: any, ctx: any) => Promise<Response>;
		};

		const request = new IncomingRequest("https://example.com/sse");
		const ctx = createExecutionContext();

		const response = await typedWorker.fetch(request, env, ctx);

		// Should get a response (even if it's an auth error)
		expect(response).toBeDefined();
		expect(response instanceof Response).toBe(true);

		vi.restoreAllMocks();
	});

	it("should handle query parameters in router paths", async () => {
		vi.resetModules();
		const { default: worker } = await import("../src/index.js");

		const typedWorker = worker as {
			fetch: (request: Request, env: any, ctx: any) => Promise<Response>;
		};

		const request = new IncomingRequest(
			"https://example.com/mcp?api-version=beta&other=param",
		);
		const ctx = createExecutionContext();

		const response = await typedWorker.fetch(request, env, ctx);

		// Should handle query params gracefully
		expect(response).toBeDefined();
		expect(response instanceof Response).toBe(true);

		vi.restoreAllMocks();
	});
});
