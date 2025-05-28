import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import handler from "./handlers";
import type { Props } from "./utils";
import { MCPServer } from "./servers/mcp-server";
import { apiServer } from "./servers/api-server";

export class ThoughtSpotMCP extends McpAgent<Env, any, Props> {
    server = new MCPServer(this);

    async init() {
        await this.server.init();
    }
}

export default new OAuthProvider({
    apiHandlers: {
        "/mcp": ThoughtSpotMCP.serve("/mcp") as any, // TODO: Remove 'any'
        "/sse": ThoughtSpotMCP.serveSSE("/sse") as any, // TODO: Remove 'any'
        "/api": apiServer as any, // TODO: Remove 'any'
    },
    defaultHandler: handler as any, // TODO: Remove 'any'
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    accessTokenTTL: 120,
    tokenExchangeCallback: async (options) => {
        if (options.grantType === "refresh_token") {
            const { accessToken, instanceUrl } = options.props as Props;
            if (!accessToken || !instanceUrl) {
                throw new Error("Missing accessToken or instanceUrl in props");
            }

            // Call the ThoughtSpot token fetch API
            const url = `${instanceUrl.replace(/\/$/, "")}/callosum/v1/v2/auth/token/fetch?validity_time_in_sec=150`;
            const response = await fetch(url, {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${accessToken}`,
                    "Accept": "application/json",
                    "User-Agent": "ThoughtSpot-ts-client",
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to refresh token: ${response.status} ${errorText}`);
            }

            const data = await response.json() as { data: { token: string } };
            const newToken = data.data.token;
            if (!newToken) {
                throw new Error("No token found in response");
            }

            // Return new props with the refreshed token
            return {
                accessTokenProps: {
                    ...options.props,
                    accessToken: newToken,
                },
                newProps: {
                    ...options.props,
                    accessToken: newToken,
                },
                accessTokenTTL: 86300
            };
        }
        // fallback to default behavior for other grant types
        return;
    },
});
