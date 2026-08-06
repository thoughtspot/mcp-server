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
import type { StorageServiceClient } from "../storage-service/storage-service";
import type {
	DataSource,
	ThoughtSpotService,
} from "../thoughtspot/thoughtspot-service";
import {
	type Answer,
	type ModelSessionState,
	type ModelUpdate,
	type StreamingMessagesState,
	ThoughtSpotApiError,
} from "../thoughtspot/types";
import { McpServerError } from "../utils";
import { BaseMCPServer, type Context } from "./mcp-server-base";
import {
	CreateAnalysisSessionInputSchema,
	CreateDashboardInputSchema,
	CreateLiveboardSchema,
	FinalizeModelInputSchema,
	GetAnswerSchema,
	GetDataSourceSuggestionsSchema,
	GetRelevantQuestionsSchema,
	GetSessionUpdatesInputSchema,
	SearchObjectsInputSchema,
	SendModelMessageInputSchema,
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
	private activeOrgId: string | undefined;
	private activeOrgToken: string | undefined;
	private globalToken: string | undefined;
	// False for pre-multi-org grants (no refresh token) — keeps old behavior until re-auth.
	private grantHasRefreshToken = false;

	constructor(ctx: Context) {
		super(ctx, "ThoughtSpot", "2.0.0");
	}

	protected getActiveOrgId(): string | undefined {
		return this.activeOrgId;
	}

	protected getActiveToken(): string {
		if (this.activeOrgId) {
			if (!this.activeOrgToken) {
				throw new Error(
					`Org ${this.activeOrgId} is active but its token is not minted`,
				);
			}
			return this.activeOrgToken;
		}
		if (this.globalToken) {
			return this.globalToken;
		}
		// No kept-warm token. Fall back to the grant's access token only if it has
		// not expired — an expired grant token is frozen at login and would just
		// 401 upstream, so fail closed here with a reauth-worthy error instead.
		const { accessToken, globalTokenExpiresAt } = this.ctx.props;
		if (accessToken && !MCPServer.isExpired(globalTokenExpiresAt)) {
			return accessToken;
		}
		throw new ThoughtSpotApiError(
			401,
			"getActiveToken",
			"No valid token available; the session token has expired. Please reauthenticate.",
		);
	}

	// A token whose absolute epoch-ms expiry is in the past. Non-numeric (unknown)
	// expiry is treated as NOT expired, matching the prior fallback behavior.
	private static isExpired(expiresAt: number | null | undefined): boolean {
		return typeof expiresAt === "number" && expiresAt <= Date.now();
	}

	private async loadActiveOrg(): Promise<void> {
		const store = await this.getOrgStorageService();
		const stored = await store.getActiveOrgIdAndToken();
		this.activeOrgId = stored.activeOrgId ?? undefined;
		this.activeOrgToken = stored.activeOrgToken ?? undefined;
	}

	private async setActiveOrg(orgId: string, orgToken?: string): Promise<void> {
		this.activeOrgId = orgId;
		this.activeOrgToken = orgToken;
		const store = await this.getOrgStorageService();
		await store.setActiveOrgIdAndToken(orgId, orgToken);
	}

	private apiErrorStatus(value: unknown): number | undefined {
		const err =
			value instanceof Error
				? value
				: ((value as { error?: unknown } | null)?.error ?? value);
		if (err instanceof ThoughtSpotApiError) {
			return err.status;
		}
		const message =
			typeof (err as { message?: unknown })?.message === "string"
				? (err as { message: string }).message
				: "";
		const match = message.match(/\bstatus (\d{3})\b/);
		return match ? Number(match[1]) : undefined;
	}

	private async forceRecreateActiveOrgToken(
		recorder?: MetricsRecorder,
	): Promise<void> {
		if (!this.activeOrgId) {
			return;
		}
		const globalToken = await this.initGlobalTokenAndReconcileWithStorage();
		const orgToken = await this.getOrgService(
			globalToken,
			undefined,
			recorder,
		).fetchOrgBearerToken(globalToken, this.activeOrgId);
		this.activeOrgToken = orgToken;
		await this.setActiveOrg(this.activeOrgId, orgToken);
	}

	protected async postInit(): Promise<void> {
		if (this.ctx.props.authMode !== "oauth") {
			return;
		}
		this.grantHasRefreshToken =
			typeof this.ctx.props.globalRefreshToken === "string";
		try {
			await this.initGlobalTokenAndReconcileWithStorage();
		} catch (error) {
			console.error("Failed to load/seed keep-warm token on connect:", error);
		}

		if (!this.areOrgToolsAvailable()) {
			return;
		}
		try {
			await this.loadActiveOrg();
			if (!this.activeOrgId) {
				const currentOrgId =
					this.sessionInfo?.currentOrgId != null
						? String(this.sessionInfo.currentOrgId)
						: undefined;
				if (currentOrgId) {
					// Set only in memory; do NOT persist the id yet. If the mint below
					// fails (e.g. a transient 5xx), persisting a tokenless active org
					// would poison every later call — getActiveToken() throws on an
					// active org with no token. forceRecreateActiveOrgToken persists the
					// id and token together only once the mint succeeds.
					this.activeOrgId = currentOrgId;
				}
			}
			if (this.activeOrgId && !this.activeOrgToken) {
				await this.forceRecreateActiveOrgToken();
			}
		} catch (error) {
			console.error("Failed to load active org on connect:", error);
			// A failed bootstrap must not leave the session with an active org but
			// no token; fall back to the global token until the next connect or the
			// keep-warm alarm re-mints.
			this.activeOrgId = undefined;
			this.activeOrgToken = undefined;
		}
	}

	// Resolves the global cluster token: prefers a still-valid stored (keep-warm)
	// token, else seeds the grant's access token and reconciles the DO. Sets and
	// returns this.globalToken. Throws 401 when no valid token exists so callers
	// never seed/mint/list with a dead token — no fallback to the frozen grant
	// token is needed at the call sites.
	private async initGlobalTokenAndReconcileWithStorage(): Promise<string> {
		const store = await this.getOrgStorageService();
		const {
			accessToken,
			globalRefreshToken,
			globalTokenExpiresAt,
			instanceUrl,
		} = this.ctx.props;

		const existing = await store.getGlobalTokenData();

		const storedToken = existing.globalToken ?? null;
		const storedExpired = MCPServer.isExpired(existing.globalTokenExpiresAt);
		const storedIsNewer =
			storedToken && storedToken !== accessToken && !storedExpired;

		if (storedIsNewer) {
			this.globalToken = storedToken;
			return storedToken;
		}

		// The grant's access token is frozen at login and never refreshed. If it's
		// already past its expiry, do NOT seed it into the DO (it would just 401
		// upstream).
		const propsTokenExpired = MCPServer.isExpired(globalTokenExpiresAt);

		if (accessToken && globalRefreshToken && !propsTokenExpired) {
			await store.setGlobalTokenData({
				globalToken: accessToken,
				globalRefreshToken,
				instanceUrl,
				globalTokenExpiresAt:
					typeof globalTokenExpiresAt === "number"
						? globalTokenExpiresAt
						: undefined,
			});
			this.globalToken = accessToken;
			return accessToken;
		}

		// Prefer a still-valid stored token; otherwise the grant token if it hasn't
		// expired.
		if (storedToken && !storedExpired) {
			this.globalToken = storedToken;
			return storedToken;
		}
		if (accessToken && !propsTokenExpired) {
			this.globalToken = accessToken;
			return accessToken;
		}

		// Nothing valid: the stored token (if any) is expired and the grant's frozen
		// access token is expired/absent. Fail closed so callers never send a dead
		// token; surfaces as a graceful reauth via the central 401 handler.
		this.globalToken = undefined;
		throw new ThoughtSpotApiError(
			401,
			"initGlobalTokenAndReconcileWithStorage",
			"No valid global token available; the session token has expired. Please reauthenticate.",
		);
	}

	private touchLastSeen(): void {
		this.getOrgStorageService()
			.then((store) => store.setLastSeen())
			.catch((error) => {
				console.error("Failed to record last-seen activity:", error);
			});
	}

	protected getToolMetricApiSurface(): ToolMetricApiSurface {
		return "mcp";
	}

	protected areOrgToolsAvailable(): boolean {
		if (
			this.ctx.props.authMode !== "oauth" ||
			!this.isOrgsEnabled() ||
			!this.grantHasRefreshToken
		) {
			return false;
		}
		try {
			return resolveApiVersion(this.ctx.props.apiVersion).tools.some(
				(tool) => tool?.name === ToolName.ListOrgs,
			);
		} catch {
			return false;
		}
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
			!this.isSpotterDataSourceDiscoveryEnabled() &&
			tools.some((tool) => tool.name === ToolName.GetDataSourceSuggestions)
		) {
			tools = tools.filter(
				(tool) => tool.name !== ToolName.GetDataSourceSuggestions,
			);
		}

		if (!this.areOrgToolsAvailable()) {
			tools = tools.filter(
				(tool) =>
					tool.name !== ToolName.ListOrgs && tool.name !== ToolName.SwitchOrg,
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

		if (this.ctx.props.authMode === "oauth") {
			this.touchLastSeen();
		}

		if (this.areOrgToolsAvailable()) {
			// The active org is shared across the user's sessions via the token DO,
			// so reload per call — a switch_org in one session must be seen by the
			// others on their next tool call (an instance-cached value would go stale).
			await this.loadActiveOrg();
			if (this.activeOrgId && !this.activeOrgToken) {
				try {
					await this.forceRecreateActiveOrgToken(recorder);
				} catch (error) {
					// The mint can fail if the user lost access to the active org
					// (e.g. a 403). Return a graceful, actionable error instead of
					// letting it propagate as a raw JSON-RPC error.
					console.error("Failed to mint active org token on call:", error);
					return this.createErrorResponse(
						`Could not access the active org "${this.activeOrgId}"; it may no longer be available to you. Call list_orgs to see your orgs and switch_org to select a different one.`,
						"Active org token mint failed",
					);
				}
			}
		}

		try {
			// Non-orgs OAuth data tools authenticate with the global token directly
			// (no org preamble above refreshed it), so reconcile it from the DO per
			// call. Kept inside this try so its fail-closed 401 (expired token) is
			// caught by the central handler below rather than escaping raw.
			if (!this.areOrgToolsAvailable() && this.ctx.props.authMode === "oauth") {
				await this.initGlobalTokenAndReconcileWithStorage();
			}
			return await this.dispatchTool(name, request, recorder);
		} catch (error) {
			// A 401 anywhere in a tool (incl. getActiveToken refusing an expired
			// token) surfaces as a graceful reauth message rather than a raw
			// JSON-RPC error.
			if (this.apiErrorStatus(error) !== 401) {
				throw error;
			}
			return this.createErrorResponse(
				"Your authentication has expired, please reauthenticate and try again. You may need to disconnect and reconnect the MCP Server if you don't have any other way to reauthenticate.",
				"User authentication has expired, prompting them to reauthenticate",
			);
		}
	}

	private async dispatchTool(
		name: string,
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		switch (name) {
			case ToolName.Ping: {
				if (this.ctx.props.accessToken && this.ctx.props.instanceUrl) {
					if (
						!(await this.getThoughtSpotService(recorder).validateConnection())
					) {
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

			case ToolName.SearchObjects: {
				return this.callSearchObjects(request, recorder);
			}

			case ToolName.CheckConnectivity: {
				if (!this.ctx.props.accessToken || !this.ctx.props.instanceUrl) {
					return this.createErrorResponse(
						"Access token or instance URL not valid",
						"Check connectivity failed",
					);
				}
				if (
					!(await this.getThoughtSpotService(recorder).validateConnection())
				) {
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
				if (!this.areOrgToolsAvailable()) {
					return this.createErrorResponse(
						"The list_orgs tool is only available when authenticated via OAuth on a cluster with Orgs enabled.",
						"List orgs rejected: org tools unavailable",
					);
				}
				return this.callListOrgs(recorder);
			}

			case ToolName.SwitchOrg: {
				if (!this.areOrgToolsAvailable()) {
					return this.createErrorResponse(
						"The switch_org tool is only available when authenticated via OAuth on a cluster with Orgs enabled.",
						"Switch org rejected: org tools unavailable",
					);
				}
				return this.callSwitchOrg(request, recorder);
			}

			case ToolName.SendModelMessage: {
				return this.callSendModelMessage(request, recorder);
			}

			case ToolName.FinalizeModel: {
				return this.callFinalizeModel(request, recorder);
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
			response = await this.getThoughtSpotService(
				recorder,
			).createAgentConversation(
				this.isSpotterDataSourceDiscoveryEnabled(),
				this.isSpotterChatHistoryEnabled(),
				data_source_id,
			);
		} catch (error) {
			if (this.apiErrorStatus(error) !== 401) {
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

		try {
			await this.getThoughtSpotService(recorder, {
				analyticalSessionId: analytical_session_id,
			}).sendAgentConversationMessageStreaming(
				analytical_session_id,
				message,
				storageService.appendMessages.bind(storageService),
				additional_context,
			);
		} catch (error) {
			console.error("Error sending message to Spotter conversation:", error);
			try {
				// Close out the conversation state in the storage (mark isDone = true), so
				// that clients don't accidentally get stuck polling for updates forever
				await storageService.appendMessages(
					analytical_session_id,
					[
						{
							is_thinking: false,
							type: "text",
							text: "Something went wrong",
						},
					],
					true,
				);
			} catch (storageError) {
				console.error(
					"Error appending error message to storage service:",
					storageError,
				);
			}
			throw error;
		}

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

	@WithSpan("call-search-objects")
	async callSearchObjects(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const {
			query,
			types,
			author_name,
			tag,
			modified_since,
			verified_only,
			limit,
			cursor,
		} = SearchObjectsInputSchema.parse(request.params.arguments);

		try {
			const result = await this.getThoughtSpotService(recorder).searchObjects({
				query,
				types,
				owner: author_name,
				tag,
				modifiedSince: modified_since,
				verifiedOnly: verified_only,
				limit,
				cursor,
			});

			// Return no_results and error as normal structured content (not an MCP
			// protocol error) so the model still receives the structured response
			// and can relay the outcome to the user.
			const statusMessage =
				"status" in result
					? result.status === "error"
						? `search_objects error: ${result.error.code}`
						: "search_objects: no results"
					: `${result.results.length} object(s) found`;

			return this.createStructuredContentSuccessResponse(result, statusMessage);
		} catch (error) {
			// Surface the upstream message (e.g. status 401/500) so the failure is
			// actionable rather than a generic "check your inputs".
			return this.createErrorResponse(
				`Failed to search objects: ${(error as Error).message}`,
				"search_objects failed",
			);
		}
	}

	@WithSpan("call-list-orgs")
	async callListOrgs(recorder: MetricsRecorder) {
		const span = trace.getSpan(context.active());

		const globalToken = await this.initGlobalTokenAndReconcileWithStorage();
		const orgs = await this.getOrgService(
			globalToken,
			undefined,
			recorder,
		).listOrgs();
		span?.setAttribute("total_orgs", orgs.length);

		await this.loadActiveOrg();
		const activeOrgId = this.getActiveOrgId();

		return this.createStructuredContentSuccessResponse(
			{
				orgs: orgs.map((org) => {
					const isActive =
						activeOrgId !== undefined && String(org.id) === activeOrgId;
					return isActive ? { ...org, is_active: true } : { ...org };
				}),
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
		const orgId = String(org_id);
		span?.setAttribute("requested_org_id", orgId);

		let orgToken: string;
		try {
			const globalToken = await this.initGlobalTokenAndReconcileWithStorage();
			orgToken = await this.getOrgService(
				globalToken,
				undefined,
				recorder,
			).fetchOrgBearerToken(globalToken, orgId);
		} catch (error) {
			const status = this.apiErrorStatus(error);
			if (status !== undefined && status >= 400 && status < 500) {
				return this.createErrorResponse(
					`You do not have access to org "${orgId}", or it does not exist. Call list_orgs to see the orgs you can access.`,
					`Switch org failed: org not accessible (status ${status})`,
				);
			}
			console.error("Error switching org:", error);
			return this.createErrorResponse(
				`Failed to switch to org "${orgId}". Please try again.`,
				`Error switching org ${(error as Error)?.message ?? ""}`,
			);
		}

		await this.setActiveOrg(orgId, orgToken);
		this._sources = null;
		span?.setAttribute("active_org_id", orgId);

		try {
			await this.sendResourceListChanged();
		} catch (error) {
			console.error(
				"Failed to send resource list changed notification:",
				error,
			);
		}

		return this.createStructuredContentSuccessResponse(
			{ success: true, active_org_id: org_id },
			`Switched to org ${orgId}`,
		);
	}

	private _sources: {
		orgId: string | undefined;
		list: DataSource[];
		map: Map<string, DataSource>;
	} | null = null;

	@WithSpan("get-datasources")
	async getDatasources(recorder?: MetricsRecorder) {
		const orgId = this.getActiveOrgId();
		if (this._sources && this._sources.orgId === orgId) {
			return this._sources;
		}

		const sources = await this.getThoughtSpotService(recorder).getDataSources();
		this._sources = {
			orgId,
			list: sources,
			map: new Map(sources.map((s) => [s.id, s])),
		};
		return this._sources;
	}

	// Spotter Model (V3) — agentic model creation
	//
	// Session state is persisted in the ConversationStorageServerSQLite Durable Object (keyed by
	// model_session_id, same as the V2 analytical session tools) so it survives across worker
	// instances/restarts — a single MCP session can be served by different isolates per call.

	// Create a new Lumos model session on a connection and persist its scalar state; returns the new
	// model_session_id. Folded into send_model_message's first call (no model_session_id given) so the
	// model flow is just two tools: send_model_message and finalize_model.
	private async createModelSessionInternal(
		connectionIdentifier: string | undefined,
		recorder: MetricsRecorder,
		storageService: StorageServiceClient,
		modelIdentifier?: string,
	): Promise<string> {
		const svc = this.getThoughtSpotService(recorder);
		const resp = await svc.createModelSession(
			connectionIdentifier,
			modelIdentifier,
		);
		// Mint a session cookie (JSESSIONID) from the bearer token; forwarded on later /chat calls so
		// backend tools that require a cookie session (FormulaGen validation) work. Best-effort.
		let sessionCookie: string | undefined;
		try {
			sessionCookie = (await svc.mintSessionCookie()) ?? undefined;
		} catch (error) {
			console.error(
				`Failed to mint session cookie for model session: ${(error as Error).message}`,
			);
		}
		await storageService.putModelSession(resp.conversation_id, {
			transactionId: resp.transaction_id,
			// Upstream returns generation numbers as strings; store as a number so it stays a GraphQL
			// Int and can be compared/advanced.
			generationNo: Number(resp.generation_no),
			genNoWorkingSet: [],
			sessionCookie,
		});
		return resp.conversation_id;
	}

	@WithSpan("call-send-model-message")
	async callSendModelMessage(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const {
			connection_identifier,
			model_identifier,
			model_session_id: providedSessionId,
			message,
			selected_option_ids,
		} = SendModelMessageInputSchema.parse(request.params.arguments);
		const storageService = await this.getStorageService();

		// Resolve the session: continue an existing one, or (first call, only connection_identifier
		// given) create a new one — folding what used to be a separate create_model_session tool.
		let sessionId = providedSessionId;
		if (!sessionId) {
			if (!connection_identifier && !model_identifier) {
				return this.createErrorResponse(
					"No connection or model specified. To build a NEW model you MUST ask the user which " +
						"data-warehouse connection to build on and confirm the exact connection GUID with " +
						"them — do not guess, reuse a previous model's connection, or assume a default. To " +
						"EDIT an existing model, confirm which model and pass its model_identifier. Once " +
						"confirmed, call send_model_message again with that identifier. (To continue a " +
						"session already in progress, pass its model_session_id.)",
					"send_model_message called without model_session_id, connection_identifier or model_identifier",
				);
			}
			try {
				sessionId = await this.createModelSessionInternal(
					connection_identifier,
					recorder,
					storageService,
					model_identifier,
				);
			} catch (error) {
				return this.createErrorResponse(
					model_identifier
						? "Could not open that model for editing. Please verify the model identifier and your permissions on it, then try again."
						: "Could not start a model session. Please verify the connection and try again.",
					`Error creating model session: ${(error as Error).message}`,
				);
			}
		}

		const session = await storageService.getModelSession(sessionId);
		if (!session) {
			return this.createErrorResponse(
				"Unknown model_session_id. Start a session by calling send_model_message with connection_identifier.",
				"Model session not found",
			);
		}

		// No message and no clarification answer → poll-only continuation: fetch more updates for a
		// turn still in progress (what used to be a separate get_model_updates call).
		if (!message && !selected_option_ids) {
			const { updates, isDone } = await this.pollModelUpdates(
				storageService,
				sessionId,
			);
			return this.createStructuredContentSuccessResponse(
				{
					success: true,
					model_session_id: sessionId,
					updates,
					is_done: isDone,
				},
				isDone
					? "Model updates retrieved"
					: "More updates pending; call again with the same model_session_id and no message",
			);
		}

		// Answer a pending clarification by echoing the builder's choice object back with the chosen
		// options' is_selected flags set — the builder binds the answer by transaction_id+generation_no.
		const choice = selected_option_ids
			? this.buildChoiceAnswer(session.pendingChoice, selected_option_ids)
			: undefined;

		// The pending clarification is consumed by answering it; the stream re-emits META_CHOICE if
		// another is needed. Persist that (and reset the updates-done flag for this turn) BEFORE we
		// return, so a poll that races in immediately doesn't observe the previous turn's isDone. The
		// two writes touch disjoint keys on the same DO, so run them concurrently.
		session.pendingChoice = null;
		await Promise.all([
			storageService.putModelSession(sessionId, session),
			storageService.appendModelUpdates(sessionId, [], { resetDone: true }),
		]);

		// Open the upstream stream synchronously (surfaces connection/auth failures here), then consume
		// it in the BACKGROUND while we long-poll the store inline — so the whole turn usually comes
		// back in this one call (mirrors the V2 analytical-session fire-and-forget + long-poll split).
		let response: Response;
		try {
			response = await this.getThoughtSpotService(
				recorder,
			).sendModelMessageStreaming({
				conversation_identifier: sessionId,
				transaction_id: session.transactionId,
				generation_no: session.generationNo,
				gen_no_working_set: session.genNoWorkingSet,
				session_cookie: session.sessionCookie,
				message: message ?? "",
				choice,
			});
		} catch (error) {
			// Mark the turn done so a poller doesn't wait forever, then report the failure.
			await storageService.appendModelUpdates(sessionId, [], { isDone: true });
			return this.createErrorResponse(
				"Encountered an error while updating the model.",
				`Error sending model message: ${(error as Error).message}`,
			);
		}

		// consumeModelStreamToStorage is self-contained: it catches its own errors and always marks the
		// turn done, so the floating promise never rejects and a long-poller never hangs forever.
		void this.consumeModelStreamToStorage(
			response,
			sessionId,
			session,
			storageService,
		).catch((error) => {
			console.error(
				`Unhandled error in background model stream consumer for session ${sessionId}:`,
				(error as Error).message,
			);
		});

		// Collect this turn's updates inline via the bounded long-poll, so the common case is a single
		// round-trip. If the build outruns the poll window, return what we have with is_done=false and
		// the client continues by calling this tool again with the same model_session_id and no message.
		const { updates, isDone } = await this.pollModelUpdates(
			storageService,
			sessionId,
		);
		return this.createStructuredContentSuccessResponse(
			{ success: true, model_session_id: sessionId, updates, is_done: isDone },
			isDone
				? "Model message processed"
				: "Model message accepted; call again with the same model_session_id and no message for the remaining progress",
		);
	}

	// How many 500 ms poll iterations pollModelUpdates runs before returning is_done=false. This is
	// the single knob that trades call-count against per-call blocking time. Each MCP tool call also
	// carries ~10 s of claude.ai connector overhead, so FEWER, LONGER calls are faster overall — but
	// a call that blocks past the connector's per-call timeout is killed (red failure). EXPERIMENT
	// (2026-07-27): raised from 20 (~10 s) toward the connector ceiling so a turn resolves in ~1–3
	// calls instead of ~12. Tune down if long calls start timing out client-side.
	private static readonly MODEL_POLL_ITERATIONS = 120; // ~60 s

	// Long-poll the model-updates store, shared by send_model_message and get_model_updates: poll
	// every 500 ms, accumulating updates, and return as soon as the turn is done or after the window
	// elapses so a call never blocks indefinitely. We deliberately do NOT return early just because
	// some updates arrived — the goal is to capture the whole turn in a single call to minimize
	// round-trips, so we keep polling toward is_done. Safe to run while the background stream consumer
	// appends concurrently: the awaits release the Durable Object input gate so both progress (same
	// mechanism as the V2 get_session_updates long-poll). A build longer than the window returns
	// is_done=false, and the client continues with get_model_updates.
	private async pollModelUpdates(
		storageService: StorageServiceClient,
		modelSessionId: string,
		maxIterations: number = MCPServer.MODEL_POLL_ITERATIONS,
	): Promise<{ updates: ModelUpdate[]; isDone: boolean }> {
		const updates: ModelUpdate[] = [];
		let isDone = false;
		for (let i = 0; i < maxIterations; i++) {
			const batch = await storageService.getNewModelUpdates(modelSessionId);
			updates.push(...batch.updates);
			isDone = batch.isDone;

			if (isDone) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		return { updates, isDone };
	}

	// Parse Lumos SSE ("event: <TYPE>\ndata: <json>\n\n") into normalized updates, appending them to
	// the session's streaming-updates store as they arrive so get_model_updates can stream progress
	// incrementally. Runs in the background (waitUntil) after send_model_message has returned.
	//
	// Updates are buffered and flushed to the Durable Object in batches — immediately on structural
	// events (choice / model_state / notification / todo / action / message_end / error) so ordering,
	// progress, and clarifications surface promptly, and every FLUSH_THRESHOLD text chunks otherwise
	// so we don't do a DO write per token. Scalar session state (generation / pendingChoice) is
	// persisted whenever it changes, so the next turn edits against the live generation even if it
	// starts before this stream finishes.
	//
	// Event coverage mirrors the ThoughtSpot UI chat stream: MESSAGE_START (ignored), MESSAGE_DELTA
	// (text), NOTIFICATION (progress titles), META_TODO (auto-build task tracker), META_MODEL_STATE
	// (generation), META_CHOICE (clarification), META_ACTION (suggested next steps), META_ERROR, and
	// MESSAGE_END (authoritative turn completion + status).
	// Heuristic: does this turn's accumulated text read like a Model Requirements Document (MRD)?
	// The MRD is not a distinct Lumos event — it arrives as MESSAGE_DELTA markdown with a stable set
	// of section headings (Goal / Key Entities / Metrics / Dimensions / Key Analyses). Require at
	// least two markers so ordinary narration or a build summary that merely mentions one of these
	// words is not misclassified. Only consulted when the turn did NOT advance the model generation,
	// so build turns (which advance it) can never be tagged as MRD.
	private looksLikeMrd(text: string): boolean {
		if (!text) return false;
		const markers = [
			/model requirements/i,
			/key entities/i,
			/key analyses/i,
			/\bmetrics\b/i,
			/\bdimensions\b/i,
			/\bgoal\b/i,
		];
		return markers.filter((m) => m.test(text)).length >= 2;
	}

	// The planning turn's accumulated text is: the builder's chain-of-thought reasoning → tool-call
	// scaffolding (`<br>**INPUT**…**OUTPUT**…`) → the actual MRD (starts at a "Goal" heading) → more
	// scaffolding. For the `mrd` update we want only the plan, so slice from the first Goal heading to
	// the scaffolding that follows it. Falls back to the full (trimmed) text if the markers aren't
	// found, so we never drop the plan — worst case we're back to the old verbose behavior.
	private extractMrdPlan(text: string): string {
		const start = text.search(/\*{0,2}\s*Goal\s*\*{0,2}\s*:/i);
		if (start === -1) {
			return text.trim();
		}
		const rest = text.slice(start);
		// Cut trailing tool-call scaffolding that follows the plan (e.g. "<br>**INPUT** …").
		const end = rest.search(/<br\s*\/?>\s*\*{0,2}\s*INPUT\b/i);
		return (end === -1 ? rest : rest.slice(0, end)).trim();
	}

	// Reduce a non-planning turn's accumulated text to something presentable: strip the builder's
	// `**INPUT** … **OUTPUT**` tool-call scaffolding and <br> tags, collapse blank lines. Best-effort;
	// returns "" when nothing meaningful is left (the caller then emits no text update).
	private cleanTurnText(text: string): string {
		return text
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(
				/\*{0,2}\s*INPUT\s*\*{0,2}[\s\S]*?\*{0,2}\s*OUTPUT\s*\*{0,2}/gi,
				"",
			)
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	private async consumeModelStreamToStorage(
		response: Response,
		modelSessionId: string,
		session: ModelSessionState,
		storageService: StorageServiceClient,
	): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		const pending: ModelUpdate[] = [];
		let scalarDirty = false;
		// Set when the turn's MESSAGE_END arrives — the authoritative end-of-turn signal.
		let ended = false;
		// Accumulate this turn's assistant text and remember the generation we started at, so at
		// MESSAGE_END we can recognize a planning (MRD) turn — one that produced a plan and stopped
		// for approval without advancing the model — and surface it as a distinct `mrd` update.
		let turnText = "";
		const turnStartGen = session.generationNo;

		const flush = async (isDone = false): Promise<void> => {
			// The scalar-state and update-stream writes go to the same DO but touch disjoint keys, so
			// fire them concurrently instead of paying two sequential round-trips per structural flush.
			const writes: Promise<unknown>[] = [];
			if (scalarDirty) {
				writes.push(storageService.putModelSession(modelSessionId, session));
				scalarDirty = false;
			}
			if (pending.length > 0 || isDone) {
				const batch = pending.splice(0, pending.length);
				writes.push(
					storageService.appendModelUpdates(modelSessionId, batch, {
						isDone,
					}),
				);
			}
			if (writes.length > 0) {
				await Promise.all(writes);
			}
		};

		// Parse one SSE block, push its normalized update, and report whether to flush now.
		const handleBlock = (block: string): boolean => {
			const lines = block.split("\n");
			const eventLine = lines.find((l) => l.startsWith("event:"));
			const dataLine = lines.find((l) => l.startsWith("data:"));
			if (!dataLine) return false;
			const eventType = (eventLine?.slice("event:".length) ?? "").trim();
			let data: any;
			try {
				data = JSON.parse(dataLine.slice("data:".length).trim());
			} catch {
				return false;
			}
			switch (eventType) {
				case "MESSAGE_DELTA":
					// Accumulate silently; we no longer stream raw text_chunks. The raw deltas carry the
					// builder's chain-of-thought and `**INPUT**/**OUTPUT**` tool scaffolding, which is
					// noise for the user. Instead we emit ONE cleaned text (or mrd) at MESSAGE_END; live
					// progress flows via the todo/notification/model_state updates.
					if (data.message_delta?.content) {
						turnText += data.message_delta.content;
					}
					return false;
				case "NOTIFICATION":
					if (data.notification?.title) {
						pending.push({
							type: "notification",
							text: data.notification.title,
						});
					}
					return true;
				case "META_CHOICE": {
					// data.meta_choice = { message, choice: {...}, transactionId, generationNo,
					//   pinnedClientGenerationNumber, ... }.
					// Remember the inner choice so send_model_message can echo it back with the
					// user's selection applied (the builder sends no choice_id to bind against).
					const metaChoice = data.meta_choice ?? {};
					if (metaChoice.choice && typeof metaChoice.choice === "object") {
						session.pendingChoice = metaChoice.choice;
					}
					this.advanceGeneration(session, metaChoice.generationNo);
					scalarDirty = true;
					pending.push({ type: "choice", choice: metaChoice });
					return true;
				}
				case "META_MODEL_STATE": {
					const genRaw =
						data.meta_model_state?.generation_no ??
						data.meta_model_state?.generationNo;
					this.advanceGeneration(session, genRaw);
					scalarDirty = true;
					pending.push({
						type: "model_state",
						generation_no: session.generationNo,
					});
					return true;
				}
				case "META_ERROR":
					pending.push({
						type: "text",
						text: `Error: ${data.meta_error?.error_response?.message ?? "unknown"}`,
					});
					return true;
				case "META_TODO": {
					// Auto-build progress tracker: tasks (e.g. Tables/Joins/Columns) with statuses
					// (PENDING/IN_PROGRESS/COMPLETED) and descriptions that fill in with results.
					const tasks = data.meta_todo?.tasks;
					if (Array.isArray(tasks)) {
						pending.push({ type: "todo", tasks });
					}
					return true;
				}
				case "META_ACTION": {
					// Suggested next actions (e.g. "Create Joins", "Select Columns") — not required.
					const actions = data.meta_action?.actions;
					if (Array.isArray(actions)) {
						pending.push({ type: "action", actions });
					}
					return true;
				}
				case "MESSAGE_END": {
					// Authoritative end-of-turn marker; message_end.status is e.g. "completed".
					ended = true;
					// Planning (MRD) turn: the builder streamed a plan (Model Requirements Document) and
					// stopped for approval WITHOUT building — the generation never advanced this turn and
					// the text reads like an MRD. Surface it as a distinct `mrd` update carrying the plan
					// so the client presents it for approval instead of treating it as a built model.
					const built = session.generationNo > turnStartGen;
					if (!built && this.looksLikeMrd(turnText)) {
						pending.push({ type: "mrd", text: this.extractMrdPlan(turnText) });
					} else {
						const cleaned = this.cleanTurnText(turnText);
						if (cleaned) {
							pending.push({ type: "text", text: cleaned });
						}
					}
					pending.push({
						type: "message_end",
						status: String(data.message_end?.status ?? "completed"),
					});
					return true;
				}
				default:
					// MESSAGE_START and any unrecognized event: no user-facing payload.
					return false;
			}
		};

		try {
			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error("Failed to get reader from model stream response");
			}
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let idx: number;
				// biome-ignore lint: sequential block extraction
				while ((idx = buffer.indexOf("\n\n")) !== -1) {
					const block = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);
					if (block.trim() && handleBlock(block)) await flush();
				}
				// MESSAGE_END is the authoritative end of the turn; stop reading even if the
				// upstream connection lingers, so is_done is set promptly.
				if (ended) break;
			}
			if (!ended && buffer.trim()) handleBlock(buffer);
			// Final flush marks the turn done so pollers stop.
			await flush(true);
		} catch (error) {
			// The caller already returned, so surface failures into the update stream and always
			// mark the turn done — otherwise get_model_updates would poll forever.
			console.error(
				`Error consuming model stream for session ${modelSessionId}:`,
				(error as Error).message,
			);
			pending.push({
				type: "text",
				text: `Error: ${(error as Error).message}`,
			});
			try {
				await flush(true);
			} catch (flushError) {
				console.error(
					`Failed to persist final model updates for session ${modelSessionId}:`,
					(flushError as Error).message,
				);
			}
		}
	}

	/**
	 * Whether finalize_model commits through Lumos instead of driving bach from here.
	 *
	 * Off by default: the bach/GraphQL path in addSaveModel is what ships today and mirrors the
	 * modelling UI's Save exactly. The Lumos path removes this worker's need to accumulate the
	 * generation working set (a missed SSE event there silently truncates the saved model), but
	 * whether Lumos's server-derived pin set matches this one is not yet validated on a real
	 * session -- notably when the UI makes manual edits mid-session. Flip only after comparing
	 * both pin sets on a live build, including one with external UI edits.
	 */
	private isSaveViaLumosEnabled(): boolean {
		const flag = (this.ctx.env as unknown as Record<string, unknown>)
			?.SAVE_VIA_LUMOS;
		return flag === true || flag === "true" || flag === "1";
	}

	/**
	 * Advance the session's tracked generation to the latest one the server reports. Coerces from
	 * string (this API sends generation numbers as strings) and only ever moves forward, so a stray
	 * lower value can't clobber accumulated state. This is what we send as generation_no on the next
	 * edit, so the builder's auto "manual edits" save pins against the live generation instead of the
	 * stale gen-1 baseline (which was silently wiping earlier turns' tables).
	 */
	private advanceGeneration(
		session: { generationNo: number; genNoWorkingSet?: number[] },
		raw: unknown,
	): void {
		const next = Number(raw);
		if (!Number.isFinite(next)) {
			return;
		}
		if (next > session.generationNo) {
			session.generationNo = next;
		}
		// Accumulate this edit generation into the working set the SAVE request needs.
		if (session.genNoWorkingSet && !session.genNoWorkingSet.includes(next)) {
			session.genNoWorkingSet.push(next);
			session.genNoWorkingSet.sort((a, b) => a - b);
		}
	}

	/**
	 * Build the answer to a pending clarification by cloning the builder's choice object and setting
	 * each option's is_selected flag according to the user's selection. The builder does not surface
	 * a choice_id, so the whole choice envelope is echoed back (upstream binds it by
	 * transaction_id + generation_no).
	 *
	 * Each entry in choice_options is a single-key wrapper keyed by the option kind (e.g.
	 * { table_option: { id, is_selected, ... } } for choice_option_type TABLE_SELECT). We locate the
	 * inner object generically so this works across option kinds, and match on its `id`.
	 *
	 * Two selection mechanisms, detected by whether the option kind carries an is_selected flag:
	 *   - Flagged kinds (table/column/join_option arrive with is_selected): keep every option and
	 *     toggle its is_selected per the user's choice.
	 *   - Unflagged kinds (formula_option has no is_selected): answer by including ONLY the chosen
	 *     options in the array — injecting is_selected here makes the builder see no valid selection
	 *     (FormulaGen returns 0 formulas).
	 *
	 * Returns undefined when there is no pending choice to answer, so the message is sent as plain
	 * text rather than a (malformed) empty choice.
	 */
	private buildChoiceAnswer(
		pendingChoice: Record<string, unknown> | null | undefined,
		selectedOptionIds: string[],
	): Record<string, unknown> | undefined {
		if (!pendingChoice || typeof pendingChoice !== "object") {
			return undefined;
		}
		const selected = new Set(selectedOptionIds);
		// Deep clone so we never mutate the stored session state.
		const answer = JSON.parse(JSON.stringify(pendingChoice)) as Record<
			string,
			unknown
		>;
		const options = Array.isArray(answer.choice_options)
			? (answer.choice_options as Array<Record<string, unknown>>)
			: [];
		const innerOf = (
			option: Record<string, unknown>,
		): Record<string, unknown> | undefined => {
			const key = Object.keys(option)[0];
			const inner = key ? option[key] : undefined;
			return inner && typeof inner === "object"
				? (inner as Record<string, unknown>)
				: undefined;
		};
		// Flagged kinds carry a native is_selected; unflagged kinds (formulas) do not.
		const usesFlag = options.some((o) => {
			const inner = innerOf(o);
			return inner ? "is_selected" in inner : false;
		});
		if (usesFlag) {
			for (const option of options) {
				const inner = innerOf(option);
				if (inner && "id" in inner) {
					inner.is_selected = selected.has(String(inner.id));
				}
			}
		} else {
			answer.choice_options = options.filter((option) => {
				const inner = innerOf(option);
				return inner && "id" in inner && selected.has(String(inner.id));
			});
		}
		return answer;
	}

	// Render a clean, structured finalize summary from a fetchWorksheetModel response: counts of
	// tables/joins/columns (with table names). Returns null when the model is empty or the shape is
	// unrecognized, so the caller can fall back to a generic message.
	private summarizeWorksheetModel(resp: any): string | null {
		const wm = resp?.data?.Worksheet__operation?.worksheetModel;
		if (!wm) return null;
		const tables = Array.isArray(wm.schemaGraphProto?.schemaTables)
			? wm.schemaGraphProto.schemaTables
			: [];
		const joins = Array.isArray(wm.schemaJoins) ? wm.schemaJoins : [];
		const columnGroups = Array.isArray(wm.columnGroup) ? wm.columnGroup : [];
		const columnCount = columnGroups.reduce(
			(n: number, g: any) =>
				n + (Array.isArray(g?.worksheetColumn) ? g.worksheetColumn.length : 0),
			0,
		);
		const names = tables
			.map((t: any) => t?.userDefinedName)
			.filter(
				(x: unknown): x is string => typeof x === "string" && x.length > 0,
			);
		if (tables.length === 0 && joins.length === 0 && columnCount === 0) {
			return null;
		}
		const tablePart = names.length
			? `${tables.length} tables (${names.join(", ")})`
			: `${tables.length} tables`;
		return `${tablePart}, ${joins.length} joins, ${columnCount} columns.`;
	}

	@WithSpan("call-finalize-model")
	async callFinalizeModel(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const { model_session_id, name, description, confirm } =
			FinalizeModelInputSchema.parse(request.params.arguments);
		const storageService = await this.getStorageService();
		const session = await storageService.getModelSession(model_session_id);
		if (!session) {
			return this.createErrorResponse(
				"Unknown model_session_id.",
				"Model session not found",
			);
		}

		// Review step (no confirm): do not save. The turn's tables/joins/columns were already
		// delivered to the client incrementally as updates, so the review just asks the user to
		// confirm save vs. make more changes.
		if (!confirm) {
			// Build the review summary from the ACTUAL materialized model (structured counts + names),
			// not from model-generated prose (which leaks chain-of-thought/scaffolding or comes back
			// empty). The `summary` field is USER-FACING content only — the save-vs-make-changes flow
			// guidance lives in this tool's description, NOT here, so no meta-instructions leak into it.
			// Best-effort: on any fetch/parse failure, fall back to a plain ready-to-review line.
			let summary = "The model is ready to review before saving.";
			try {
				const model = await this.getThoughtSpotService(
					recorder,
				).fetchWorksheetModel({
					session_identifier: session.transactionId,
					generation_number: session.generationNo,
					gen_no_working_set: session.genNoWorkingSet,
				});
				const contents = this.summarizeWorksheetModel(model);
				if (contents) {
					summary = `The model is ready to save. It contains ${contents}`;
				}
			} catch (error) {
				console.error(
					`Failed to fetch worksheet model for finalize review: ${(error as Error).message}`,
				);
			}
			return this.createStructuredContentSuccessResponse(
				{ summary, saved: false },
				"Model summary for review",
			);
		}

		try {
			const svc = this.getThoughtSpotService(recorder);
			const result = this.isSaveViaLumosEnabled()
				? await svc.saveModelViaLumos({
						model_session_id,
						name,
						description,
						session_cookie: session.sessionCookie,
					})
				: await svc.saveModel({
						transaction_id: session.transactionId,
						generation_no: session.generationNo,
						gen_no_working_set: session.genNoWorkingSet,
						name,
						description,
					});
			return this.createStructuredContentSuccessResponse(
				{
					saved: true,
					model_identifier: result.model_identifier,
					url: result.url,
				},
				"Model saved",
			);
		} catch (error) {
			return this.createErrorResponse(
				"Encountered an error while saving the model.",
				`Error finalizing model: ${(error as Error).message}`,
			);
		}
	}
}
