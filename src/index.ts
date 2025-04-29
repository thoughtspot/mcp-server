import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import handler from "./handlers";
import { Props } from "./utils";

export class ThoughtSpotMCP extends McpAgent<Props, Env> {
    server = new McpServer({
        name: "ThoughtSpot",
        version: "1.0.0",
    });

    async init() {
        this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
            content: [{ type: "text", text: String(a + b) }],
        }));

        // Tool that returns the user's bearer token
        // This is just for demonstration purposes, don't actually create a tool that does this!
        this.server.tool("getToken", {}, async () => ({
            content: [{ type: "text", text: String(`User's token: ${this.props.accessToken}`) }],
        }));
    }
}


export default new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: ThoughtSpotMCP.serve("/mcp") as any, // TODO: Remove 'any'
    defaultHandler: handler as any, // TODO: Remove 'any'
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
});
