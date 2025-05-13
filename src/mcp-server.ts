import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema, Tool, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Props } from "./utils";
import { getRelevantData } from "./thoughtspot/relevant-data";
import { getThoughtSpotClient } from "./thoughtspot/thoughtspot-client";
import { DataSource, getDataSources } from "./thoughtspot/thoughtspot-service";


const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

const PingSchema = z.object({});

const GetRelevantDataSchema = z.object({
    query: z.string().describe("The query to get relevant data for, this could be a high level task or question the user is asking or hoping to get answered. You can pass the complete raw query as the system is smart to make sense of it."),
    datasourceId: z.string()
        .describe("The datasource to get data from, this is the id of the datasource to get data from")
        .optional()
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
        }, {
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

        this.setRequestHandler(ListResourcesRequestSchema, async () => {
            const client = getThoughtSpotClient(this.ctx.props.instanceUrl, this.ctx.props.accessToken);
            const sources = await this.getDatasources();
            return {
                resources: sources.list.map((s) => ({
                    uri: `datasource:///${s.id}`,
                    name: s.name,
                    description: s.description,
                    mimeType: "text/plain"
                }))
            }
        });

        this.setRequestHandler(ReadResourceRequestSchema, async (request: z.infer<typeof ReadResourceRequestSchema>) => {
            const { uri } = request.params;
            const sourceId = uri.split("///").pop();
            if (!sourceId) {
                throw new Error("Invalid datasource uri");
            }
            const { map: sourceMap } = await this.getDatasources();
            const source = sourceMap.get(sourceId);
            if (!source) {
                throw new Error("Datasource not found");
            }
            return {
                contents: [{
                    uri: uri,
                    mimeType: "text/plain",
                    text: `
                    ${source.description}

                    The id of the datasource is ${sourceId}.

                    Use ThoughtSpot's getRelevantData tool to get data from this datasource for a question.
                    `,
                }],
            };
        });


        // Handle call tool request
        this.setRequestHandler(CallToolRequestSchema, async (request: z.infer<typeof CallToolRequestSchema>) => {
            const { name } = request.params;

            switch (name) {
                case ToolName.Ping:
                    console.log("Received Ping request");
                    if (this.ctx.props.accessToken && this.ctx.props.instanceUrl) {
                        return {
                            content: [{ type: "text", text: "Pong" }],
                        };
                    } else {
                        return {
                            isError: true,
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
        const { query, datasourceId: sourceId } = GetRelevantDataSchema.parse(request.params.arguments);
        const client = getThoughtSpotClient(this.ctx.props.instanceUrl, this.ctx.props.accessToken);
        const progressToken = request.params._meta?.progressToken;
        let progress = 0;
        console.log("[DEBUG] Getting relevant data for query: ", query, " and datasource: ", sourceId);

        const relevantData = await getRelevantData({
            query,
            sourceId,
            shouldCreateLiveboard: true,
            notify: (data) => this.notification({
                method: "notifications/progress",
                params: {
                    message: data,
                    progressToken: progressToken,
                    progress: Math.min(progress++ * 10, 100),
                    total: 100,
                },
            }),
            client,
        });

        if (relevantData.allAnswers.length === 0) {
            return {
                isError: true,
                content: [{
                    type: "text",
                    text: "No relevant data found, please make sure the datasource is correct, and you have data download privileges in ThoughtSpot.",
                }],
            };
        }

        return {
            content: [{
                type: "text",
                text: relevantData.allAnswers.map((answer) => `Question: ${answer.question}\nAnswer: ${answer.data}`).join("\n\n")
            }, {
                type: "text",
                text: `Dashboard Url: ${relevantData.liveboard}
                
                Use this url to view the dashboard/liveboard in ThoughtSpot which contains visualizations for the generated data. *Always* Present this url to the user as a link to view the data as a reference.`,
            }],
        };
    }

    private _sources: {
        list: DataSource[];
        map: Map<string, DataSource>;
    } | null = null;
    async getDatasources() {
        if (this._sources) {
            return this._sources;
        }

        const client = getThoughtSpotClient(this.ctx.props.instanceUrl, this.ctx.props.accessToken);
        const sources = await getDataSources(client);
        this._sources = {
            list: sources,
            map: new Map(sources.map(s => [s.id, s])),
        }
        return this._sources;
    }
}
