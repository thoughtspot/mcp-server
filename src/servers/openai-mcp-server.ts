
import type {
    CallToolRequestSchema,
    ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { BaseMCPServer, type Context } from "./mcp-server-base";
import type { z } from "zod";
import { WithSpan } from "../metrics/tracing/tracing-utils";
import { FetchInputSchema, FetchOutputSchema, SearchInputSchema, SearchOutputSchema, type ToolInput, type ToolOutput } from "../api-schemas/schemas";
import zodToJsonSchema from "zod-to-json-schema";

export const toolDefinitionsOpenAIMCPServer = [
    {
        name: "search",
        description: "Tool to search for relevant data queries to answer the given question based on the datasource passed to this tool, which is a datasource id, see the query description for the syntax. The datasource id is mandatory and should be passed as part of the query. Any textual question can be passed to this tool, and it will do its best to find relevant data queries to answer the question.",
        inputSchema: zodToJsonSchema(SearchInputSchema) as ToolInput,
        outputSchema: zodToJsonSchema(SearchOutputSchema) as ToolOutput,
    },
    {
        name: "fetch",
        description: "Tool to retrieve data from the retail sales dataset for a given query.",
        inputSchema: zodToJsonSchema(FetchInputSchema) as ToolInput,
        outputSchema: zodToJsonSchema(FetchOutputSchema) as ToolOutput,
    },
];

export class OpenAIDeepResearchMCPServer extends BaseMCPServer {
    constructor(ctx: Context) {
        super(ctx, "ThoughtSpot", "1.0.0");
    }

    protected async listTools() {
        return {
            tools: toolDefinitionsOpenAIMCPServer.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema,
            })),
        };
    }

    protected async listResources() {
        return {
            resources: [],
        };
    }

    protected async readResource(request: z.infer<typeof ReadResourceRequestSchema>) {
        return {
            contents: [],
        };
    }

    protected async callTool(request: z.infer<typeof CallToolRequestSchema>) {
        const { name } = request.params;
        switch (name) {
            case "search":
                return this.callSearch(request);
            case "fetch":
                return this.callFetch(request);
        }
    }

    @WithSpan('call-search')
    protected async callSearch(request: z.infer<typeof CallToolRequestSchema>) {
        const { query } = SearchInputSchema.parse(request.params.arguments);
        // query could be of the form "datasource:<id> <query-with-spaces>" or just "<query-with-spaces>"
        // First check if the query is of the form "datasource:<id> <query-with-spaces>. The id is a string of numbers, letters, and hyphens."
        const re = /^(?:datasource:(?<id>[A-Za-z0-9-]+)\s+)?(.+)$/;
        const match = re.exec(query);
        const datasourceId = match?.groups?.id;
        const queryWithoutDatasourceId = match![2];
        if (datasourceId) {
            const relevantQuestions = await this.getThoughtSpotService().getRelevantQuestions(queryWithoutDatasourceId, [datasourceId], "");
            if (relevantQuestions.error) {
                return this.createErrorResponse(relevantQuestions.error.message, `Error getting relevant questions ${relevantQuestions.error.message}`);
            }

            if (relevantQuestions.questions.length === 0) {
                return this.createSuccessResponse("No relevant questions found");
            }

            const results = relevantQuestions.questions.map(q => ({
                id: `${datasourceId}: ${q.question}`,
                title: q.question,
                text: q.question,
                url: "",
            }));

            return this.createStructuredContentSuccessResponse({ results }, "Relevant questions found");
        }

        // Search for datasources in case the query is not of the form "datasource:<id> <query-with-spaces>"
        // TODO: Implement this
        return this.createStructuredContentSuccessResponse({ results: [] }, "No relevant questions found");
    }

    @WithSpan('call-fetch')
    protected async callFetch(request: z.infer<typeof CallToolRequestSchema>) {
        const { id } = FetchInputSchema.parse(request.params.arguments);
        // id is of the form "<datasource-id>:<question>"
        const [datasourceId, question = ""] = id.split(":");
        const answer = await this.getThoughtSpotService().getAnswerForQuestion(question, datasourceId, false);
        if (answer.error) {
            return this.createErrorResponse(answer.error.message, `Error getting answer ${answer.error.message}`);
        }

        const result = {
            id,
            title: question,
            text: answer.data,
            url: `${this.ctx.props.instanceUrl}/#/insights/conv-assist?query=${question.trim()}&worksheet=${datasourceId}&executeSearch=true`,
        }

        return this.createStructuredContentSuccessResponse(result, "Answer found");
    }
}