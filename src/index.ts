import { trace } from '@opentelemetry/api';
import { instrument, type ResolveConfigFn, instrumentDO } from '@microlabs/otel-cf-workers';
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import handler from "./handlers";
import { type Props, instrumentedMCPServer } from "./utils";
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
        "/api": apiServer as any, // TODO: Remove 'any'
    },
    defaultHandler: withBearerHandler(handler, ThoughtSpotMCP) as any, // TODO: Remove 'any'
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    accessTokenTTL: 60, // 1 day
    // tokenExchangeCallback: async (options) => {
    //     if (options.grantType === "refresh_token") {
    //         const { accessToken, instanceUrl, refreshToken } = options.props;
            
    //         if (!refreshToken) {
    //             // skip the refresh token grant if the refresh token is not available
    //             // fallback to default behavior for other grant types
    //             return;
    //         }

    //         // fetch a new TS token using the refresh token
    //         console.log("Refresh token grant called");

    //         const url = `${instanceUrl}/callosum/v1/v2/auth/token/fetch?validity_time_in_sec=86400`; // 1 day

    //         const response = await fetch(url, {
    //         method: "GET",
    //         headers: {
    //             Authorization: `Bearer ${refreshToken}`, // old token (may still be valid)
    //             Accept: "application/json",
    //             "User-Agent": "ThoughtSpot-mcp-agent",
    //         },
    //         });

    //         if (!response.ok) {

    //             console.error("Failed to fetch new TS token:", await response.text());

    //             // Don't issue new Cloudflare token — force user to reauth
                
    //             throw new Error(JSON.stringify({
    //                 error: "unauthorized",
    //                 error_description: "TS access token expired. Please reauthenticate."
    //             }));
    //         }

    //         const data = await response.json();
    //         const newAccessToken = data.data?.token;

    //         // revoke the old refresh token
    //         const revokeUrl = `${instanceUrl}/callosum/v1/v2/auth/token/revoke`;
    //         await fetch(revokeUrl, {
    //             method: "POST",
    //             headers: {
    //                 Authorization: `Bearer ${refreshToken}`,
            
    //         });

    //         // fetch a new refresh token
    //         const refreshUrl = `${instanceUrl}/callosum/v1/v2/auth/token/fetch?validity_time_in_sec=120000`; // 120 days
    //         const refreshResponse = await fetch(refreshUrl, {
    //             method: "GET",
    //             headers: {
    //                 Authorization: `Bearer ${newAccessToken}`,
    //                 Accept: "application/json",
    //                 "User-Agent": "ThoughtSpot-mcp-agent",
    //             },
    //         });
            
    //         const refreshData = await refreshResponse.json();
    //         const newRefreshToken = refreshData.data?.token;


    //         return {
    //             newProps: {
    //                 ...options.props,
    //                 accessToken: newAccessToken,
    //                 refreshToken: newRefreshToken,
    //             },
    //             accessTokenTTL: 60, // 5 hours
    //         };
    //     };
    //     // fallback to default behavior for other grant types
    //     return;
    // },
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

