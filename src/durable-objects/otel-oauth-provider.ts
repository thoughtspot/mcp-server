import { instrumentDO, ResolveConfigFn } from '@microlabs/otel-cf-workers';
import type { DurableObject } from '@cloudflare/workers-types';
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import handler from "../handlers";
import type { Props } from "../utils";
import { MCPServer } from "../servers/mcp-server";
import { apiServer } from "../servers/api-server";
import { withBearerHandler } from "../bearer";

// OpenTelemetry configuration
const doConfig: ResolveConfigFn = (env: Env, _trigger) => {
	return {
		exporter: {
			url: 'https://api.honeycomb.io/v1/traces',
			headers: { 'x-honeycomb-team': process.env.HONEYCOMB_API_KEY },
		},
		service: { name: 'thoughtspot-mcp-server' },
	}
};

// Base ThoughtSpotMCP class
export class BaseThoughtSpotMCP extends McpAgent<Env, any, Props> {
    server = new MCPServer(this);

    async init() {
        await this.server.init();
    }
}

// Wrapper class with public constructor for instrumentDO
class ThoughtSpotMCPWrapper extends BaseThoughtSpotMCP {
    public constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }
    // static serve(path: string) {
    //     return BaseThoughtSpotMCP.serve(path);
    // }
    // static serveSSE(path: string) {
    //     return BaseThoughtSpotMCP.serveSSE(path);
    // }
}

// Create the instrumented ThoughtSpotMCP for the main export
export const ThoughtSpotMCP = instrumentDO(ThoughtSpotMCPWrapper, doConfig);

// Create the OAuth provider instance
const oauthProvider = new OAuthProvider({
    apiHandlers: {
        "/mcp": ThoughtSpotMCP.serve("/mcp") as any,
        "/sse": ThoughtSpotMCP.serveSSE("/sse") as any,
        "/api": apiServer as any,
    },
    defaultHandler: withBearerHandler(handler, ThoughtSpotMCP) as any,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
});

// Durable Object class that wraps the OAuth provider
class OtelOAuthProviderDO implements DurableObject {
    private oauthProvider: typeof oauthProvider;

    constructor(private state: DurableObjectState, private env: Env) {
        this.oauthProvider = oauthProvider;
    }

    async fetch(request: Request): Promise<Response> {
        // Delegate to the OAuth provider with proper execution context
        return this.oauthProvider.fetch(request as any, this.env, {
            waitUntil: (promise: Promise<any>) => this.state.waitUntil(promise),
            passThroughOnException: () => {},
            props: {} // Initialize with empty props, will be set by the handler
        });
    }
}

// Export the instrumented durable object
export const InstrumentedOAuthProviderDO = instrumentDO(OtelOAuthProviderDO, doConfig); 