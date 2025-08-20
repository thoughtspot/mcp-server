import { trace } from '@opentelemetry/api';
import { instrument, type ResolveConfigFn, instrumentDO } from '@microlabs/otel-cf-workers';
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import handler from "./handlers";
import { instrumentedMCPServer } from "./utils";
import { MCPServer } from "./servers/mcp-server";
import { apiServer } from "./servers/api-server";
import { withBearerHandler } from "./bearer";
import { OpenAIDeepResearchMCPServer } from './servers/openai-mcp-server';
import { a2aHandler } from './a2a/agent-executor';

// OTEL configuration function
const config: ResolveConfigFn = (env: Env, _trigger) => {
    return {
        exporter: {
            url: 'https://api.honeycomb.io/v1/traces',
            headers: { 'x-honeycomb-team': process.env.HONEYCOMB_API_KEY },
        },
        service: { name: process.env.HONEYCOMB_DATASET }
    };
};

// Create the instrumented ThoughtSpotMCP for the main export
export const ThoughtSpotMCP = instrumentedMCPServer(MCPServer, config);

export const ThoughtSpotOpenAIDeepResearchMCP = instrumentedMCPServer(OpenAIDeepResearchMCPServer, config);

// Create the OAuth provider instance
const oauthProvider = new OAuthProvider({
    apiHandlers: {
        "/mcp": ThoughtSpotMCP.serve("/mcp") as any, // TODO: Remove 'any'
        "/sse": ThoughtSpotMCP.serveSSE("/sse") as any, // TODO: Remove 'any'
        '/openai/mcp': ThoughtSpotOpenAIDeepResearchMCP.serve("/openai/mcp", {
            binding: "OPENAI_DEEP_RESEARCH_MCP_OBJECT"
        }) as any, // TODO: Remove 'any'
        '/openai/sse': ThoughtSpotOpenAIDeepResearchMCP.serveSSE("/openai/sse", {
            binding: "OPENAI_DEEP_RESEARCH_MCP_OBJECT"
        }) as any, // TODO: Remove 'any'
        "/a2a": a2aHandler as any, // TODO: Remove 'any'
        "/api": apiServer as any, // TODO: Remove 'any'
    },
    defaultHandler: withBearerHandler(handler, ThoughtSpotMCP) as any, // TODO: Remove 'any'
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
});

// Wrap the OAuth provider with a handler that includes tracing and specific error handling
const oauthHandler = {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // Add OpenTelemetry tracing attributes
        const span = trace.getActiveSpan();
        if (span) {
            span.setAttributes({
                component: 'OAuthProvider',
                instance_url: (ctx as any).props?.instanceUrl || 'unknown',
                request_url: request.url,
                request_method: request.method,
            });
        }
        const response = await oauthProvider.fetch(request, env, ctx);
        if (response.status === 401) {
            console.error("OAuth error");
            const url = new URL(request.url);
            const pathname = url.pathname;
            
            
            // Specific error handling for /a2a path
            // this will return 401 to a2a and it will trigger the oauth flow.
            if (pathname === "/a2a") {
                console.error("A2A path error");
                return new Response(JSON.stringify({
                    error: "A2A Authentication Failed",
                    message: "Unable to authenticate with A2A service. Please check your credentials and try again.",
                    code: "A2A_AUTH_ERROR"
                }), {
                    status: 401,
                    headers: {
                        "Content-Type": "text/event-stream"
                    }
                });
            }
        }
        return response;
    }
};


// Export the instrumented handler
export default instrument(oauthHandler, config);

