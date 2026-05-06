import OAuthProvider from "@cloudflare/workers-oauth-provider";
import {
	type ResolveConfigFn,
	type TraceConfig,
	instrument,
} from "@microlabs/otel-cf-workers";
import { trace } from "@opentelemetry/api";

import { withBearerHandler } from "./bearer";
import { instrumentedMCPServer } from "./cloudflare-utils";
import handler from "./handlers";
import {
	recordHttpRequestMetrics,
	withRequestMetrics,
} from "./metrics/runtime/request-metrics";
import { PUBLIC_ROUTES } from "./routes";
import { ConversationStorageServer } from "./servers/conversation-storage-server";
import { MCPServer } from "./servers/mcp-server";

export { ConversationStorageServer };

// OTEL configuration function
const config: ResolveConfigFn = (env: Env, _trigger) => {
	return {
		exporter: {
			url: "https://api.honeycomb.io/v1/traces",
			headers: { "x-honeycomb-team": process.env.HONEYCOMB_API_KEY },
		},
		service: { name: process.env.HONEYCOMB_DATASET },
	} as TraceConfig;
};

// Create the instrumented ThoughtSpotMCP for the main export
export const ThoughtSpotMCP = instrumentedMCPServer(MCPServer, config);

// Router function to handle query params and inject apiVersion into props
function createMCPRouter(
	path: string,
	serverClass: typeof ThoughtSpotMCP,
	serveMethod: "serve" | "serveSSE",
	options?: { binding?: string },
) {
	return {
		async fetch(
			request: Request,
			env: Env,
			ctx: ExecutionContext,
		): Promise<Response> {
			const url = new URL(request.url);
			let apiVersion = url.searchParams.get("api-version");

			// TODO(Rifdhan): this is a temporary backwards compatibility measure. In the future
			// we will use latest by default.
			if (!apiVersion) {
				apiVersion = "backwards-compatibility-default";
			}

			// Inject apiVersion into props
			const originalProps = (ctx as any).props || {};
			(ctx as any).props = {
				...originalProps,
				apiVersion,
			};

			// Route to the appropriate serve method
			return serverClass[serveMethod](path, options).fetch(request, env, ctx);
		},
	};
}

// Create the OAuth provider instance
const oauthProvider = new OAuthProvider({
	apiHandlers: {
		[PUBLIC_ROUTES.mcp]: createMCPRouter(
			PUBLIC_ROUTES.mcp,
			ThoughtSpotMCP,
			"serve",
		) as any,
		[PUBLIC_ROUTES.sse]: createMCPRouter(
			PUBLIC_ROUTES.sse,
			ThoughtSpotMCP,
			"serveSSE",
		) as any,
	},
	defaultHandler: withBearerHandler(handler, ThoughtSpotMCP) as any, // TODO: Remove 'any'
	authorizeEndpoint: PUBLIC_ROUTES.authorize,
	tokenEndpoint: PUBLIC_ROUTES.oauthToken,
	clientRegistrationEndpoint: PUBLIC_ROUTES.register,
});

// Wrap the OAuth provider with a handler that includes tracing
const oauthHandler = {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		// Add OpenTelemetry tracing attributes
		const span = trace.getActiveSpan();
		if (span) {
			span.setAttributes({
				component: "OAuthProvider",
				instance_url: (ctx as any).props?.instanceUrl || "unknown",
				request_url: request.url,
				request_method: request.method,
			});
		}

		return oauthProvider.fetch(request, env, ctx);
	},
};

const instrumentedOAuthHandler = instrument(oauthHandler, config);

// OTEL instrumentation automatically uses or passing along some headers from upstream calls, so we
// need to strip them from the request before OTEL sees them if we don't want that to happen
const HEADERS_TO_STRIP = ["traceparent", "tracestate"];
export default {
	async fetch(
		request: Request<unknown, IncomingRequestCfProperties<unknown>>,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		if (HEADERS_TO_STRIP.some((header) => request.headers.has(header))) {
			const headers = new Headers(request.headers);
			HEADERS_TO_STRIP.forEach((header) => headers.delete(header));
			request = new Request(request, { headers });
		}

		return withRequestMetrics(
			env as unknown as Record<string, unknown>,
			ctx,
			async (recorder) => {
				const requestStartMs = Date.now();

				try {
					const response = await instrumentedOAuthHandler.fetch!(
						request,
						env,
						ctx,
					);
					recordHttpRequestMetrics(
						recorder,
						request,
						response,
						ctx,
						Date.now() - requestStartMs,
					);
					return response;
				} catch (error) {
					recordHttpRequestMetrics(
						recorder,
						request,
						new Response(null, { status: 500 }),
						ctx,
						Date.now() - requestStartMs,
					);
					throw error;
				}
			},
		);
	},
};
