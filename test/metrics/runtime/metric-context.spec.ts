import { describe, expect, it } from "vitest";
import {
	EXPLICIT_ROUTE_CONTEXTS,
	getApiSurface,
	getAuthMode,
	getRouteGroup,
	getStatusClass,
	getTransport,
	resolvePathMetricContext,
	resolveRequestMetricContext,
} from "../../../src/metrics/runtime/metric-context";

describe("metric-context", () => {
	it("maps explicit request paths through the shared route context table", () => {
		for (const [pathname, context] of Object.entries(EXPLICIT_ROUTE_CONTEXTS)) {
			expect(resolvePathMetricContext(pathname)).toEqual(context);
			expect(getRouteGroup(pathname)).toBe(context.routeGroup);
			expect(getTransport(pathname)).toBe(context.transport);
			expect(getApiSurface(pathname)).toBe(context.apiSurface);
			expect(getAuthMode(pathname)).toBe(context.authMode);
		}
	});

	it("maps known grouped request paths to route groups", () => {
		expect(getRouteGroup("/api/resources/datasources")).toBe("api");
		expect(getRouteGroup("/not-a-route")).toBe("unknown");
	});

	it("derives transport from fallback request paths", () => {
		expect(getTransport("/future/mcp")).toBe("mcp");
		expect(getTransport("/future/sse")).toBe("sse");
		expect(getTransport("/authorize")).toBe("http");
	});

	it("derives API surface from fallback request paths", () => {
		expect(getApiSurface("/openai/future-endpoint")).toBe("openai_mcp");
		expect(getApiSurface("/api/resources/datasources")).toBe("api");
		expect(getApiSurface("/bearer/future-endpoint")).toBe("mcp");
		expect(getApiSurface("/token/future-endpoint")).toBe("mcp");
		expect(getApiSurface("/")).toBe("static");
		expect(getApiSurface("/authorize")).toBe("oauth");
		expect(getApiSurface("/callback")).toBe("oauth");
		expect(getApiSurface("/store-token")).toBe("oauth");
		expect(getApiSurface("/mystery")).toBe("unknown");
	});

	it("derives auth mode from fallback request paths", () => {
		expect(getAuthMode("/bearer/future-endpoint")).toBe("bearer");
		expect(getAuthMode("/token/future-endpoint")).toBe("token");
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
