export const PUBLIC_ROUTES = {
	root: "/",
	hello: "/hello",
	authorize: "/authorize",
	callback: "/callback",
	storeToken: "/store-token",
	oauthToken: "/token",
	register: "/register",
	mcp: "/mcp",
	sse: "/sse",
	bearerMcp: "/bearer/mcp",
	bearerSse: "/bearer/sse",
	tokenMcp: "/token/mcp",
	tokenSse: "/token/sse",
	openaiAppsChallenge: "/.well-known/openai-apps-challenge",
} as const;

export const PUBLIC_ROUTE_PREFIXES = {
	bearer: "/bearer",
	token: "/token",
} as const;

export const EXACT_PUBLIC_ROUTES_REQUIRING_METRICS = [
	PUBLIC_ROUTES.root,
	PUBLIC_ROUTES.hello,
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
