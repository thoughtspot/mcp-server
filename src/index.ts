import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import handler from "./handlers";
import { Props } from "./utils";
import { getThoughtSpotClient } from "./thoughtspot/thoughtspot-client";
import { getRelevantData } from "./thoughtspot/relevant-data";

export class ThoughtSpotMCP extends McpAgent<Env, any, Props> {
    server = new McpServer({
        name: "ThoughtSpot",
        version: "1.0.0",
    });

    async init() {
        this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
            content: [{ type: "text", text: String(a + b) }],
        }));

        this.server.tool(
            "getRelevantData",
            "Get relevant data from ThoughtSpot database",
            {
                query: z.string().describe("The query to get relevant data for")
            },
            async ({ query }) => {
                const client = getThoughtSpotClient(this.props.instanceUrl, this.props.accessToken);
                const relevantData = await getRelevantData(query, false, (data) => this.server.server.notification({
                    method: "notifications/progress",
                    params: {
                        message: data,
                        progressToken: Math.random().toString(36).substring(2, 15),
                        progress: 50,
                        total: 100,
                    },
                }), client);
                return {
                    content: [{
                        type: "text",
                        text: relevantData.allAnswers.map((answer) => `Question: ${answer.question}\nAnswer: ${answer.data}`).join("\n\n")
                    }, {
                        type: "text",
                        text: `Dashboard Url: ${relevantData.liveboard}`,
                    }],
                };
            });

        // Tool that returns the user's bearer token
        // This is just for demonstration purposes, don't actually create a tool that does this!
        this.server.tool("getToken", {}, async () => ({
            content: [{ type: "text", text: String(`User's token: ${this.props.accessToken}`) }],
        }));
    }
}


export default new OAuthProvider({
    apiHandlers: {
        "/mcp": ThoughtSpotMCP.serve("/mcp") as any, // TODO: Remove 'any'
        "/sse": ThoughtSpotMCP.serveSSE("/sse") as any, // TODO: Remove 'any'
    },
    defaultHandler: handler as any, // TODO: Remove 'any'
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
});
