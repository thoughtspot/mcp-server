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
    accessTokenTTL: 1728000, // 20 days,
    tokenExchangeCallback: async (options) => {
        if (options.grantType === "refresh_token") {
                if (options.grantType === "refresh_token") {
                  const { accessToken, instanceUrl } = options.props;
                  // fetch a new TS token
              
                  const url = `${instanceUrl}/callosum/v1/v2/auth/token/fetch?validity_time_in_sec=2592000`; // 30 days
              
                  const response = await fetch(url, {
                    method: "GET",
                    headers: {
                      Authorization: `Bearer ${accessToken}`, // old token (may still be valid)
                      Accept: "application/json",
                      "User-Agent": "ThoughtSpot-ts-client",
                    },
                  });
              
                  if (!response.ok) {
                    
                    console.error("Failed to fetch new TS token:", await response.text());
              
                    // Don't issue new Cloudflare token — force user to reauth
                    throw new Error(JSON.stringify({
                      error: "invalid_grant",
                      error_description: "TS access token expired. Please reauthenticate."
                    }));
                  }
              
                  const data = await response.json();
                  const newToken = data.data?.token;
              
              
                  return {
                    accessTokenProps: {
                      ...options.props,
                      accessToken: newToken,
                    },
                    newProps: {
                      ...options.props,
                      accessToken: newToken,
                    },
                    accessTokenTTL:1728000 // 20 days
                  };
              };
        }
        // fallback to default behavior for other grant types
        return;
    },
});
