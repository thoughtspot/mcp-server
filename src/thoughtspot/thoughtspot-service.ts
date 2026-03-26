import type {
	AgentConversation,
	ThoughtSpotRestApi,
} from "@thoughtspot/rest-api-sdk";
import { SpanStatusCode, trace, context } from "@opentelemetry/api";
import { getActiveSpan, WithSpan } from "../metrics/tracing/tracing-utils";
import type { DataSource, SessionInfo, DataSourceSuggestion } from "./types";
import { StreamingMessagesStorageWithTtl } from "../streaming-message-storage-with-ttl/streaming-message-storage-with-ttl";

/**
 * Main ThoughtSpot service class using decorator pattern for tracing
 */
export class ThoughtSpotService {
	constructor(private client: ThoughtSpotRestApi) {}

	@WithSpan("discover-data-sources")
	async discoverDataSources(
		query?: string,
	): Promise<DataSource[] | DataSourceSuggestion[] | null> {
		const span = getActiveSpan();
		span?.addEvent("discover-data-sources");

		// If a query is provided, use intelligent data source suggestions
		if (query) {
			span?.addEvent("get-data-source-suggestions");
			return await this.getDataSourceSuggestions(query);
		}

		// Otherwise, fallback to getting all data sources
		const dataSources = await this.getDataSources();
		return dataSources;
	}

