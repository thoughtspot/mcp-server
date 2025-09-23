import { trace } from '@opentelemetry/api';
import { instrument, type ResolveConfigFn, instrumentDO, type TraceConfig } from '@microlabs/otel-cf-workers';
import OAuthProvider from "@cloudflare/workers-oauth-provider";

import handler from "./handlers";
import type { Props } from "./utils";
import { instrumentedMCPServer } from "./cloudflare-utils";
import { MCPServer } from "./servers/mcp-server";
import { apiServer } from "./servers/api-server";
import { withBearerHandler } from "./bearer";
import { OpenAIDeepResearchMCPServer } from './servers/openai-mcp-server';

// OTEL configuration function
const config: ResolveConfigFn = (env: Env, _trigger) => {
    return {
        exporter: {
            url: 'https://api.honeycomb.io/v1/traces',
            headers: { 'x-honeycomb-team': process.env.HONEYCOMB_API_KEY },
        },
        service: { name: process.env.HONEYCOMB_DATASET }
    } as TraceConfig;
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
        "/api": apiServer as any, // TODO: Remove 'any'
    },
    defaultHandler: withBearerHandler(handler, ThoughtSpotMCP) as any, // TODO: Remove 'any'
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
});

// Wrap the OAuth provider with a handler that includes tracing
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

        return oauthProvider.fetch(request, env, ctx);
    }
};


// Export the instrumented handler
export default instrument(oauthHandler, config);

