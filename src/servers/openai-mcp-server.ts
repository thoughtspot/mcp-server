
import type {
    CallToolRequestSchema,
    ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { BaseMCPServer, type Context } from "./mcp-server-base";
import { z } from "zod";
import { WithSpan } from "../metrics/tracing/tracing-utils";
import zodToJsonSchema from "zod-to-json-schema";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";

const ToolInputSchema = ToolSchema.shape.inputSchema;
export type ToolInput = z.infer<typeof ToolInputSchema>;

const ToolOutputSchema = ToolSchema.shape.outputSchema;
export type ToolOutput = z.infer<typeof ToolOutputSchema>;

export const SearchInputSchema = z.object({
    query: z.string().describe(`The question/task to search for relevant data queries to answer. Use the fetch tool to retrieve the data for individual queries. The datasource id should be passed as part of the query. With the syntax 
    datasource:<id> <search-query>. The search-query can be any textual question.
        
        For example:
                    datasource:asdhshd-123123-12dd How to reduce customer churn?
                    datasource:abc-123123-12dd How to increase sales?
                
                If the datasource id is not available, ask the user to supply one explicitly.`),
});

export const SearchOutputSchema = z.object({
    results: z.array(z.object({
        id: z.string().describe("The id of the search result."),
        title: z.string().describe("The title of the search result."),
        text: z.string().describe("The text of the search result."),
        url: z.string().describe("The url of the search result."),
    })),
});

export const FetchInputSchema = z.object({
    id: z.string().describe("The id of the search result to fetch."),
});

export const FetchOutputSchema = z.object({
    id: z.string().describe("The id of the search result."),
    title: z.string().describe("The title of the search result."),
    text: z.string().describe("The text of the search result."),
    url: z.string().describe("The url of the search result."),
});

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
            tools: [
                ...toolDefinitionsOpenAIMCPServer,
            ]
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
        if (!this.isDatasourceDiscoveryAvailable()) {
            return this.createStructuredContentSuccessResponse({ results: [] }, "No relevant questions found");
        }
        const dataSources = await this.getThoughtSpotService().getDataSourceSuggestions(queryWithoutDatasourceId);
        if (!dataSources || dataSources.length === 0) {
            return this.createSuccessResponse("No relevant data sources found, please provide a datasource id in the query");
        }
        const results = dataSources.map(d => ({
            id: `datasource:///${d.header.guid}`,
            title: d.header.displayName,
            text: `Datasource Description: ${d.header.description}. Confidence that this datasource is relevant to the query: ${d.confidence}. Reasoning for the confidence: ${d.llmReasoning}. 
            Use this datasource to search for relevant questions and to get answers for the questions. 
            Use the search tool to search for relevant questions with the format "datasource:<id> <query-with-spaces>" and the fetch tool to get answers for the questions.`,
        }));

        return this.createStructuredContentSuccessResponse({ results }, "Relevant questions found");


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