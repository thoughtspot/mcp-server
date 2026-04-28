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
import {
	EXACT_PUBLIC_ROUTES_REQUIRING_METRICS,
	PUBLIC_ROUTES,
	PUBLIC_ROUTE_PREFIXES,
} from "../../../src/routes";

describe("metric-context", () => {
	it("requires exact public routes to have explicit metric context entries", () => {
		for (const pathname of EXACT_PUBLIC_ROUTES_REQUIRING_METRICS) {
			expect(EXPLICIT_ROUTE_CONTEXTS).toHaveProperty(pathname);
			expect(resolvePathMetricContext(pathname).routeGroup).not.toBe("unknown");
		}
	});

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
		expect(
			getRouteGroup(`${PUBLIC_ROUTE_PREFIXES.api}/resources/datasources`),
		).toBe("api");
		expect(getRouteGroup("/not-a-route")).toBe("unknown");
	});

	it("derives transport from fallback request paths", () => {
		expect(getTransport("/future/mcp")).toBe("mcp");
		expect(getTransport("/future/sse")).toBe("sse");
		expect(getTransport(PUBLIC_ROUTES.authorize)).toBe("http");
	});

	it("derives API surface from fallback request paths", () => {
		expect(getApiSurface("/openai/future-endpoint")).toBe("openai_mcp");
		expect(
			getApiSurface(`${PUBLIC_ROUTE_PREFIXES.api}/resources/datasources`),
		).toBe("api");
		expect(getApiSurface("/bearer/future-endpoint")).toBe("mcp");
		expect(getApiSurface("/token/future-endpoint")).toBe("mcp");
		expect(getApiSurface(PUBLIC_ROUTES.root)).toBe("static");
		expect(getApiSurface(PUBLIC_ROUTES.authorize)).toBe("oauth");
		expect(getApiSurface(PUBLIC_ROUTES.callback)).toBe("oauth");
		expect(getApiSurface(PUBLIC_ROUTES.storeToken)).toBe("oauth");
		expect(getApiSurface("/mystery")).toBe("unknown");
	});

	it("derives auth mode from fallback request paths", () => {
		expect(getAuthMode("/bearer/future-endpoint")).toBe("bearer");
		expect(getAuthMode("/token/future-endpoint")).toBe("token");
		expect(getAuthMode(PUBLIC_ROUTES.openaiMcp)).toBe("oauth");
		expect(
			getAuthMode(`${PUBLIC_ROUTE_PREFIXES.api}/resources/datasources`),
		).toBe("oauth");
		expect(getAuthMode(PUBLIC_ROUTES.root)).toBe("none");
		expect(getAuthMode(PUBLIC_ROUTES.authorize)).toBe("none");
		expect(getAuthMode(PUBLIC_ROUTES.callback)).toBe("none");
		expect(getAuthMode(PUBLIC_ROUTES.storeToken)).toBe("none");
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
			`https://example.com${PUBLIC_ROUTES.bearerMcp}?api-version=2026-04-23`,
		);

		expect(resolveRequestMetricContext(request)).toEqual({
			routeGroup: "bearer_mcp",
			transport: "mcp",
			apiSurface: "mcp",
			authMode: "bearer",
		});
	});
});
