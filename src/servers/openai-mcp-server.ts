
import {
    type CallToolRequestSchema,
    ToolSchema,
    type ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BaseMCPServer, type Context } from "./mcp-server-base";
import { z } from "zod";
import { WithSpan } from "../metrics/tracing/tracing-utils";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

const ToolOutputSchema = ToolSchema.shape.outputSchema;
type ToolOutput = z.infer<typeof ToolOutputSchema>;

const SearchInputSchema = z.object({
    query: z.string().describe("The query to search for."),
});

const SearchOutputSchema = z.object({
    results: z.array(z.object({
        id: z.string().describe("The id of the search result."),
        title: z.string().describe("The title of the search result."),
        text: z.string().describe("The text of the search result."),
        url: z.string().describe("The url of the search result."),
    })),
});

const fetchInputSchema = z.object({
    id: z.string().describe("The id of the search result to fetch."),
});

const fetchOutputSchema = z.object({
    id: z.string().describe("The id of the search result."),
    title: z.string().describe("The title of the search result."),
    text: z.string().describe("The text of the search result."),
    url: z.string().describe("The url of the search result."),
});

export class OpenAIDeepResearchMCPServer extends BaseMCPServer {
    constructor(ctx: Context) {
        super(ctx, "ThoughtSpot", "1.0.0");
    }

    protected async listTools() {
        return {
            tools: [
                {
                    name: "search",
                    description: "Search the web for information.",
                    inputSchema: zodToJsonSchema(SearchInputSchema) as ToolInput,
                    outputSchema: zodToJsonSchema(SearchOutputSchema) as ToolOutput,
                },
                {
                    name: "fetch",
                    description: "Fetch the content of a search result.",
                    inputSchema: zodToJsonSchema(fetchInputSchema) as ToolInput,
                    outputSchema: zodToJsonSchema(fetchOutputSchema) as ToolOutput,
                },
            ],
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
        // First check if the query is of the form "datasource:<id> <query-with-spaces>"
        const datasourceId = query.match(/datasource:(\d+)/)?.[1];
        if (datasourceId) {
            const relevantQuestions = await this.getThoughtSpotService().getRelevantQuestions(query, [datasourceId], "");
            if (relevantQuestions.error) {
                return this.createErrorResponse(relevantQuestions.error.message, `Error getting relevant questions ${relevantQuestions.error.message}`);
            }

            if (relevantQuestions.questions.length === 0) {
                return this.createSuccessResponse("No relevant questions found");
            }

            const results = relevantQuestions.questions.map(q => ({
                id: `${datasourceId}:${q.question}`,
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
        const { id } = fetchInputSchema.parse(request.params.arguments);
        // id is of the form "<datasource-id>:<question>"
        const [datasourceId, question] = id.split(":");
        const answer = await this.getThoughtSpotService().getAnswerForQuestion(question, datasourceId, false);
        if (answer.error) {
            return this.createErrorResponse(answer.error.message, `Error getting answer ${answer.error.message}`);
        }

        const result = {
            id,
            title: question,
            text: answer.data,
            url: `${this.ctx.props.instanceUrl}/#/insights/conv-assist?query=${question}&worksheet=${datasourceId}&executeSearch=true`,
        }

        return this.createStructuredContentSuccessResponse(result, "Answer found");
    }
}