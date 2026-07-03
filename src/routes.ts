import {
	PUBLIC_ROUTES as PKG_PUBLIC_ROUTES,
	PUBLIC_ROUTE_PREFIXES as PKG_PUBLIC_ROUTE_PREFIXES,
} from "@thoughtspot/mcp-auth";

// mcp-server-specific public routes layered on top of pkg-provided OAuth routes.
export const PUBLIC_ROUTES = {
	...PKG_PUBLIC_ROUTES,
	openaiAppsChallenge: "/.well-known/openai-apps-challenge",
} as const;

export const PUBLIC_ROUTE_PREFIXES = PKG_PUBLIC_ROUTE_PREFIXES;

export const EXACT_PUBLIC_ROUTES_REQUIRING_METRICS = [
	PUBLIC_ROUTES.root,
	PUBLIC_ROUTES.authorize,
	PUBLIC_ROUTES.callback,
	PUBLIC_ROUTES.storeToken,
	PUBLIC_ROUTES.oauthToken,
	PUBLIC_ROUTES.register,
	PUBLIC_ROUTES.mcp,
	PUBLIC_ROUTES.sse,
	PUBLIC_ROUTES.bearerMcp,
	PUBLIC_ROUTES.bearerSse,
	PUBLIC_ROUTES.tokenMcp,
	PUBLIC_ROUTES.tokenSse,
	PUBLIC_ROUTES.openaiAppsChallenge,
] as const;
