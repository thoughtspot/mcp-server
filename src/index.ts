import { trace } from "@opentelemetry/api";
import {
	instrument,
	type ResolveConfigFn,
	instrumentDO,
	type TraceConfig,
} from "@microlabs/otel-cf-workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";

import handler from "./handlers";
import type { Props } from "./utils";
import { instrumentedMCPServer } from "./cloudflare-utils";
import { MCPServer } from "./servers/mcp-server";
import { apiServer } from "./servers/api-server";
import { withBearerHandler } from "./bearer";
import { OpenAIDeepResearchMCPServer } from "./servers/openai-mcp-server";

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

			// Inject apiVersion into props if it's "beta"
			if (apiVersion === "beta") {
				const originalProps = (ctx as any).props || {};
				(ctx as any).props = {
					...originalProps,
					apiVersion: "beta" as const,
				};
			}

			// Route to the appropriate serve method
			return serverClass.serve(path, options).fetch(request, env, ctx);
		},
	};
}

// Router function for SSE endpoints
function createMCPRouterSSE(
	path: string,
	serverClass: typeof ThoughtSpotMCP,
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

			// Inject apiVersion into props if it's "beta"
			if (apiVersion === "beta") {
				const originalProps = (ctx as any).props || {};
				(ctx as any).props = {
					...originalProps,
					apiVersion: "beta" as const,
				};
			}

			// Route to the appropriate serveSSE method
			return serverClass.serveSSE(path, options).fetch(request, env, ctx);
		},
	};
}

// Create the OAuth provider instance
const oauthProvider = new OAuthProvider({
	apiHandlers: {
		"/mcp": createMCPRouter("/mcp", ThoughtSpotMCP) as any,
		"/sse": createMCPRouterSSE("/sse", ThoughtSpotMCP) as any,
		"/openai/mcp": ThoughtSpotOpenAIDeepResearchMCP.serve("/openai/mcp", {
			binding: "OPENAI_DEEP_RESEARCH_MCP_OBJECT",
		}) as any, // TODO: Remove 'any'
		"/openai/sse": ThoughtSpotOpenAIDeepResearchMCP.serveSSE("/openai/sse", {
			binding: "OPENAI_DEEP_RESEARCH_MCP_OBJECT",
		}) as any, // TODO: Remove 'any'
		"/api": apiServer as any, // TODO: Remove 'any'
		"/bearer/mcp": withBearerHandler(handler, ThoughtSpotMCP) as any,
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

// Export the instrumented handler
export default instrument(oauthHandler, config);
