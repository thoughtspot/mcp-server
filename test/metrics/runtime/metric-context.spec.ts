import { describe, expect, it } from "vitest";
import {
	getApiSurface,
	getAuthMode,
	getRouteGroup,
	getStatusClass,
	getTransport,
	resolveRequestMetricContext,
} from "../../../src/metrics/runtime/metric-context";

describe("metric-context", () => {
	it("maps known request paths to route groups", () => {
		expect(getRouteGroup("/")).toBe("root");
		expect(getRouteGroup("/authorize")).toBe("authorize");
		expect(getRouteGroup("/callback")).toBe("callback");
		expect(getRouteGroup("/store-token")).toBe("store_token");
		expect(getRouteGroup("/mcp")).toBe("mcp");
		expect(getRouteGroup("/sse")).toBe("sse");
		expect(getRouteGroup("/openai/mcp")).toBe("openai_mcp");
		expect(getRouteGroup("/openai/sse")).toBe("openai_sse");
		expect(getRouteGroup("/bearer/mcp")).toBe("bearer_mcp");
		expect(getRouteGroup("/bearer/sse")).toBe("bearer_sse");
		expect(getRouteGroup("/token/mcp")).toBe("token_mcp");
		expect(getRouteGroup("/token/sse")).toBe("token_sse");
		expect(getRouteGroup("/api/resources/datasources")).toBe("api");
		expect(getRouteGroup("/not-a-route")).toBe("unknown");
	});

	it("derives transport from the request path", () => {
		expect(getTransport("/mcp")).toBe("mcp");
		expect(getTransport("/bearer/mcp")).toBe("mcp");
		expect(getTransport("/openai/sse")).toBe("sse");
		expect(getTransport("/authorize")).toBe("http");
	});

	it("derives API surface from the request path", () => {
		expect(getApiSurface("/openai/mcp")).toBe("openai_mcp");
		expect(getApiSurface("/api/resources/datasources")).toBe("api");
		expect(getApiSurface("/mcp")).toBe("mcp");
		expect(getApiSurface("/bearer/sse")).toBe("mcp");
		expect(getApiSurface("/token/mcp")).toBe("mcp");
		expect(getApiSurface("/")).toBe("static");
		expect(getApiSurface("/authorize")).toBe("oauth");
		expect(getApiSurface("/callback")).toBe("oauth");
		expect(getApiSurface("/store-token")).toBe("oauth");
		expect(getApiSurface("/mystery")).toBe("unknown");
	});

	it("derives auth mode from the request path", () => {
		expect(getAuthMode("/bearer/mcp")).toBe("bearer");
		expect(getAuthMode("/token/sse")).toBe("token");
		expect(getAuthMode("/mcp")).toBe("oauth");
		expect(getAuthMode("/openai/mcp")).toBe("oauth");
		expect(getAuthMode("/api/resources/datasources")).toBe("oauth");
		expect(getAuthMode("/")).toBe("none");
		expect(getAuthMode("/authorize")).toBe("none");
		expect(getAuthMode("/callback")).toBe("none");
		expect(getAuthMode("/store-token")).toBe("none");
		expect(getAuthMode("/unknown")).toBe("unknown");
	});

	it("maps response status codes into status classes", () => {
		expect(getStatusClass(101)).toBe("1xx");
		expect(getStatusClass(204)).toBe("2xx");
		expect(getStatusClass(302)).toBe("3xx");
		expect(getStatusClass(404)).toBe("4xx");
		expect(getStatusClass(503)).toBe("5xx");
		expect(getStatusClass(99)).toBe("unknown");
		expect(getStatusClass(600)).toBe("unknown");
	});

	it("resolves the full request metric context from a Request", () => {
		const request = new Request(
			"https://example.com/bearer/mcp?api-version=2026-04-23",
		);

		expect(resolveRequestMetricContext(request)).toEqual({
			routeGroup: "bearer_mcp",
			transport: "mcp",
			apiSurface: "mcp",
			authMode: "bearer",
		});
	});
});
