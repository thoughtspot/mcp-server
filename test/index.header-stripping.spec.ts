import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Intercept at the OAuthProvider level — this is called after the outer worker
// strips headers, so we can assert on what it actually receives.
const mockOAuthFetch = vi.fn();

vi.mock("@cloudflare/workers-oauth-provider", () => ({
	default: class MockOAuthProvider {
		fetch(request: Request, env: any, ctx: any) {
			return mockOAuthFetch(request, env, ctx);
		}
	},
}));

describe("Header stripping", () => {
	beforeEach(() => {
		vi.resetModules();
		mockOAuthFetch.mockClear();
		mockOAuthFetch.mockResolvedValue(new Response("ok", { status: 200 }));
	});

	it("strips traceparent before the request reaches the OAuth provider", async () => {
		const { default: worker } = await import("../src/index.js");
		const typedWorker = worker as {
			fetch: (request: Request, env: any, ctx: any) => Promise<Response>;
		};

		const request = new Request("https://example.com/hello", {
			headers: { traceparent: "00-abc123-def456-01" },
		});

		await typedWorker.fetch(request, env, createExecutionContext());

		const received: Request = mockOAuthFetch.mock.calls[0][0];
		expect(received.headers.has("traceparent")).toBe(false);
	});

	it("strips tracestate before the request reaches the OAuth provider", async () => {
		const { default: worker } = await import("../src/index.js");
		const typedWorker = worker as {
			fetch: (request: Request, env: any, ctx: any) => Promise<Response>;
		};

		const request = new Request("https://example.com/hello", {
			headers: { tracestate: "vendor=value" },
		});

		await typedWorker.fetch(request, env, createExecutionContext());

		const received: Request = mockOAuthFetch.mock.calls[0][0];
		expect(received.headers.has("tracestate")).toBe(false);
	});

	it("strips all tracing headers while preserving others", async () => {
		const { default: worker } = await import("../src/index.js");
		const typedWorker = worker as {
			fetch: (request: Request, env: any, ctx: any) => Promise<Response>;
		};

		const request = new Request("https://example.com/hello", {
			headers: {
				traceparent: "00-abc123-def456-01",
				tracestate: "vendor=value",
				"x-custom-header": "should-remain",
			},
		});

		await typedWorker.fetch(request, env, createExecutionContext());

		const received: Request = mockOAuthFetch.mock.calls[0][0];
		expect(received.headers.has("traceparent")).toBe(false);
		expect(received.headers.has("tracestate")).toBe(false);
		expect(received.headers.get("x-custom-header")).toBe("should-remain");
	});

	it("does not mutate the original request object", async () => {
		const { default: worker } = await import("../src/index.js");
		const typedWorker = worker as {
			fetch: (request: Request, env: any, ctx: any) => Promise<Response>;
		};

		const request = new Request("https://example.com/hello", {
			headers: { traceparent: "00-abc123-def456-01" },
		});

		await typedWorker.fetch(request, env, createExecutionContext());

		expect(request.headers.get("traceparent")).toBe("00-abc123-def456-01");
	});

	it("passes the request through unchanged when no tracing headers are present", async () => {
		const { default: worker } = await import("../src/index.js");
		const typedWorker = worker as {
			fetch: (request: Request, env: any, ctx: any) => Promise<Response>;
		};

		const request = new Request("https://example.com/hello", {
			headers: { "x-custom-header": "value" },
		});

		await typedWorker.fetch(request, env, createExecutionContext());

		const received: Request = mockOAuthFetch.mock.calls[0][0];
		expect(received.headers.get("x-custom-header")).toBe("value");
	});
});
