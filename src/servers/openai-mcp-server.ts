
import {
    type CallToolRequestSchema,
    ToolSchema,
    type ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BaseMCPServer, type Context } from "./mcp-server-base";
import { z } from "zod";
import { WithSpan } from "../metrics/tracing/tracing-utils";
import { putInKV } from "../utils";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

const ToolOutputSchema = ToolSchema.shape.outputSchema;
type ToolOutput = z.infer<typeof ToolOutputSchema>;

const SearchInputSchema = z.object({
    query: z.string().describe(`The question/task to search for relevant data queries to answer. Use the fetch tool to retrieve the data for individual queries. The datasource id should be passed as part of the query. With the syntax 
    datasource:<id> <search-query>. The search-query can be any textual question.
        
        For example:
                    datasource:asdhshd-123123-12dd How to reduce customer churn?
                    datasource:abc-123123-12dd How to increase sales?
                
                If the datasource id is not available, ask the user to supply one explicitly.`),
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
                    description: "Tool to search for relevant data queries to answer the given question based on the datasource passed to this tool, which is a datasource id, see the query description for the syntax. The datasource id is mandatory and should be passed as part of the query. Any textual question can be passed to this tool, and it will do its best to find relevant data queries to answer the question.",
                    inputSchema: zodToJsonSchema(SearchInputSchema) as ToolInput,
                    outputSchema: zodToJsonSchema(SearchOutputSchema) as ToolOutput,
                },
                {
                    name: "fetch",
                    description: "Tool to retrieve data from the retail sales dataset for a given query.",
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
        const { id } = fetchInputSchema.parse(request.params.arguments);
        // id is of the form "<datasource-id>:<question>"
        const [datasourceId, question = ""] = id.split(":");
        const answer = await this.getThoughtSpotService().getAnswerForQuestion(question, datasourceId, false);
        if (answer.error) {
            return this.createErrorResponse(answer.error.message, `Error getting answer ${answer.error.message}`);
        }

        let tokenUrl = "";
        
        // Generate token and store in KV store
        if (!answer.error && this.ctx.env?.OAUTH_KV) {
            console.log("[DEBUG] Storing token in KV");
            const token = crypto.randomUUID();
            const tokenData = {
                sessionId: answer.session_identifier,
                generationNo: answer.generation_number,
                instanceURL: this.ctx.props.instanceUrl,
                accessToken: this.ctx.props.accessToken
            };
            await putInKV(token, tokenData, this.ctx.env);
            tokenUrl = `${this.ctx.env?.HOST_NAME}/data/img?token=${token}`;
        }
        const content = [
            { type: "text" as const, text: answer.data },
            ...(tokenUrl ? [{
                type: "text" as const,
                text: "Use the URL to GET the images associated with the data. It might take time to get the image but use this PNG image of the visualization to do a graphical analysis of the data.",
            }] : []),
        ];
        const result = {
            id,
            title: question,
            text: content,
            url: tokenUrl,
        }

        return this.createStructuredContentSuccessResponse(result, "Answer found");
    }
}