	/**
	 * Get intelligent data source suggestions based on a query using GraphQL
	 */
	@WithSpan("get-data-source-suggestions")
	async getDataSourceSuggestions(
		query: string,
	): Promise<DataSourceSuggestion[] | null> {
		const span = getActiveSpan();

		try {
			span?.setAttribute("query", query);
			span?.addEvent("query-get-data-source-suggestions");

			const response = await this.client.getDataSourceSuggestions({
				query,
			});

			span?.setStatus({
				code: SpanStatusCode.OK,
				message: "Data source suggestions retrieved",
			});

			// Check if we have any data sources
			if (!response.data_sources || response.data_sources.length === 0) {
				span?.setAttribute("suggestions_count", 0);
				return null;
			}

			span?.setAttribute("suggestions_count", response.data_sources.length);

			// Return top 2 data sources (or just 1 if only 1 available)
			const topDataSources = response.data_sources
				.slice(0, 2)
				.map((source) => ({
					confidence: source.confidence ?? 0,
					header: {
						description: source.details?.description ?? "",
						displayName: source.details?.data_source_name ?? "",
						guid: source.details?.data_source_identifier ?? "",
					},
					llmReasoning: source.reasoning ?? "",
				}));
			return topDataSources;
		} catch (error) {
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: (error as Error).message,
			});
			console.error("Error getting data source suggestions: ", error);
			throw error;
		}
	}

	/**
	 * Get relevant questions for a given query and data sources
	 */
	@WithSpan("get-relevant-questions")
	async getRelevantQuestions(
		query: string,
		sourceIds: string[],
		additionalContext: string,
	): Promise<{
		questions: { question: string; datasourceId: string }[];
		error: Error | null;
	}> {
		const span = trace.getSpan(context.active());

		try {
			additionalContext = additionalContext || "";
			span?.setAttribute("datasource_ids", sourceIds.join(","));
			console.log(
				"[DEBUG] Getting relevant questions with datasource: ",
				sourceIds,
			);
			span?.addEvent("get-decomposed-query");

			const resp = await this.client.queryGetDecomposedQuery({
				nlsRequest: {
					query: query,
				},
				content: [additionalContext],
				worksheetIds: sourceIds,
				maxDecomposedQueries: 5,
			});

			const questions =
				resp.decomposedQueryResponse?.decomposedQueries?.map((q) => ({
					question: q.query!,
					datasourceId: q.worksheetId!,
				})) || [];

			span?.setStatus({
				code: SpanStatusCode.OK,
				message: "Relevant questions found",
			});
			span?.setAttribute("questions_count", questions.length);

			return {
				questions,
				error: null,
			};
		} catch (error) {
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: (error as Error).message,
			});
			console.error(
				"Error getting relevant questions: ",
				"sourceIds: ",
				sourceIds,
				"instanceUrl: ",
				(this.client as any).instanceUrl,
				"error: ",
				error,
			);
			return {
				questions: [],
				error: error as Error,
			};
		}
	}

	/**
	 * Get answer data for a specific question
	 */
	@WithSpan("get-answer-data")
	private async getAnswerData(
		question: string,
		session_identifier: string,
		generation_number: number,
	): Promise<string> {
		const span = getActiveSpan();

		try {
			span?.setAttributes({
				session_identifier,
				generation_number,
			});

			console.log(
				"[DEBUG] Getting Data for session_identifier: ",
				session_identifier,
				"generation_number: ",
				generation_number,
				"instanceUrl: ",
				(this.client as any).instanceUrl,
			);
			span?.addEvent("get-answer-data");
			const data = await this.client.exportAnswerReport({
				session_identifier,
				generation_number,
				file_format: "CSV",
			});

			let csvData = await data.text();
			// get only the first 100 lines of the csv data
			csvData = csvData.split("\n").slice(0, 100).join("\n");

			return csvData;
		} catch (error) {
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: `Error getting answer Data ${error}`,
			});
			console.error(
				"Error getting answer Data: ",
				error,
				"instanceUrl: ",
				(this.client as any).instanceUrl,
			);
			throw error;
		}
	}

	/**
	 * Get TML for a specific answer
	 */
	@WithSpan("get-answer-tml")
	private async getAnswerTML(
		question: string,
		session_identifier: string,
		generation_number: number,
	): Promise<any> {
		const span = getActiveSpan();

		try {
			span?.setAttribute("session_identifier", session_identifier);
			span?.addEvent("get-answer-tml");
			console.log("[DEBUG] Getting TML for question: ", question);
			const tml = await (this.client as any).exportUnsavedAnswerTML({
				session_identifier,
				generation_number,
			});
			return tml;
		} catch (error) {
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: `Error getting answer TML ${error}`,
			});
			console.error("Error getting answer TML: ", error);
			return null;
		}
	}

	/**
	 * Create a conversation with Spotter agent
	 */
	@WithSpan("create-agent-conversation")
	async createAgentConversation(
		dataSourceId?: string,
	): Promise<AgentConversation> {
		const span = trace.getSpan(context.active());

		try {
			span?.addEvent("create-agent-conversation");

			// Use auto mode by default, but support passing an explicit data source context
			const metadataContext = dataSourceId
				? {
						data_source_context: {
							guid: dataSourceId,
						},
					}
				: {
						type: "AUTO_MODE" as any, // Not yet supported by SDK but works through API
					};

			const response = await this.client.createAgentConversation({
				// TODO(Rifdhan): Which of these flags need to be configurable?
				metadata_context: metadataContext,
				conversation_settings: {
					enable_contextual_change_analysis: true,
					enable_natural_language_answer_generation: true,
					enable_reasoning: true,
				},
			});

			span?.setStatus({
				code: SpanStatusCode.OK,
				message: "Agent conversation created",
			});
			span?.setAttribute("conversation_id", response.conversation_id);

			return response;
		} catch (error) {
			console.error("Error creating agent conversation:", error);
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: (error as Error).message,
			});
			throw error;
		}
	}

	/**
	 * Send a message to an agent conversation, and collect the streaming response asynchronously
	 */
	@WithSpan("send-agent-conversation-message-streaming")
	async sendAgentConversationMessageStreaming(
		conversationId: string,
		message: string,
		streamingMessageStorage: StreamingMessagesStorageWithTtl,
	): Promise<void> {
		const span = trace.getSpan(context.active());

		try {
			span?.addEvent("send-agent-conversation-message-streaming");

			const response = await (
				this.client as any
			).sendAgentConversationMessageStreaming({
				conversation_identifier: conversationId,
				message,
			});

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error("Failed to get reader from response body");
			}

			setTimeout(async () => {
				const decoder = new TextDecoder();
				let buffer = "";

				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						await streamingMessageStorage.appendMessagesAndRestartTtl(
							conversationId,
							[],
							true,
						);
						break;
					}

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						if (!line.startsWith("data: ")) continue;
						try {
							const data = JSON.parse(line.slice(6));
							for (const item of data) {
								if (item.type === "text-chunk") {
									await streamingMessageStorage.appendMessagesAndRestartTtl(
										conversationId,
										[item.content],
									);
								} else if (item.type === "answer") {
									const frameUrl = `${this.ctx.props.instanceUrl}/?tsmcp=true#/embed/conv-assist-answer?sessionId=${item.metadata.session_id}&genNo=${item.metadata.gen_no}&acSessionId=${item.metadata.transaction_id}&acGenNo=${item.metadata.generation_number}`;

									await streamingMessageStorage.appendMessagesAndRestartTtl(
										conversationId,
										[frameUrl],
									);
									// await updateConversationState(false, [
									// 	{
									// 		type: "answer",
									// 		answerTitle: item.metadata.title,
									// 		answerQuery: item.metadata.sage_query,
									// 		answerFrameUrl: frameUrl,
									// 	},
									// ]);
								} else {
									console.log(">>> unknown item in event stream", item);
								}
							}
						} catch (error) {
							console.log(">>> error parsing line", line, error);
						}
					}
				}
			});

			span?.setStatus({
				code: SpanStatusCode.OK,
				message: "Agent conversation message streaming sent",
			});
		} catch (error) {
			console.error(
				"Error sending agent conversation message streaming:",
				error,
			);
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: (error as Error).message,
			});
			throw error;
		}
	}

	/**
	 * Get answer for a specific question
	 */
	@WithSpan("get-answer-for-question")
	async getAnswerForQuestion(
		question: string,
		sourceId: string,
		shouldGetTML: boolean,
	): Promise<any> {
		const span = getActiveSpan();

		span?.setAttributes({
			datasource_id: sourceId,
			should_get_tml: shouldGetTML,
		});
		span?.addEvent("get-answer-for-question");

		console.log(
			"[DEBUG] Getting answer for sourceId: ",
			sourceId,
			"shouldGetTML: ",
			shouldGetTML,
		);

		try {
			const answer = await this.client.singleAnswer({
				query: question,
				metadata_identifier: sourceId,
			});

			const { session_identifier, generation_number } = answer as any;
			span?.setAttributes({
				session_identifier,
				generation_number,
			});

			const [data, session, tml] = await Promise.all([
				this.getAnswerData(question, session_identifier, generation_number),
				(this.client as any).getAnswerSession({
					session_identifier,
					generation_number,
				}),
				shouldGetTML
					? this.getAnswerTML(question, session_identifier, generation_number)
					: Promise.resolve(null),
			]);

			const frameUrl = `${(this.client as any).instanceUrl}/?tsmcp=true#/embed/conv-assist-answer?sessionId=${session.sessionId}&genNo=${session.genNo}&acSessionId=${session.acSession.sessionId}&acGenNo=${session.acSession.genNo}`;

			return {
				question,
				...answer,
				frame_url: frameUrl,
				data,
				tml,
				error: null,
			};
		} catch (error) {
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: `Error getting answer for question ${error}`,
			});
			console.error(
				"Error getting answer for question: ",
				question,
				" and sourceId: ",
				sourceId,
				" and shouldGetTML: ",
				shouldGetTML,
				" and error: ",
				error,
				"instanceUrl: ",
				(this.client as any).instanceUrl,
			);
			return {
				error: error as Error,
			};
		}
	}

	/**
	 * Fetch TML and create liveboard
	 */
	@WithSpan("fetch-tml-and-create-liveboard")
	async fetchTMLAndCreateLiveboard(
		name: string,
		answers: any[],
		noteTileParsedHtml: string,
	): Promise<{ url?: string; error: Error | null }> {
		const span = getActiveSpan();

		try {
			span?.setAttributes({
				liveboard_name: name,
				answers_count: answers.length,
			});
			span?.addEvent("create-answer-tmls");

			const tmls = await Promise.all(
				answers.map((answer) =>
					this.getAnswerTML(
						answer.question,
						answer.session_identifier,
						answer.generation_number,
					),
				),
			);

			// Add note tile first
			const noteTitle = {
				id: "Viz_0",
				note_tile: {
					html_parsed_string: noteTileParsedHtml,
				},
			};

			// Update answers with TML data to match TML visualization format
			const visualizationAnswers = answers
				.map((answer, idx) => {
					const tml = tmls[idx];
					if (!tml) return null;
					return {
						id: `Viz_${idx + 1}`,
						answer: {
							...tml.answer,
							name: answer.question,
						},
					};
				})
				.filter((viz) => viz !== null);

			// Combine note tile first, then visualization answers
			answers = [noteTitle, ...visualizationAnswers];

			span?.addEvent("create-liveboard");

			const liveboardUrl = await this.createLiveboard(name, answers);
			return {
				url: liveboardUrl,
				error: null,
			};
		} catch (error) {
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: `Error fetching TML and creating liveboard ${error}`,
			});
			console.error("Error fetching TML and creating liveboard: ", error);
			return {
				error: error as Error,
			};
		}
	}

	/**
	 * Create liveboard from answers
	 */
	@WithSpan("create-liveboard")
	async createLiveboard(name: string, answers: any[]): Promise<string> {
		const span = getActiveSpan();

		span?.addEvent("createLiveboard");
		span?.setAttributes({
			liveboard_name: name,
			total_answers: answers.length,
		});

		const tml = {
			liveboard: {
				name,
				visualizations: answers,
				layout: {
					tiles: answers.map((answer, idx) => {
						if (answer.note_tile) {
							return {
								visualization_id: `Viz_${idx}`,
								size: "LARGE",
							};
						}
						return {
							visualization_id: `Viz_${idx}`,
							size: "MEDIUM_SMALL",
						};
					}),
				},
			},
		};

		const resp = await this.client.importMetadataTML({
			metadata_tmls: [JSON.stringify(tml)],
			import_policy: "ALL_OR_NONE",
		});

		const liveboardUrl = `${(this.client as any).instanceUrl}/#/pinboard/${resp[0].response.header.id_guid}`;
		span?.setStatus({
			code: SpanStatusCode.OK,
			message: "Liveboard created successfully",
		});
		return liveboardUrl;
	}

	/**
	 * Get data sources
	 */
	@WithSpan("get-data-sources")
	async getDataSources(): Promise<DataSource[]> {
		const span = getActiveSpan();

		span?.addEvent("get-data-sources");

		const resp = await this.client.searchMetadata({
			metadata: [
				{
					type: "LOGICAL_TABLE",
				},
			],
			record_size: 2000,
			sort_options: {
				field_name: "LAST_ACCESSED",
				order: "DESC",
			},
		});

		const results = resp
			// Tables can also be used for spotter now
			//.filter(d => d.metadata_header.type === "WORKSHEET" || d.metadata_header.subType === "WORKSHEET")
			.filter((d) => d.metadata_header.aiAnswerGenerationDisabled === false)
			.map((d) => ({
				name: d.metadata_header.name,
				id: d.metadata_header.id,
				description: d.metadata_header.description,
			}));

		return results;
	}

	/**
	 * Get session information
	 */
	@WithSpan("get-session-info")
	async getSessionInfo(): Promise<SessionInfo> {
		const span = getActiveSpan();

		const info = await (this.client as any).getSessionInfo();
		const devMixpanelToken = info.configInfo.mixpanelConfig.devSdkKey;
		const prodMixpanelToken = info.configInfo.mixpanelConfig.prodSdkKey;
		const mixpanelToken = info.configInfo.mixpanelConfig.production
			? prodMixpanelToken
			: devMixpanelToken;

		span?.setAttribute("user_guid", info.userGUID);
		span?.setAttribute("user_name", info.userName);
		span?.setAttribute("cluster_name", info.configInfo.selfClusterName);
		span?.setAttribute("release_version", info.releaseVersion);

		return {
			mixpanelToken,
			userGUID: info.userGUID,
			userName: info.userName,
			clusterName: info.configInfo.selfClusterName,
			clusterId: info.configInfo.selfClusterId,
			releaseVersion: info.releaseVersion,
			currentOrgId: info.currentOrgId,
			privileges: info.privileges,
			enableSpotterDataSourceDiscovery:
				info.configInfo?.enableSpotterDataSourceDiscovery,
		};
	}

	/**
	 * Search worksheets by term
	 */
	@WithSpan("search-worksheets")
	async searchWorksheets(searchTerm: string): Promise<DataSource[]> {
		const span = getActiveSpan();

		const resp = await this.client.searchMetadata({
			metadata: [
				{
					type: "LOGICAL_TABLE",
				},
			],
			record_size: 100,
			sort_options: {
				field_name: "NAME",
				order: "ASC",
			},
		});

		const results = resp
			.filter((d) => d.metadata_header.type === "WORKSHEET")
			.filter((d) =>
				d.metadata_header.name.toLowerCase().includes(searchTerm.toLowerCase()),
			)
			.map((d) => ({
				name: d.metadata_header.name,
				id: d.metadata_header.id,
				description: d.metadata_header.description,
			}));

		span?.setAttribute("results_count", results.length);

		return results;
	}

	/**
	 * Validate connection to ThoughtSpot
	 */
	@WithSpan("validate-connection")
	async validateConnection(): Promise<boolean> {
		try {
			await (this.client as any).getSessionInfo();
			return true;
		} catch (error) {
			// The decorator will automatically record the exception
			return false;
		}
	}
}

