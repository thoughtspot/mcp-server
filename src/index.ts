import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import handler from "./handlers";
import type { Props } from "./utils";
import { MCPServer } from "./servers/mcp-server";
import { apiServer } from "./servers/api-server";
import { withBearerHandler } from "./bearer";

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
    defaultHandler: withBearerHandler(handler, ThoughtSpotMCP) as any, // TODO: Remove 'any'
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
});
