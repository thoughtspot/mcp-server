import { PUBLIC_ROUTES, PUBLIC_ROUTE_PREFIXES } from "../../routes";
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
	[PUBLIC_ROUTES.root]: {
		routeGroup: "root",
		transport: "http",
		apiSurface: "static",
		authMode: "none",
	},
	[PUBLIC_ROUTES.hello]: {
		routeGroup: "hello",
		transport: "http",
		apiSurface: "static",
		authMode: "none",
	},
	[PUBLIC_ROUTES.authorize]: {
		routeGroup: "authorize",
		transport: "http",
		apiSurface: "oauth",
		authMode: "none",
	},
	[PUBLIC_ROUTES.callback]: {
		routeGroup: "callback",
		transport: "http",
		apiSurface: "oauth",
		authMode: "none",
	},
	[PUBLIC_ROUTES.storeToken]: {
		routeGroup: "store_token",
		transport: "http",
		apiSurface: "oauth",
		authMode: "none",
	},
	[PUBLIC_ROUTES.oauthToken]: {
		routeGroup: "oauth_token",
		transport: "http",
		apiSurface: "oauth",
		authMode: "none",
	},
	[PUBLIC_ROUTES.register]: {
		routeGroup: "register",
		transport: "http",
		apiSurface: "oauth",
		authMode: "none",
	},
	[PUBLIC_ROUTES.mcp]: {
		routeGroup: "mcp",
		transport: "mcp",
		apiSurface: "mcp",
		authMode: "oauth",
	},
	[PUBLIC_ROUTES.sse]: {
		routeGroup: "sse",
		transport: "sse",
		apiSurface: "mcp",
		authMode: "oauth",
	},
	[PUBLIC_ROUTES.bearerMcp]: {
		routeGroup: "bearer_mcp",
		transport: "mcp",
		apiSurface: "mcp",
		authMode: "bearer",
	},
	[PUBLIC_ROUTES.bearerSse]: {
		routeGroup: "bearer_sse",
		transport: "sse",
		apiSurface: "mcp",
		authMode: "bearer",
	},
	[PUBLIC_ROUTES.tokenMcp]: {
		routeGroup: "token_mcp",
		transport: "mcp",
		apiSurface: "mcp",
		authMode: "token",
	},
	[PUBLIC_ROUTES.tokenSse]: {
		routeGroup: "token_sse",
		transport: "sse",
		apiSurface: "mcp",
		authMode: "token",
	},
	[PUBLIC_ROUTES.openaiAppsChallenge]: {
		routeGroup: "openai_apps_challenge",
		transport: "http",
		apiSurface: "static",
		authMode: "none",
	},
} as const satisfies Record<string, RequestMetricContext>;

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

function matchesRoutePrefix(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function inferTransport(pathname: string): Transport {
	if (pathname.endsWith(PUBLIC_ROUTES.mcp) || pathname === PUBLIC_ROUTES.mcp) {
		return "mcp";
	}
	if (pathname.endsWith(PUBLIC_ROUTES.sse) || pathname === PUBLIC_ROUTES.sse) {
		return "sse";
	}
	return "http";
}

function inferApiSurface(pathname: string): ApiSurface {
	if (
		pathname === PUBLIC_ROUTES.mcp ||
		pathname === PUBLIC_ROUTES.sse ||
		matchesRoutePrefix(pathname, PUBLIC_ROUTE_PREFIXES.bearer) ||
		matchesRoutePrefix(pathname, PUBLIC_ROUTE_PREFIXES.token)
	) {
		return "mcp";
	}
	if (
		pathname === PUBLIC_ROUTES.root ||
		pathname === PUBLIC_ROUTES.hello ||
		pathname === PUBLIC_ROUTES.openaiAppsChallenge
	) {
		return "static";
	}
	if (
		pathname === PUBLIC_ROUTES.authorize ||
		pathname === PUBLIC_ROUTES.callback ||
		pathname === PUBLIC_ROUTES.storeToken ||
		pathname === PUBLIC_ROUTES.oauthToken ||
		pathname === PUBLIC_ROUTES.register
	) {
		return "oauth";
	}
	return "unknown";
}

function inferAuthMode(pathname: string): AuthMode {
	if (matchesRoutePrefix(pathname, PUBLIC_ROUTE_PREFIXES.bearer)) {
		return "bearer";
	}
	if (matchesRoutePrefix(pathname, PUBLIC_ROUTE_PREFIXES.token)) {
		return "token";
	}
	if (pathname === PUBLIC_ROUTES.mcp || pathname === PUBLIC_ROUTES.sse) {
		return "oauth";
	}
	if (
		pathname === PUBLIC_ROUTES.root ||
		pathname === PUBLIC_ROUTES.hello ||
		pathname === PUBLIC_ROUTES.authorize ||
		pathname === PUBLIC_ROUTES.callback ||
		pathname === PUBLIC_ROUTES.storeToken ||
		pathname === PUBLIC_ROUTES.oauthToken ||
		pathname === PUBLIC_ROUTES.register ||
		pathname === PUBLIC_ROUTES.openaiAppsChallenge
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
