import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Props } from "./utils";
import { getRelevantData } from "./thoughtspot/relevant-data";
import { getThoughtSpotClient } from "./thoughtspot/thoughtspot-client";


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

interface Context {
    props: Props;
}

export class MCPServer extends Server {
    constructor(private ctx: Context) {
        super({
            name: "ThoughtSpot",
            version: "1.0.0",
            capabilities: {
                tools: {},
                logging: {},
                completion: {},
                resources: {},
            }
        });
    }

    async init() {
        this.setRequestHandler(ListToolsRequestSchema, async () => {
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
        this.setRequestHandler(CallToolRequestSchema, async (request: z.infer<typeof CallToolRequestSchema>) => {
            const { name } = request.params;

            switch (name) {
                case ToolName.Ping:
                    if (this.ctx.props.accessToken && this.ctx.props.instanceUrl) {
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
        const client = getThoughtSpotClient(this.ctx.props.instanceUrl, this.ctx.props.accessToken);
        const progressToken = request.params._meta?.progressToken;
        let progress = 0;

        const relevantData = await getRelevantData(query, false, (data) => this.notification({
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
