import { describe, expect, it, vi } from "vitest";

// Override the global setup mocks so Agent.serve is not replaced
vi.mock("agents/mcp", () => {
	const mockServerFetch = vi.fn();
	const mockServer = { fetch: mockServerFetch };
	return {
		McpAgent: class MockMcpAgent {
			static serve = vi.fn(() => ({ ...mockServer, fetch: mockServerFetch }));
			async init() {}
		},
	};
});

vi.mock("@microlabs/otel-cf-workers", () => ({
	instrumentDO: (cls: any) => cls,
	ResolveConfigFn: vi.fn(),
}));

import { McpAgent } from "agents/mcp";
import { instrumentedMCPServer } from "../src/cloudflare-utils";

class MockMCPServer {
	constructor(public ctx: any) {}
	async init() {}
}

function getServeResult() {
	const mockConfig = vi.fn();
	const InstrumentedClass = instrumentedMCPServer(
		MockMCPServer as any,
		mockConfig,
	);
	return InstrumentedClass.serve("/mcp");
}

describe("instrumentedMCPServer serve()", () => {
	it("blocks DELETE requests from openai-mcp user-agent with 403", async () => {
		const server = getServeResult();

		const request = new Request("https://example.com/mcp", {
			method: "DELETE",
			headers: { "user-agent": "openai-mcp/1.0" },
		});

		const response = await server.fetch(request, {}, {} as ExecutionContext);

		expect(response.status).toBe(403);
		expect(vi.mocked(McpAgent.serve as any).mock.results[0]).toBeDefined();
	});

	it("passes through non-DELETE requests to the underlying fetch", async () => {
		const upstreamResponse = new Response("ok", { status: 200 });
		const upstreamFetch = vi.fn().mockResolvedValue(upstreamResponse);
		vi.mocked(McpAgent.serve as any).mockReturnValueOnce({
			fetch: upstreamFetch,
		});

		const server = getServeResult();

		const request = new Request("https://example.com/mcp", { method: "POST" });
		const env = {};
		const ctx = {} as ExecutionContext;

		const response = await server.fetch(request, env, ctx);

		expect(upstreamFetch).toHaveBeenCalledWith(request, env, ctx);
		expect(response.status).toBe(200);
	});

	it("passes through DELETE requests from non-openai-mcp user-agents", async () => {
		const upstreamResponse = new Response("ok", { status: 200 });
		const upstreamFetch = vi.fn().mockResolvedValue(upstreamResponse);
		vi.mocked(McpAgent.serve as any).mockReturnValueOnce({
			fetch: upstreamFetch,
		});

		const server = getServeResult();

		const request = new Request("https://example.com/mcp", {
			method: "DELETE",
			headers: { "user-agent": "curl/7.0" },
		});

		const response = await server.fetch(request, {}, {} as ExecutionContext);

		expect(upstreamFetch).toHaveBeenCalled();
		expect(response.status).toBe(200);
	});

	it("passes through DELETE requests with no user-agent header", async () => {
		const upstreamResponse = new Response("ok", { status: 200 });
		const upstreamFetch = vi.fn().mockResolvedValue(upstreamResponse);
		vi.mocked(McpAgent.serve as any).mockReturnValueOnce({
			fetch: upstreamFetch,
		});

		const server = getServeResult();

		const request = new Request("https://example.com/mcp", {
			method: "DELETE",
		});

		const response = await server.fetch(request, {}, {} as ExecutionContext);

		expect(upstreamFetch).toHaveBeenCalled();
		expect(response.status).toBe(200);
	});
});

