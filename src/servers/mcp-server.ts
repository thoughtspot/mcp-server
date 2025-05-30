import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ToolSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Props } from "../utils";
import { getThoughtSpotClient } from "../thoughtspot/thoughtspot-client";
import {
    type DataSource,
    fetchTMLAndCreateLiveboard,
    getAnswerForQuestion,
    getDataSources,
    getRelevantQuestions,
    getSessionInfo
} from "../thoughtspot/thoughtspot-service";
import { MixpanelTracker } from "../metrics/mixpanel";
import { Trackers, type Tracker, TrackEvent } from "../metrics";
import { 
    GetRelevantQuestionsSchema, 
    GetAnswerSchema, 
    CreateLiveboardSchema, 
    ToolName, 
    toolDefinitions
} from "../api-schemas/schemas";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;


interface Context {
    props: Props;
}

export class MCPServer extends Server {
    private trackers: Trackers = new Trackers();
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
        const client = getThoughtSpotClient(this.ctx.props.instanceUrl, this.ctx.props.accessToken);
        const sessionInfo = await getSessionInfo(client);
        const mixpanel = new MixpanelTracker(
            sessionInfo,
            this.ctx.props.clientName
        );
        this.addTracker(mixpanel);
        this.trackers.track(TrackEvent.Init);

        this.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: toolDefinitions.map(toolDef => ({
                    name: toolDef.name,
                    description: toolDef.description,
                    inputSchema: zodToJsonSchema(toolDef.schema) as ToolInput,
                }))
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

                    Use ThoughtSpot's getRelevantQuestions tool to get relevant questions for a query. And then use the getAnswer tool to get the answer for a question.
                    `,
                }],
            };
        });


        // Handle call tool request
        this.setRequestHandler(CallToolRequestSchema, async (request: z.infer<typeof CallToolRequestSchema>) => {
            const { name } = request.params;


            this.trackers.track(TrackEvent.CallTool, { toolName: name });

            switch (name) {
                case ToolName.Ping:
                    console.log("Received Ping request");
                    if (this.ctx.props.accessToken && this.ctx.props.instanceUrl) {
                        return {
                            content: [{ type: "text", text: "Pong" }],
                        };
                    }
                    return {
                        isError: true,
                        content: [{ type: "text", text: "ERROR: Not authenticated" }],
                    };

                case ToolName.GetRelevantQuestions: {
                    return this.callGetRelevantQuestions(request);
                }

                case ToolName.GetAnswer: {
                    return this.callGetAnswer(request);
                }

                case ToolName.CreateLiveboard: {
                    return this.callCreateLiveboard(request);
                }

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }


    async callGetRelevantQuestions(request: z.infer<typeof CallToolRequestSchema>) {
        const { query, datasourceIds: sourceIds, additionalContext } = GetRelevantQuestionsSchema.parse(request.params.arguments);
        const client = getThoughtSpotClient(this.ctx.props.instanceUrl, this.ctx.props.accessToken);
        console.log("[DEBUG] Getting relevant questions for query: ", query, " and datasource: ", sourceIds);

        const relevantQuestions = await getRelevantQuestions(
            query,
            sourceIds!,
            additionalContext ?? "",
            client,
        );

        if (relevantQuestions.error) {
            return {
                isError: true,
                content: [{ type: "text", text: `ERROR: ${relevantQuestions.error.message}` }],
            };
        }

        if (relevantQuestions.questions.length === 0) {
            return {
                content: [{ type: "text", text: "No relevant questions found" }],
            };
        }

        return {
            content: relevantQuestions.questions.map(q => ({
                type: "text",
                text: `Question: ${q.question}\nDatasourceId: ${q.datasourceId}`,
            })),
        };
    }

    async callGetAnswer(request: z.infer<typeof CallToolRequestSchema>) {
        const { question, datasourceId: sourceId } = GetAnswerSchema.parse(request.params.arguments);
        const client = getThoughtSpotClient(this.ctx.props.instanceUrl, this.ctx.props.accessToken);
        const progressToken = request.params._meta?.progressToken;
        const progress = 0;
        console.log("[DEBUG] Getting answer for question: ", question, " and datasource: ", sourceId);

        const answer = await getAnswerForQuestion(question, sourceId, false, client);
        if (answer.error) {
            return {
                isError: true,
                content: [{ type: "text", text: `ERROR: ${answer.error.message}` }],
            };
        }

        return {
            content: [{
                type: "text",
                text: answer.data,
            }, {
                type: "text",
                text: `Question: ${question}\nSession Identifier: ${answer.session_identifier}\nGeneration Number: ${answer.generation_number} \n\nUse this information to create a liveboard with the createLiveboard tool, if the user asks.`,
            }],
        };
    }

    async callCreateLiveboard(request: z.infer<typeof CallToolRequestSchema>) {
        const { name, answers } = CreateLiveboardSchema.parse(request.params.arguments);
        const client = getThoughtSpotClient(this.ctx.props.instanceUrl, this.ctx.props.accessToken);
        const liveboard = await fetchTMLAndCreateLiveboard(name, answers, client);
        if (liveboard.error) {
            return {
                isError: true,
                content: [{ type: "text", text: `ERROR: ${liveboard.error.message}` }],
            };
        }
        return {
            content: [{
                type: "text",
                text: `Liveboard created successfully, you can view it at ${liveboard.url}
                
                Provide this url to the user as a link to view the liveboard in ThoughtSpot.`,
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

    async addTracker(tracker: Tracker) {
        this.trackers.add(tracker);
    }
}
