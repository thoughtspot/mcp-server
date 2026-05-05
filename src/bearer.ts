import type { ThoughtSpotMCP } from ".";
import type honoApp from "./handlers";
import {
	getMetricsRecorderFromExecutionContext,
	recordBearerAuthRequestMetric,
} from "./metrics/runtime/request-metrics";
import { validateAndSanitizeUrl } from "./oauth-manager/oauth-utils";
import { PUBLIC_ROUTES, PUBLIC_ROUTE_PREFIXES } from "./routes";

type AuthRouteFamily = "bearer" | "token";

function getAuthMetricRouteGroup(
	pathname: string,
	authRouteFamily: AuthRouteFamily,
): "bearer_mcp" | "bearer_sse" | "token_mcp" | "token_sse" {
	if (pathname.endsWith(PUBLIC_ROUTES.sse)) {
		return authRouteFamily === "bearer" ? "bearer_sse" : "token_sse";
	}

	return authRouteFamily === "bearer" ? "bearer_mcp" : "token_mcp";
}

/**
 * Handler function for bearer/token authentication endpoints
 * @param req - Incoming request
 * @param env - Environment bindings
 * @param ctx - Execution context
 * @param MCPServer - MCP server instance
 * @param apiVersionOverride - Optional API version override (ignore value in request)
 */
async function handleTokenAuth(
	req: Request,
	env: Env,
	ctx: ExecutionContext,
	MCPServer: typeof ThoughtSpotMCP,
	apiVersionOverride?: string,
	authRouteFamily: AuthRouteFamily = "token",
): Promise<Response> {
	const recorder = getMetricsRecorderFromExecutionContext(ctx);
	const authMetricRouteGroup = getAuthMetricRouteGroup(
		new URL(req.url).pathname,
		authRouteFamily,
	);

	try {
		const authHeader = req.headers.get("authorization");
		if (!authHeader) {
			const response = new Response("Bearer token is required", {
				status: 400,
			});
			recordBearerAuthRequestMetric(
				recorder,
				req,
				response.status,
				authMetricRouteGroup,
			);
			return response;
		}

		let accessToken = authHeader.split(" ")[1];
		let tsHost: string | null;

		if (accessToken.includes("@")) {
			[accessToken, tsHost] = accessToken.split("@");
		} else {
			tsHost = req.headers.get("x-ts-host");
		}

		if (!tsHost) {
			const response = new Response(
				"TS Host is required, either in the authorization header as 'token@ts-host' or as a separate 'x-ts-host' header",
				{ status: 400 },
			);
			recordBearerAuthRequestMetric(
				recorder,
				req,
				response.status,
				authMetricRouteGroup,
			);
			return response;
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
		const apiVersion =
			apiVersionOverride ?? url.searchParams.get("api-version");
		if (apiVersion) {
			props.apiVersion = apiVersion;
		}

		(ctx as any).props = props;

		let response: Response;
		const pathname = url.pathname;
		if (pathname.endsWith(PUBLIC_ROUTES.mcp)) {
			response = await MCPServer.serve(PUBLIC_ROUTES.mcp).fetch(req, env, ctx);
		} else if (pathname.endsWith(PUBLIC_ROUTES.sse)) {
			response = await MCPServer.serveSSE(PUBLIC_ROUTES.sse).fetch(
				req,
				env,
				ctx,
			);
		} else {
			response = new Response("Not found", { status: 404 });
		}

		recordBearerAuthRequestMetric(
			recorder,
			req,
			response.status,
			authMetricRouteGroup,
		);
		return response;
	} catch (error) {
		recordBearerAuthRequestMetric(recorder, req, 500, authMetricRouteGroup);
		throw error;
	}
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
			"bearer",
		);
	});

	// NEW: /token endpoints - supports api-version query params
	// Recommended for all new implementations
	app.mount(PUBLIC_ROUTE_PREFIXES.token, (req, env, ctx) => {
		return handleTokenAuth(req, env, ctx, MCPServer, undefined, "token");
	});

	return app;
}
