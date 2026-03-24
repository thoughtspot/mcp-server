import type {
	CallToolRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { McpServerError } from "../utils";
import type { DataSource } from "../thoughtspot/thoughtspot-service";
import { TrackEvent } from "../metrics";
import { WithSpan } from "../metrics/tracing/tracing-utils";
import { SpanStatusCode } from "@opentelemetry/api";
import { BaseMCPServer, type Context } from "./mcp-server-base";
import { resolveApiVersion } from "./version-registry";
import {
	GetRelevantQuestionsSchema,
	GetAnswerSchema,
	CreateLiveboardSchema,
	GetDataSourceSuggestionsSchema,
	ToolName,
} from "./tool-definitions";

export class MCPServer extends BaseMCPServer {
	constructor(ctx: Context) {
		super(ctx, "ThoughtSpot", "2.0.0");
	}

	protected async listTools() {
		// Resolve the API version to get the appropriate tool configuration
		const versionConfig = resolveApiVersion(this.ctx.props.apiVersion);

		// Get base tools from version config
		let tools = [...versionConfig.tools];

		// Filter out GetDataSourceSuggestions if feature flag is not available
		if (
			!this.isDatasourceDiscoveryAvailable() &&
			tools.some((tool) => tool.name === ToolName.GetDataSourceSuggestions)
		) {
			tools = tools.filter(
				(tool) => tool.name !== ToolName.GetDataSourceSuggestions,
			);
		}

		return { tools };
	}

	protected async listResources() {
		const sources = await this.getDatasources();
		return {
			resources: sources.list.map((s) => ({
				uri: `datasource:///${s.id}`,
				name: s.name,
				description: s.description,
				mimeType: "text/plain",
			})),
		};
	}

	protected async readResource(
		request: z.infer<typeof ReadResourceRequestSchema>,
	) {
		const { uri } = request.params;
		const sourceId = uri.split("///").pop();
		if (!sourceId) {
			throw new McpServerError({ message: "Invalid datasource uri" }, 400);
		}
		const { map: sourceMap } = await this.getDatasources();
		const source = sourceMap.get(sourceId);
		if (!source) {
			throw new McpServerError({ message: "Datasource not found" }, 404);
		}
		return {
			contents: [
				{
					uri: uri,
					mimeType: "text/plain",
					text: `
                Name: ${source.name}
                ${source.description}

                The id of the datasource is ${sourceId}.

                Use ThoughtSpot's getRelevantQuestions tool to get relevant questions for a query, using the above id. And then use the getAnswer tool to get the answer for a question.
                `,
				},
			],
		};
	}

	protected async callTool(request: z.infer<typeof CallToolRequestSchema>) {
		const { name } = request.params;
		this.trackers.track(TrackEvent.CallTool, { toolName: name });

		switch (name) {
			case ToolName.Ping: {
				console.log("Received Ping request");
				if (this.ctx.props.accessToken && this.ctx.props.instanceUrl) {
					return this.createSuccessResponse("Pong", "Ping successful");
				}
				return this.createErrorResponse("Not authenticated", "Ping failed");
			}

			case ToolName.GetRelevantQuestions: {
				return this.callGetRelevantQuestions(request);
			}

			case ToolName.GetAnswer: {
				return this.callGetAnswer(request);
			}

			case ToolName.CreateConversation: {
				// TODO(Rifdhan) implement
				return this.createErrorResponse(
					"Not implemented",
					"Tool not implemented yet",
				);
			}

			case ToolName.SendConversationMessage: {
				// TODO(Rifdhan) implement
				return this.createErrorResponse(
					"Not implemented",
					"Tool not implemented yet",
				);
			}

			case ToolName.GetConversationUpdates: {
				// TODO(Rifdhan) implement
				return this.createErrorResponse(
					"Not implemented",
					"Tool not implemented yet",
				);
			}

			case ToolName.CreateLiveboard: {
				return this.callCreateLiveboard(request);
			}

			case ToolName.GetDataSourceSuggestions: {
				return this.callGetDataSourceSuggestions(request);
			}

			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	}

	@WithSpan("call-get-relevant-questions")
	async callGetRelevantQuestions(
		request: z.infer<typeof CallToolRequestSchema>,
	) {
		const {
			query,
			datasourceIds: sourceIds,
			additionalContext,
		} = GetRelevantQuestionsSchema.parse(request.params.arguments);
		console.log(
			"[DEBUG] Getting relevant questions for datasource: ",
			sourceIds,
		);

		const relevantQuestions =
			await this.getThoughtSpotService().getRelevantQuestions(
				query,
				sourceIds!,
				additionalContext ?? "",
			);

		if (relevantQuestions.error) {
			console.error(
				"Error getting relevant questions: ",
				relevantQuestions.error,
			);

			const structuredContent = {
				questions: [{ question: query, datasourceId: sourceIds?.[0] ?? "" }],
			};
			const span = this.initSpanWithCommonAttributes();
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: "Relevant questions failed, sending back the query as it is",
			});
			span?.setAttribute("datasource_ids", sourceIds?.join(",") ?? "");
			span?.setAttribute("error", relevantQuestions.error.message);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(structuredContent),
					},
				],
				structuredContent,
			};
		}

		if (relevantQuestions.questions.length === 0) {
			return this.createSuccessResponse("No relevant questions found");
		}

		return this.createStructuredContentSuccessResponse(
			{ questions: relevantQuestions.questions },
			"Relevant questions found",
		);
	}

	@WithSpan("call-get-answer")
	async callGetAnswer(request: z.infer<typeof CallToolRequestSchema>) {
		const { question, datasourceId: sourceId } = GetAnswerSchema.parse(
			request.params.arguments,
		);

		const answer = await this.getThoughtSpotService().getAnswerForQuestion(
			question,
			sourceId,
			false,
		);

		if (answer.error) {
			return this.createErrorResponse(
				answer.error.message,
				`Error getting answer ${answer.error.message}`,
			);
		}

		return this.createStructuredContentSuccessResponse(
			{
				data: answer.data,
				question: answer.question,
				session_identifier: answer.session_identifier,
				generation_number: answer.generation_number,
				frame_url: answer.frame_url,
				fields_info:
					"data: The csv data as an answer to the question\n session_identifier: The session identifier for the answer, use for liveboard creation\n generation_number: The generation number for the answer, use for liveboard creation\n frame_url: A url which can be used to view the answer in an iframe in the browser\n",
			},
			"Answer created successfully",
		);
	}

	@WithSpan("call-create-liveboard")
	async callCreateLiveboard(request: z.infer<typeof CallToolRequestSchema>) {
		const { name, answers, noteTile } = CreateLiveboardSchema.parse(
			request.params.arguments,
		);
		const liveboard =
			await this.getThoughtSpotService().fetchTMLAndCreateLiveboard(
				name,
				answers,
				noteTile,
			);

		if (liveboard.error) {
			return this.createErrorResponse(
				liveboard.error.message,
				`Error creating liveboard ${liveboard.error.message}`,
			);
		}

		const successMessage = `Liveboard created successfully, you can view it at ${liveboard.url}
                
Provide this url to the user as a link to view the liveboard in ThoughtSpot.`;

		return this.createSuccessResponse(
			successMessage,
			"Liveboard created successfully",
		);
	}

	@WithSpan("call-get-data-source-suggestions")
	async callGetDataSourceSuggestions(
		request: z.infer<typeof CallToolRequestSchema>,
	) {
		const { query } = GetDataSourceSuggestionsSchema.parse(
			request.params.arguments,
		);
		const dataSources =
			await this.getThoughtSpotService().getDataSourceSuggestions(query);

		if (!dataSources || dataSources.length === 0) {
			return this.createErrorResponse(
				"No data source suggestions found",
				"No data source suggestions found",
			);
		}

		// Return information for all suggested data sources
		const dataSourcesInfo = dataSources.map((ds) => ({
			header: ds.header,
			confidence: ds.confidence,
			llmReasoning: ds.llmReasoning,
		}));

		return this.createSuccessResponse(
			JSON.stringify(dataSourcesInfo),
			`${dataSources.length} data source suggestion(s) found`,
		);
	}

	private _sources: {
		list: DataSource[];
		map: Map<string, DataSource>;
	} | null = null;

	@WithSpan("get-datasources")
	async getDatasources() {
		if (this._sources) {
			return this._sources;
		}

		const sources = await this.getThoughtSpotService().getDataSources();
		this._sources = {
			list: sources,
			map: new Map(sources.map((s) => [s.id, s])),
		};
		return this._sources;
	}
}