describe("instrumentedMCPServer serve() - CLUSTER_URL_BLOCKLIST", () => {
	it("blocks request with 403 when instanceUrl matches a blocklist entry", async () => {
		const server = getServeResult();

		const request = new Request("https://example.com/mcp", { method: "POST" });
		const env = {
			CLUSTER_URL_BLOCKLIST: "blocked.thoughtspot.com,other.example.com",
		};
		const ctx = {
			props: { instanceUrl: "https://blocked.thoughtspot.com/callosum" },
		} as any;

		const response = await server.fetch(request, env, ctx);

		expect(response.status).toBe(403);
		expect(await response.text()).toContain("not permitted to connect");
	});

	it("blocks request when instanceUrl partially matches a blocklist entry", async () => {
		const server = getServeResult();

		const request = new Request("https://example.com/mcp", { method: "POST" });
		const env = { CLUSTER_URL_BLOCKLIST: "blocked.thoughtspot.com" };
		const ctx = {
			props: { instanceUrl: "https://blocked.thoughtspot.com" },
		} as any;

		const response = await server.fetch(request, env, ctx);

		expect(response.status).toBe(403);
	});

	it("passes through when instanceUrl does not match any blocklist entry", async () => {
		const upstreamResponse = new Response("ok", { status: 200 });
		const upstreamFetch = vi.fn().mockResolvedValue(upstreamResponse);
		vi.mocked(McpAgent.serve as any).mockReturnValueOnce({
			fetch: upstreamFetch,
		});

		const server = getServeResult();

		const request = new Request("https://example.com/mcp", { method: "POST" });
		const env = {
			CLUSTER_URL_BLOCKLIST: "blocked.thoughtspot.com,other.example.com",
		};
		const ctx = {
			props: { instanceUrl: "https://allowed.thoughtspot.com" },
		} as any;

		const response = await server.fetch(request, env, ctx);

		expect(upstreamFetch).toHaveBeenCalledWith(request, env, ctx);
		expect(response.status).toBe(200);
	});

	it("passes through when CLUSTER_URL_BLOCKLIST is not set", async () => {
		const upstreamResponse = new Response("ok", { status: 200 });
		const upstreamFetch = vi.fn().mockResolvedValue(upstreamResponse);
		vi.mocked(McpAgent.serve as any).mockReturnValueOnce({
			fetch: upstreamFetch,
		});

		const server = getServeResult();

		const request = new Request("https://example.com/mcp", { method: "POST" });
		const env = {};
		const ctx = {
			props: { instanceUrl: "https://any.thoughtspot.com" },
		} as any;

		const response = await server.fetch(request, env, ctx);

		expect(upstreamFetch).toHaveBeenCalledWith(request, env, ctx);
		expect(response.status).toBe(200);
	});

	it("passes through when instanceUrl is undefined", async () => {
		const upstreamResponse = new Response("ok", { status: 200 });
		const upstreamFetch = vi.fn().mockResolvedValue(upstreamResponse);
		vi.mocked(McpAgent.serve as any).mockReturnValueOnce({
			fetch: upstreamFetch,
		});

		const server = getServeResult();

		const request = new Request("https://example.com/mcp", { method: "POST" });
		const env = { CLUSTER_URL_BLOCKLIST: "blocked.thoughtspot.com" };
		const ctx = { props: {} } as any;

		const response = await server.fetch(request, env, ctx);

		expect(upstreamFetch).toHaveBeenCalledWith(request, env, ctx);
		expect(response.status).toBe(200);
	});

	it("passes through when blocklist is an empty string", async () => {
		const upstreamResponse = new Response("ok", { status: 200 });
		const upstreamFetch = vi.fn().mockResolvedValue(upstreamResponse);
		vi.mocked(McpAgent.serve as any).mockReturnValueOnce({
			fetch: upstreamFetch,
		});

		const server = getServeResult();

		const request = new Request("https://example.com/mcp", { method: "POST" });
		const env = { CLUSTER_URL_BLOCKLIST: "" };
		const ctx = {
			props: { instanceUrl: "https://any.thoughtspot.com" },
		} as any;

		const response = await server.fetch(request, env, ctx);

		expect(upstreamFetch).toHaveBeenCalledWith(request, env, ctx);
		expect(response.status).toBe(200);
	});
});
