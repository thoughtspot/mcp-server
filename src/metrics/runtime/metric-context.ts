import type {
	ApiSurface,
	AuthMode,
	RouteGroup,
	StatusClass,
	Transport,
} from "./metric-types";

export type RequestMetricContext = {
	routeGroup: RouteGroup;
	transport: Transport;
	apiSurface: ApiSurface;
	authMode: AuthMode;
};

// Keep explicit route classifications here so adding a new public path only
// requires a single metadata update instead of touching multiple helper
// functions.
export const EXPLICIT_ROUTE_CONTEXTS = {
	"/": {
		routeGroup: "root",
		transport: "http",
		apiSurface: "static",
		authMode: "none",
	},
	"/authorize": {
		routeGroup: "authorize",
		transport: "http",
		apiSurface: "oauth",
		authMode: "none",
	},
	"/callback": {
		routeGroup: "callback",
		transport: "http",
		apiSurface: "oauth",
		authMode: "none",
	},
	"/store-token": {
		routeGroup: "store_token",
		transport: "http",
		apiSurface: "oauth",
		authMode: "none",
	},
	"/mcp": {
		routeGroup: "mcp",
		transport: "mcp",
		apiSurface: "mcp",
		authMode: "oauth",
	},
	"/sse": {
		routeGroup: "sse",
		transport: "sse",
		apiSurface: "mcp",
		authMode: "oauth",
	},
	"/openai/mcp": {
		routeGroup: "openai_mcp",
		transport: "mcp",
		apiSurface: "openai_mcp",
		authMode: "oauth",
	},
	"/openai/sse": {
		routeGroup: "openai_sse",
		transport: "sse",
		apiSurface: "openai_mcp",
		authMode: "oauth",
	},
	"/bearer/mcp": {
		routeGroup: "bearer_mcp",
		transport: "mcp",
		apiSurface: "mcp",
		authMode: "bearer",
	},
	"/bearer/sse": {
		routeGroup: "bearer_sse",
		transport: "sse",
		apiSurface: "mcp",
		authMode: "bearer",
	},
	"/token/mcp": {
		routeGroup: "token_mcp",
		transport: "mcp",
		apiSurface: "mcp",
		authMode: "token",
	},
	"/token/sse": {
		routeGroup: "token_sse",
		transport: "sse",
		apiSurface: "mcp",
		authMode: "token",
	},
} as const satisfies Record<string, RequestMetricContext>;

const API_ROUTE_CONTEXT: RequestMetricContext = {
	routeGroup: "api",
	transport: "http",
	apiSurface: "api",
	authMode: "oauth",
};

const UNKNOWN_ROUTE_CONTEXT: RequestMetricContext = {
	routeGroup: "unknown",
	transport: "http",
	apiSurface: "unknown",
	authMode: "unknown",
};

function getExplicitRouteContext(
	pathname: string,
): RequestMetricContext | undefined {
	return EXPLICIT_ROUTE_CONTEXTS[
		pathname as keyof typeof EXPLICIT_ROUTE_CONTEXTS
	];
}

function inferTransport(pathname: string): Transport {
	if (pathname.endsWith("/mcp") || pathname === "/mcp") {
		return "mcp";
	}
	if (pathname.endsWith("/sse") || pathname === "/sse") {
		return "sse";
	}
	return "http";
}

function inferApiSurface(pathname: string): ApiSurface {
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
	if (pathname === "/") {
		return "static";
	}
	if (
		pathname === "/authorize" ||
		pathname === "/callback" ||
		pathname === "/store-token"
	) {
		return "oauth";
	}
	return "unknown";
}

function inferAuthMode(pathname: string): AuthMode {
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

export function resolvePathMetricContext(
	pathname: string,
): RequestMetricContext {
	const explicitContext = getExplicitRouteContext(pathname);
	if (explicitContext) {
		return explicitContext;
	}

	if (pathname.startsWith("/api")) {
		return API_ROUTE_CONTEXT;
	}

	return {
		...UNKNOWN_ROUTE_CONTEXT,
		transport: inferTransport(pathname),
		apiSurface: inferApiSurface(pathname),
		authMode: inferAuthMode(pathname),
	};
}

export function getRouteGroup(pathname: string): RouteGroup {
	return resolvePathMetricContext(pathname).routeGroup;
}

export function getTransport(pathname: string): Transport {
	return resolvePathMetricContext(pathname).transport;
}

export function getApiSurface(pathname: string): ApiSurface {
	return resolvePathMetricContext(pathname).apiSurface;
}

export function getAuthMode(pathname: string): AuthMode {
	return resolvePathMetricContext(pathname).authMode;
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
	return resolvePathMetricContext(pathname);
}
