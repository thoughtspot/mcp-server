import { trace } from '@opentelemetry/api';
import { instrument, type ResolveConfigFn, instrumentDO } from '@microlabs/otel-cf-workers';
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import handler from "./handlers";
import type { Props } from "./utils";
import { MCPServer } from "./servers/mcp-server";
import { apiServer } from "./servers/api-server";
import { withBearerHandler } from "./bearer";

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

class ThoughtSpotMCPCore extends McpAgent<Env, any, Props> {
    server = new MCPServer(this);


    // Argument of type 'typeof ThoughtSpotMCPWrapper' is not assignable to parameter of type 'DOClass'.
    // Cannot assign a 'protected' constructor type to a 'public' constructor type.
    // Created to satisfy the DOClass type.
    // biome-ignore lint/complexity/noUselessConstructor: required for DOClass
    public constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }

    async init() {
        await this.server.init();
    }
}

// Create the instrumented ThoughtSpotMCP for the main export
export const ThoughtSpotMCP = instrumentDO(ThoughtSpotMCPCore, config);

// Create the OAuth provider instance
const oauthProvider = new OAuthProvider({
    apiHandlers: {
        "/mcp": ThoughtSpotMCP.serve("/mcp") as any, // TODO: Remove 'any'
        "/sse": ThoughtSpotMCP.serveSSE("/sse") as any, // TODO: Remove 'any'
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

