import type { ThoughtSpotMCP } from ".";
import type honoApp from "./handlers";
import { validateAndSanitizeUrl } from "./oauth-manager/oauth-utils";
import { PUBLIC_ROUTES, PUBLIC_ROUTE_PREFIXES } from "./routes";

/**
 * Handler function for bearer/token authentication endpoints
 * @param req - Incoming request
 * @param env - Environment bindings
 * @param ctx - Execution context
 * @param MCPServer - MCP server instance
 * @param apiVersionOverride - Optional API version override (ignore value in request)
 */
function handleTokenAuth(
	req: Request,
	env: Env,
	ctx: ExecutionContext,
	MCPServer: typeof ThoughtSpotMCP,
	apiVersionOverride?: string,
): Response | Promise<Response> {
	const authHeader = req.headers.get("authorization");
	if (!authHeader) {
		return new Response("Bearer token is required", { status: 400 });
	}

	let accessToken = authHeader.split(" ")[1];
	let tsHost: string | null;

	if (accessToken.includes("@")) {
		[accessToken, tsHost] = accessToken.split("@");
	} else {
		tsHost = req.headers.get("x-ts-host");
	}

	if (!tsHost) {
		return new Response(
			"TS Host is required, either in the authorization header as 'token@ts-host' or as a separate 'x-ts-host' header",
			{ status: 400 },
		);
	}

	const clientName =
		req.headers.get("x-ts-client-name") || "Bearer Token client";

	const url = new URL(req.url);

	// Build props object
	const props: any = {
		accessToken: accessToken,
		instanceUrl: validateAndSanitizeUrl(tsHost),
		clientName,
	};

	// Resolve API version to use
	const apiVersion = apiVersionOverride ?? url.searchParams.get("api-version");
	if (apiVersion) {
		props.apiVersion = apiVersion;
	}

	(ctx as any).props = props;

	// Route to appropriate handler
	const pathname = url.pathname;
	if (pathname.endsWith(PUBLIC_ROUTES.mcp)) {
		return MCPServer.serve(PUBLIC_ROUTES.mcp).fetch(req, env, ctx);
	}

	if (pathname.endsWith(PUBLIC_ROUTES.sse)) {
		return MCPServer.serveSSE(PUBLIC_ROUTES.sse).fetch(req, env, ctx);
	}

	return new Response("Not found", { status: 404 });
}

export function withBearerHandler(
	app: typeof honoApp,
	MCPServer: typeof ThoughtSpotMCP,
) {
	// These endpoints do NOT support api-version query params (will be removed in future)
	// Use /token endpoints instead for new implementations
	app.mount(PUBLIC_ROUTE_PREFIXES.bearer, (req, env, ctx) => {
		return handleTokenAuth(
			req,
			env,
			ctx,
			MCPServer,
			"backwards-compatibility-default",
		);
	});

	// NEW: /token endpoints - supports api-version query params
	// Recommended for all new implementations
	app.mount(PUBLIC_ROUTE_PREFIXES.token, (req, env, ctx) => {
		return handleTokenAuth(req, env, ctx, MCPServer);
	});

	return app;
}
