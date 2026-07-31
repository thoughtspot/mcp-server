import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Intercept at the pkg's createOAuthHandler so we can assert on the request the
// worker forwards after its own rewrites (header stripping, path aliasing).
const mockOAuthFetch = vi.fn();

vi.mock("@thoughtspot/mcp-auth", async () => {
	const actual = await vi.importActual<typeof import("@thoughtspot/mcp-auth")>(
		"@thoughtspot/mcp-auth",
	);
	return {
		...actual,
		createOAuthHandler: () => ({
			fetch: (request: Request, env: any, ctx: any) =>
				mockOAuthFetch(request, env, ctx),
		}),
	};
});

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function loadWorker() {
	const { default: worker } = await import("../src/index.js");
	return worker as {
		fetch: (request: Request, env: any, ctx: any) => Promise<Response>;
	};
}

describe("MCP Router with API Version", () => {
	beforeEach(() => {
		vi.resetModules();
		mockOAuthFetch.mockClear();
		mockOAuthFetch.mockResolvedValue(new Response("ok", { status: 200 }));
	});

	it("should create router with correct serve method for /mcp", async () => {
		const worker = await loadWorker();
		const request = new IncomingRequest("https://example.com/mcp");
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, env, ctx);

		expect(response).toBeDefined();
		expect(response instanceof Response).toBe(true);
	});

	it("should create router with correct serve method for /sse", async () => {
		const worker = await loadWorker();
		const request = new IncomingRequest("https://example.com/sse");
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, env, ctx);

		expect(response).toBeDefined();
		expect(response instanceof Response).toBe(true);
	});

	it("should handle query parameters in router paths", async () => {
		const worker = await loadWorker();
		const request = new IncomingRequest(
			"https://example.com/mcp?api-version=beta&other=param",
		);
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, env, ctx);

		expect(response).toBeDefined();
		expect(response instanceof Response).toBe(true);
	});
});

describe("Path aliases", () => {
	beforeEach(() => {
		vi.resetModules();
		mockOAuthFetch.mockClear();
		mockOAuthFetch.mockResolvedValue(new Response("ok", { status: 200 }));
	});

	// Drive the worker with the client's `path` and return the path+query the
	// OAuth handler actually receives (i.e. the endpoint after applyPathAlias).
	async function forwardedEndpoint(path: string): Promise<string> {
		const worker = await loadWorker();
		mockOAuthFetch.mockClear();
		await worker.fetch(
			new IncomingRequest(`https://example.com${path}`),
			env,
			createExecutionContext(),
		);
		const received: Request = mockOAuthFetch.mock.calls[0][0];
		const url = new URL(received.url);
		return url.pathname + url.search;
	}

	it("rewrites /mcp-<version> to /mcp?api-version=<version>", async () => {
		expect(await forwardedEndpoint("/mcp-latest")).toBe(
			"/mcp?api-version=latest",
		);
		expect(await forwardedEndpoint("/mcp-beta")).toBe("/mcp?api-version=beta");
	});

	it("preserves dashes in date versions (strips only the prefix)", async () => {
		expect(await forwardedEndpoint("/mcp-2026-05-01")).toBe(
			"/mcp?api-version=2026-05-01",
		);
	});

	it("rewrites the token flow: /token/mcp-<version>", async () => {
		expect(await forwardedEndpoint("/token/mcp-latest")).toBe(
			"/token/mcp?api-version=latest",
		);
		expect(await forwardedEndpoint("/token/mcp-2026-05-01")).toBe(
			"/token/mcp?api-version=2026-05-01",
		);
	});

	it("leaves canonical paths untouched", async () => {
		expect(await forwardedEndpoint("/mcp")).toBe("/mcp");
		expect(await forwardedEndpoint("/token/mcp")).toBe("/token/mcp");
	});

	it("does not treat a bare-prefix path as an alias", async () => {
		expect(await forwardedEndpoint("/mcp-")).toBe("/mcp-");
	});

	it("ignores unrelated routes", async () => {
		expect(await forwardedEndpoint("/sse")).toBe("/sse");
		expect(await forwardedEndpoint("/authorize")).toBe("/authorize");
	});

	it("overwrites any api-version already present in the query", async () => {
		expect(await forwardedEndpoint("/mcp-latest?api-version=beta")).toBe(
			"/mcp?api-version=latest",
		);
	});
});