// Backward compatibility - export functions that use the service class
export async function getRelevantQuestions(
	query: string,
	sourceIds: string[],
	additionalContext: string,
	client: ThoughtSpotRestApi,
): Promise<{
	questions: { question: string; datasourceId: string }[];
	error: Error | null;
}> {
	const service = new ThoughtSpotService(client);
	return service.getRelevantQuestions(query, sourceIds, additionalContext);
}

export async function getAnswerForQuestion(
	question: string,
	sourceId: string,
	shouldGetTML: boolean,
	client: ThoughtSpotRestApi,
) {
	const service = new ThoughtSpotService(client);
	return service.getAnswerForQuestion(question, sourceId, shouldGetTML);
}

export async function fetchTMLAndCreateLiveboard(
	name: string,
	answers: any[],
	summary: string,
	client: ThoughtSpotRestApi,
) {
	const service = new ThoughtSpotService(client);
	return service.fetchTMLAndCreateLiveboard(name, answers, summary);
}

export async function createLiveboard(
	name: string,
	answers: any[],
	client: ThoughtSpotRestApi,
) {
	const service = new ThoughtSpotService(client);
	return service.createLiveboard(name, answers);
}

export async function getDataSources(
	client: ThoughtSpotRestApi,
): Promise<DataSource[]> {
	const service = new ThoughtSpotService(client);
	return service.getDataSources();
}

export async function getDataSourceSuggestions(
	query: string,
	client: ThoughtSpotRestApi,
): Promise<DataSourceSuggestion[] | null> {
	const service = new ThoughtSpotService(client);
	return service.getDataSourceSuggestions(query);
}

export async function getSessionInfo(
	client: ThoughtSpotRestApi,
): Promise<SessionInfo> {
	const service = new ThoughtSpotService(client);
	return service.getSessionInfo();
}

// Export types
export type {
	DataSource,
	SessionInfo,
	DataSourceSuggestion,
	DataSourceSuggestionResponse,
} from "./types";
