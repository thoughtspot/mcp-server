import { trace } from "@opentelemetry/api";
import {
	instrument,
	type ResolveConfigFn,
	type TraceConfig,
} from "@microlabs/otel-cf-workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";

import handler from "./handlers";
import { instrumentedMCPServer } from "./cloudflare-utils";
import { MCPServer } from "./servers/mcp-server";
import { apiServer } from "./servers/api-server";
import { withBearerHandler } from "./bearer";
import { OpenAIDeepResearchMCPServer } from "./servers/openai-mcp-server";
import { ConversationStorageServer } from "./servers/conversation-storage-server";

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

export const ThoughtSpotOpenAIDeepResearchMCP = instrumentedMCPServer(
	OpenAIDeepResearchMCPServer,
	config,
);

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
			const apiVersion = url.searchParams.get("api-version");

			// Inject apiVersion into props if provided (supports "beta" or "YYYY-MM-DD" format)
			if (apiVersion) {
				const originalProps = (ctx as any).props || {};
				(ctx as any).props = {
					...originalProps,
					apiVersion,
				};
			}

			// Route to the appropriate serve method
			return serverClass[serveMethod](path, options).fetch(request, env, ctx);
		},
	};
}

const conversationStorageHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		// Path format: /storage/<conversation-id>[/<operation>]
		const parts = url.pathname.split("/");
		const conversationId = parts[2];
		if (!conversationId) {
			return new Response("Missing conversation ID", { status: 400 });
		}
		const id = env.CONVERSATION_STORAGE_OBJECT.idFromName(conversationId);
		const stub = env.CONVERSATION_STORAGE_OBJECT.get(id);
		return stub.fetch(request);
	},
};

// Create the OAuth provider instance
const oauthProvider = new OAuthProvider({
	apiHandlers: {
		"/mcp": createMCPRouter("/mcp", ThoughtSpotMCP, "serve") as any,
		"/sse": createMCPRouter("/sse", ThoughtSpotMCP, "serveSSE") as any,
		"/openai/mcp": ThoughtSpotOpenAIDeepResearchMCP.serve("/openai/mcp", {
			binding: "OPENAI_DEEP_RESEARCH_MCP_OBJECT",
		}) as any, // TODO: Remove 'any'
		"/openai/sse": ThoughtSpotOpenAIDeepResearchMCP.serveSSE("/openai/sse", {
			binding: "OPENAI_DEEP_RESEARCH_MCP_OBJECT",
		}) as any, // TODO: Remove 'any'
		"/api": apiServer as any, // TODO: Remove 'any'
		"/storage": conversationStorageHandler as any, // TODO: Remove 'any'
	},
	defaultHandler: withBearerHandler(handler, ThoughtSpotMCP) as any, // TODO: Remove 'any'
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
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
		return instrumentedOAuthHandler.fetch!(request, env, ctx);
	},
};
