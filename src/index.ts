import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import handler from "./handlers";
import { Props } from "./utils";
import { getThoughtSpotClient } from "./thoughtspot/thoughtspot-client";
import { getRelevantData } from "./thoughtspot/relevant-data";


const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

const PingSchema = z.object({});

const GetRelevantDataSchema = z.object({
    query: z.string().describe("The query to get relevant data for, this could be a high level task or question the user is asking or hoping to get answered")
});

enum ToolName {
    Ping = "ping",
    GetRelevantData = "getRelevantData",
}

export class ThoughtSpotMCP extends McpAgent<Env, any, Props> {
    server = new Server({
        name: "ThoughtSpot",
        version: "1.0.0",
        capabilities: {
            tools: {},
            logging: {},
            completion: {},
            resources: {},
        }
    });

    async init() {
        // Handle list tools request
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: ToolName.Ping,
                        description: "Simple ping tool to test connectivity and Auth",
                        inputSchema: zodToJsonSchema(PingSchema) as ToolInput,
                    },
                    {
                        name: ToolName.GetRelevantData,
                        description: "Get relevant data from ThoughtSpot database",
                        inputSchema: zodToJsonSchema(GetRelevantDataSchema) as ToolInput,
                    }
                ]
            };
        });

        // Handle call tool request
        this.server.setRequestHandler(CallToolRequestSchema, async (request: z.infer<typeof CallToolRequestSchema>) => {
            const { name } = request.params;

            switch (name) {
                case ToolName.Ping:
                    if (this.props.accessToken && this.props.instanceUrl) {
                        return {
                            content: [{ type: "text", text: "Pong" }],
                        };
                    } else {
                        return {
                            content: [{ type: "text", text: "ERROR: Not authenticated" }],
                        };
                    }

                case ToolName.GetRelevantData: {
                    return this.callGetRelevantData(request);
                }

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async callGetRelevantData(request: z.infer<typeof CallToolRequestSchema>) {
        const { query } = GetRelevantDataSchema.parse(request.params.arguments);
        const client = getThoughtSpotClient(this.props.instanceUrl, this.props.accessToken);
        const progressToken = request.params._meta?.progressToken;
        let progress = 0;

        const relevantData = await getRelevantData(query, false, (data) => this.server.notification({
            method: "notifications/progress",
            params: {
                message: data,
                progressToken: progressToken,
                progress: Math.max(progress++ * 10, 100),
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
