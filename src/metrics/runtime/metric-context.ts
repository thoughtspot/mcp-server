import type {
	ApiSurface,
	AuthMode,
	RouteGroup,
	StatusClass,
	Transport,
} from "./metric-types";

export function getRouteGroup(pathname: string): RouteGroup {
	switch (pathname) {
		case "/":
			return "root";
		case "/authorize":
			return "authorize";
		case "/callback":
			return "callback";
		case "/store-token":
			return "store_token";
		case "/mcp":
			return "mcp";
		case "/sse":
			return "sse";
		case "/openai/mcp":
			return "openai_mcp";
		case "/openai/sse":
			return "openai_sse";
		case "/bearer/mcp":
			return "bearer_mcp";
		case "/bearer/sse":
			return "bearer_sse";
		case "/token/mcp":
			return "token_mcp";
		case "/token/sse":
			return "token_sse";
		default:
			if (pathname.startsWith("/api")) {
				return "api";
			}
			return "unknown";
	}
}

export function getTransport(pathname: string): Transport {
	if (pathname.endsWith("/mcp") || pathname === "/mcp") {
		return "mcp";
	}
	if (pathname.endsWith("/sse") || pathname === "/sse") {
		return "sse";
	}
	return "http";
}

export function getApiSurface(pathname: string): ApiSurface {
	if (pathname.startsWith("/openai/")) {
		return "openai_mcp";
	}
	if (pathname.startsWith("/api")) {
		return "api";
	}
	if (
		pathname === "/mcp" ||
		pathname === "/sse" ||
		pathname.startsWith("/bearer/") ||
		pathname.startsWith("/token/")
	) {
		return "mcp";
	}
	if (
		pathname === "/" ||
		pathname === "/authorize" ||
		pathname === "/callback" ||
		pathname === "/store-token"
	) {
		return pathname === "/" ? "static" : "oauth";
	}
	return "unknown";
}

export function getAuthMode(pathname: string): AuthMode {
	if (pathname.startsWith("/bearer/")) {
		return "bearer";
	}
	if (pathname.startsWith("/token/")) {
		return "token";
	}
	if (
		pathname === "/mcp" ||
		pathname === "/sse" ||
		pathname.startsWith("/openai/") ||
		pathname.startsWith("/api")
	) {
		return "oauth";
	}
	if (
		pathname === "/" ||
		pathname === "/authorize" ||
		pathname === "/callback" ||
		pathname === "/store-token"
	) {
		return "none";
	}
	return "unknown";
}

export function getStatusClass(status: number): StatusClass {
	if (status >= 100 && status < 200) {
		return "1xx";
	}
	if (status >= 200 && status < 300) {
		return "2xx";
	}
	if (status >= 300 && status < 400) {
		return "3xx";
	}
	if (status >= 400 && status < 500) {
		return "4xx";
	}
	if (status >= 500 && status < 600) {
		return "5xx";
	}
	return "unknown";
}

export function resolveRequestMetricContext(request: Request) {
	const pathname = new URL(request.url).pathname;

	return {
		routeGroup: getRouteGroup(pathname),
		transport: getTransport(pathname),
		apiSurface: getApiSurface(pathname),
		authMode: getAuthMode(pathname),
	};
}
