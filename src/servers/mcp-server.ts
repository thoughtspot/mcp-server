import type {
	CallToolRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { AgentConversation } from "@thoughtspot/rest-api-sdk";
import type { z } from "zod";
import { TrackEvent } from "../metrics";
import type { ApiVersionMode } from "../metrics/runtime/metric-types";
import {
	type MetricsRecorder,
	NOOP_METRICS_RECORDER,
} from "../metrics/runtime/metrics-recorder";
import type { ToolMetricApiSurface } from "../metrics/runtime/tool-metrics";
import { WithSpan } from "../metrics/tracing/tracing-utils";
import type { Org } from "../thoughtspot/thoughtspot-client";
import type { DataSource } from "../thoughtspot/thoughtspot-service";
import type { Answer, StreamingMessagesState } from "../thoughtspot/types";
import { McpServerError } from "../utils";
import { BaseMCPServer, type Context } from "./mcp-server-base";
import {
	CreateAnalysisSessionInputSchema,
	CreateDashboardInputSchema,
	CreateLiveboardSchema,
	GetAnswerSchema,
	GetDataSourceSuggestionsSchema,
	GetRelevantQuestionsSchema,
	GetSessionUpdatesInputSchema,
	SendSessionMessageInputSchema,
	SwitchOrgInputSchema,
	ToolName,
} from "./tool-definitions";
import {
	type VersionConfig,
	resolveApiVersion,
	resolveApiVersionMetrics,
} from "./version-registry";

export class MCPServer extends BaseMCPServer {
	// Active org for this session, held in-memory on the Durable Object instance.
	// Resets if the DO is evicted/restarted; the user can re-select via switch_org.
	private activeOrgId: string | undefined;

	// Org-scoped bearer tokens, keyed by org id. Minted on demand from the
	// global cluster token (props.accessToken) and reused for that org's calls.
	private orgBearerTokens = new Map<string, string>();

	constructor(ctx: Context) {
		super(ctx, "ThoughtSpot", "2.0.0");
	}

	protected getActiveOrgId(): string | undefined {
		return this.activeOrgId;
	}

	/**
	 * When an org is active and we hold a bearer token for it, use that token.
	 * Otherwise fall back to the session's default access token.
	 */
	protected getActiveBearerToken(): string {
		if (this.activeOrgId) {
			const orgToken = this.orgBearerTokens.get(this.activeOrgId);
			if (orgToken) {
				return orgToken;
			}
		}
		return this.ctx.props.accessToken;
	}

	/**
	 * The global (cluster-level) access token used to list orgs and to mint
	 * per-org tokens. This is the token minted at login by the browser's
	 * gettoken call and stored as props.accessToken (via /store-token); the
	 * server uses it directly. It is NOT pinned to a single org.
	 */
	private resolveAccessToken(_recorder: MetricsRecorder): string {
		return this.ctx.props.accessToken;
	}

	/**
	 * Ensure we hold an org-scoped token for `orgId`: reuse the cached one, or
	 * mint a new one from the global token and cache it. Returns the org token.
	 */
	private async ensureOrgToken(
		orgId: string,
		recorder?: MetricsRecorder,
	): Promise<string> {
		const existing = this.orgBearerTokens.get(orgId);
		if (existing) {
			return existing;
		}
		const orgToken = await this.getThoughtSpotServiceWithToken(
			this.ctx.props.accessToken,
			undefined,
			recorder,
		).fetchOrgBearerToken(this.ctx.props.accessToken, orgId);
		this.orgBearerTokens.set(orgId, orgToken);
		return orgToken;
	}

	/**
	 * On connection, mint an org-scoped token for the session's current org so
	 * there is always an active org token available (matching the original
	 * single-org behavior). Best-effort: failures don't break the connection.
	 */
	protected async postInit(): Promise<void> {
		const currentOrgId =
			this.sessionInfo?.currentOrgId !== undefined
				? String(this.sessionInfo.currentOrgId)
				: undefined;
		if (!currentOrgId) {
			return;
		}
		try {
			await this.ensureOrgToken(currentOrgId);
			this.activeOrgId = currentOrgId;
		} catch (error) {
			console.error(
				`Failed to mint initial org token for org ${currentOrgId}:`,
				error,
			);
		}
	}

	protected getToolMetricApiSurface(): ToolMetricApiSurface {
		return "mcp";
	}

	protected getToolMetricApiVersionLabel(): string | undefined {
		const apiVersion = this.ctx.props.apiVersion;
		if (typeof apiVersion !== "string" || apiVersion.length === 0) {
			return "backwards-compatibility-default";
		}

		try {
			return resolveApiVersionMetrics(apiVersion).apiVersion;
		} catch {
			return "unknown";
		}
	}

	protected getToolMetricApiVersionModeLabel(): ApiVersionMode | undefined {
		const apiVersionMode = this.ctx.props.apiVersionMode;
		if (typeof apiVersionMode === "string" && apiVersionMode.length > 0) {
			return apiVersionMode;
		}

		const apiVersion = this.ctx.props.apiVersion;
		if (typeof apiVersion === "string" && apiVersion.length > 0) {
			try {
				const resolved = resolveApiVersionMetrics(apiVersion);
				if (resolved.apiVersion === "backwards-compatibility-default") {
					return "implicit_legacy";
				}
				if (resolved.apiVersion === "latest") {
					return "implicit_latest";
				}
				if (resolved.apiVersion === "beta") {
					return "beta";
				}
			} catch {
				return "unknown";
			}
		}

		return "implicit_legacy";
	}

	protected getToolMetricApiReleaseDateLabel(): string | undefined {
		const apiVersion = this.ctx.props.apiVersion;
		if (typeof apiVersion !== "string" || apiVersion.length === 0) {
			return resolveApiVersionMetrics("backwards-compatibility-default")
				.apiReleaseDate;
		}

		try {
			return resolveApiVersionMetrics(apiVersion).apiReleaseDate;
		} catch {
			return undefined;
		}
	}

	@WithSpan("call-list-tools")
	protected async listTools() {
		const span = this.initSpanWithCommonAttributes();
		span?.setAttribute(
			"api_version_requested",
			this.ctx.props.apiVersion ?? "(not passed)",
		);

		// Resolve the API version to get the appropriate tool configuration
		let versionConfig: VersionConfig;
		try {
			versionConfig = resolveApiVersion(this.ctx.props.apiVersion);
		} catch (error) {
			console.error(
				"Error resolving API version, using latest fallback:",
				error,
			);
			span?.recordException(error as Error);
			versionConfig = resolveApiVersion();
		}
		span?.setAttribute(
			"api_version_resolved",
			// The plain date will be the last entry if multiple labels
			versionConfig.version[versionConfig.version.length - 1],
		);

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

	protected async callTool(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const { name } = request.params;
		this.trackers.track(TrackEvent.CallTool, { toolName: name });

		switch (name) {
			case ToolName.Ping: {
				if (this.ctx.props.accessToken && this.ctx.props.instanceUrl) {
					if (!this.getThoughtSpotService(recorder).validateConnection()) {
						return this.createErrorResponse(
							"Failed to validate connection",
							"Ping failed",
						);
					}
					return this.createSuccessResponse("Pong", "Ping successful");
				}
				return this.createErrorResponse("Not authenticated", "Ping failed");
			}

			case ToolName.GetRelevantQuestions: {
				return this.callGetRelevantQuestions(request, recorder);
			}

			case ToolName.GetAnswer: {
				return this.callGetAnswer(request, recorder);
			}

			case ToolName.CreateLiveboard: {
				return this.callCreateLiveboard(request, recorder);
			}

			case ToolName.GetDataSourceSuggestions: {
				return this.callGetDataSourceSuggestions(request, recorder);
			}

			case ToolName.CheckConnectivity: {
				if (!this.ctx.props.accessToken || !this.ctx.props.instanceUrl) {
					return this.createErrorResponse(
						"Access token or instance URL not valid",
						"Check connectivity failed",
					);
				}
				if (!this.getThoughtSpotService(recorder).validateConnection()) {
					return this.createErrorResponse(
						"Failed to validate connection",
						"Check connectivity failed",
					);
				}
				return this.createStructuredContentSuccessResponse(
					{ success: true },
					"Check connectivity successful",
				);
			}

			case ToolName.CreateAnalysisSession: {
				return this.callCreateAnalysisSession(request, recorder);
			}

			case ToolName.SendSessionMessage: {
				return this.callSendSessionMessage(request, recorder);
			}

			case ToolName.GetSessionUpdates: {
				return this.callGetSessionUpdates(request, recorder);
			}

			case ToolName.CreateDashboard: {
				return this.callCreateDashboard(request, recorder);
			}

			case ToolName.ListOrgs: {
				return this.callListOrgs(recorder);
			}

			case ToolName.SwitchOrg: {
				return this.callSwitchOrg(request, recorder);
			}

			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	}

	@WithSpan("call-get-relevant-questions")
	async callGetRelevantQuestions(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
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

		const relevantQuestions = await this.getThoughtSpotService(
			recorder,
		).getRelevantQuestions(query, sourceIds!, additionalContext ?? "");

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
	async callGetAnswer(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const { question, datasourceId: sourceId } = GetAnswerSchema.parse(
			request.params.arguments,
		);

		const answer = await this.getThoughtSpotService(
			recorder,
		).getAnswerForQuestion(question, sourceId, false);

		if (answer.error) {
			return this.createErrorResponse(
				"Encountered an error while creating the answer. Please check your inputs and try again.",
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
	async callCreateLiveboard(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const { name, answers, noteTile } = CreateLiveboardSchema.parse(
			request.params.arguments,
		);
		const transformedAnswers: Answer[] = answers.map((answer) => ({
			title: answer.question,
			session_identifier: answer.session_identifier,
			generation_number: answer.generation_number,
		}));
		const liveboard = await this.getThoughtSpotService(
			recorder,
		).fetchTMLAndCreateLiveboard(name, transformedAnswers, noteTile);

		if (liveboard.error) {
			return this.createErrorResponse(
				"Encountered an error while creating the liveboard. Please check your inputs and try again.",
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

	@WithSpan("call-create-analysis-session")
	async callCreateAnalysisSession(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const span = trace.getSpan(context.active());
		const { data_source_id } = CreateAnalysisSessionInputSchema.parse(
			request.params.arguments,
		);
		span?.setAttribute("data_source_id", data_source_id ?? "(none)");

		let response: AgentConversation;
		try {
			response =
				await this.getThoughtSpotService(recorder).createAgentConversation(
					data_source_id,
				);
		} catch (error) {
			if (!(error as any)?.message?.includes("failed with status 401")) {
				throw error;
			}

			return this.createErrorResponse(
				"Your authentication has expired, please reauthenticate and try again. You may need to disconnect and reconnect the MCP Server if you don't have any other way to reauthenticate.",
				"User authentication has expired, prompting them to reauthenticate",
			);
		}
		recorder.setAnalyticsContext({
			analyticalSessionId: response.conversation_id,
		});
		span?.setAttribute("analytical_session_id", response.conversation_id);

		// Conversation is initialized in Storage Server from callSendSessionMessage, since that is
		// the common entrypoint for both initial messages and followup messages.

		return this.createStructuredContentSuccessResponse(
			{ analytical_session_id: response.conversation_id },
			"Conversation created successfully",
		);
	}

	@WithSpan("call-send-session-message")
	async callSendSessionMessage(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder = NOOP_METRICS_RECORDER,
	) {
		const span = trace.getSpan(context.active());
		const { analytical_session_id, message, additional_context } =
			SendSessionMessageInputSchema.parse(request.params.arguments);
		recorder.setAnalyticsContext({
			analyticalSessionId: analytical_session_id,
		});
		span?.setAttributes({
			analytical_session_id,
			has_additional_context: !!additional_context,
		});

		const storageService = await this.getStorageService();
		try {
			await storageService.initializeConversation(analytical_session_id);
		} catch (error) {
			console.error(
				"Error initializing conversation in storage service:",
				error,
			);
			return this.createErrorResponse(
				"The analytical session has an ongoing response to the previous message. Please continue to call `get_session_updates` until `is_done` is true before sending a followup message.",
				`Error sending message to conversation ${analytical_session_id}: ${error}`,
			);
		}

		await this.getThoughtSpotService(recorder, {
			analyticalSessionId: analytical_session_id,
		}).sendAgentConversationMessageStreaming(
			analytical_session_id,
			message,
			storageService.appendMessages.bind(storageService),
			additional_context,
		);

		return this.createStructuredContentSuccessResponse(
			{ success: true },
			"Conversation message sent successfully",
		);
	}

	@WithSpan("call-get-session-updates")
	async callGetSessionUpdates(
		request: z.infer<typeof CallToolRequestSchema>,
		_recorder: MetricsRecorder = NOOP_METRICS_RECORDER,
	) {
		const span = trace.getSpan(context.active());
		const { analytical_session_id } = GetSessionUpdatesInputSchema.parse(
			request.params.arguments,
		);
		span?.setAttribute("analytical_session_id", analytical_session_id);

		// Rules when fetching conversation updates:
		// 1. Poll for updates every 500 ms
		// 2. If conversation is marked done, return immediately
		// 3. Wait for at least 3 seconds before returning any other updates. We want to avoid
		//    returning too quickly, which leads to too many get updates tool calls.
		// 4. If there are no updates after waiting for 10 seconds, return an empty response. We
		//    want to avoid waiting indefinitely in case of errors or unexpected problems.
		const storageService = await this.getStorageService();
		const messagesState: StreamingMessagesState = {
			messages: [],
			isDone: false,
		};
		let i = 0;
		for (; i < 20; i++) {
			// Get latest updates
			const newMessagesState = await storageService.getNewMessages(
				analytical_session_id,
			);
			messagesState.messages.push(...newMessagesState.messages);
			messagesState.isDone = newMessagesState.isDone;

			// If conversation is marked done, return immediately
			if (messagesState.isDone) {
				break;
			}

			// If we have new messages and waited for at least 3 seconds, return the updates
			if (messagesState.messages.length > 0 && i >= 6) {
				break;
			}

			// Wait 500 ms before polling for updates again
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		span?.setAttributes({
			total_wait_time_ms: i * 500,
			total_session_updates: messagesState.messages.length,
			is_done: messagesState.isDone,
		});

		return this.createStructuredContentSuccessResponse(
			{
				session_updates: messagesState.messages,
				is_done: messagesState.isDone,
			},
			"Conversation updates retrieved successfully",
		);
	}

	@WithSpan("call-create-dashboard")
	async callCreateDashboard(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const span = trace.getSpan(context.active());
		const { title, answers, note_tile } = CreateDashboardInputSchema.parse(
			request.params.arguments,
		);
		span?.setAttribute("total_answers", answers.length);

		let transformedAnswers: Answer[] = [];
		try {
			transformedAnswers = answers.map((answer) => {
				const { session_id, gen_no } = JSON.parse(answer.answer_id);
				if (session_id === undefined || gen_no === undefined) {
					throw new Error(`Invalid answer_id format ${answer.answer_id}`);
				}
				return {
					title: answer.title,
					session_identifier: session_id,
					generation_number: gen_no,
				};
			});
		} catch (error) {
			return this.createErrorResponse(
				'Invalid answer_id format. Please provide the value returned from the "get_session_updates" tool.',
				`Error creating dashboard ${error}`,
			);
		}

		const liveboard = await this.getThoughtSpotService(
			recorder,
		).fetchTMLAndCreateLiveboard(title, transformedAnswers, note_tile);

		if (liveboard.error) {
			return this.createErrorResponse(
				"Encountered an error while creating the dashboard. Please check your inputs and try again.",
				`Error creating dashboard ${liveboard.error.message}`,
			);
		}

		return this.createStructuredContentSuccessResponse(
			{
				link: liveboard.url,
			},
			"Dashboard created successfully",
		);
	}

	@WithSpan("call-list-orgs")
	async callListOrgs(recorder: MetricsRecorder) {
		if (!this.ctx.props.accessToken || !this.ctx.props.instanceUrl) {
			return this.createErrorResponse(
				"Access token or instance URL not valid",
				"List orgs failed",
			);
		}

		// Use the global cluster token (from login) to list orgs.
		const accessToken = this.resolveAccessToken(recorder);

		let orgs: Org[];
		try {
			orgs = await this.getThoughtSpotServiceWithToken(
				accessToken,
				undefined,
				recorder,
			).listOrgs();
		} catch (error) {
			return this.createErrorResponse(
				"Failed to list orgs. Your account may not have orgs enabled, or your authentication may have expired.",
				`Error listing orgs ${(error as Error)?.message}`,
			);
		}

		// Determine the currently active org. If the user has explicitly switched,
		// use that; otherwise fall back to the org the session resolves to.
		let activeOrgId = this.getActiveOrgId();
		if (!activeOrgId) {
			try {
				const sessionInfo =
					await this.getThoughtSpotService(recorder).getSessionInfo();
				if (sessionInfo.currentOrgId !== undefined) {
					activeOrgId = String(sessionInfo.currentOrgId);
				}
			} catch {
				// Best-effort: if we can't resolve the current org, leave all inactive.
			}
		}

		return this.createStructuredContentSuccessResponse(
			{
				orgs: orgs.map((org) => ({
					id: org.id,
					name: org.name,
					description: org.description,
					is_active: activeOrgId !== undefined && org.id === activeOrgId,
				})),
			},
			`${orgs.length} org(s) found`,
		);
	}

	@WithSpan("call-switch-org")
	async callSwitchOrg(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const span = trace.getSpan(context.active());
		const { org_id } = SwitchOrgInputSchema.parse(request.params.arguments);
		span?.setAttribute("requested_org_id", org_id);

		if (!this.ctx.props.accessToken || !this.ctx.props.instanceUrl) {
			return this.createErrorResponse(
				"Access token or instance URL not valid",
				"Switch org failed",
			);
		}

		// The global cluster token — used both to verify org access and to mint
		// the org-scoped bearer token.
		const accessToken = this.resolveAccessToken(recorder);

		// Validate the requested org against the orgs the user can actually access.
		// This prevents switching to an org the user isn't a member of (which would
		// otherwise surface as opaque 401/INACCESSIBLE_ORG errors on later calls).
		let orgs: Org[];
		try {
			orgs = await this.getThoughtSpotServiceWithToken(
				accessToken,
				undefined,
				recorder,
			).listOrgs();
		} catch (error) {
			return this.createErrorResponse(
				"Failed to verify org access. Your authentication may have expired.",
				`Error listing orgs while switching ${(error as Error)?.message}`,
			);
		}

		const target = orgs.find((org) => org.id === org_id);
		if (!target) {
			return this.createErrorResponse(
				`Org "${org_id}" is not in the list of orgs you have access to. Call list_orgs to see available orgs.`,
				"Switch org failed: org not accessible",
			);
		}

		// Ensure we hold an org-scoped bearer token for this org (reuse cached or
		// mint from the global token).
		try {
			await this.ensureOrgToken(target.id, recorder);
		} catch (error) {
			return this.createErrorResponse(
				`Failed to obtain an access token for org "${target.name}". Please try again.`,
				`Error minting org bearer token ${(error as Error)?.message}`,
			);
		}

		this.activeOrgId = target.id;
		// Data sources are org-specific; drop the cached set so the next lookup
		// reflects the newly selected org.
		this._sources = null;
		span?.setAttribute("active_org_id", target.id);

		return this.createStructuredContentSuccessResponse(
			{
				success: true,
				active_org_id: target.id,
				active_org_name: target.name,
			},
			`Switched to org ${target.name}`,
		);
	}

	@WithSpan("call-get-data-source-suggestions")
	async callGetDataSourceSuggestions(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const { query } = GetDataSourceSuggestionsSchema.parse(
			request.params.arguments,
		);
		const dataSources =
			await this.getThoughtSpotService(recorder).getDataSourceSuggestions(
				query,
			);

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
	async getDatasources(recorder?: MetricsRecorder) {
		if (this._sources) {
			return this._sources;
		}

		const sources = await this.getThoughtSpotService(recorder).getDataSources();
		this._sources = {
			list: sources,
			map: new Map(sources.map((s) => [s.id, s])),
		};
		return this._sources;
	}
}
