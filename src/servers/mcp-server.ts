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
import {
	DashboardTurnBusyError,
	type DashboardTurnOutcome,
	pollDashboardTurn,
	runDashboardTurn,
} from "../spotterviz/dashboard-orchestrator";
import {
	composeCreatePrompt,
	composeModifyPrompt,
} from "../spotterviz/dashboard-prompt";
import type {
	DataSource,
	ThoughtSpotService,
} from "../thoughtspot/thoughtspot-service";
import {
	type Answer,
	type StreamingMessagesState,
	ThoughtSpotApiError,
} from "../thoughtspot/types";
import { McpServerError } from "../utils";
import { BaseMCPServer, type Context } from "./mcp-server-base";
import {
	CreateAnalysisSessionInputSchema,
	CreateDashboardInputSchema,
	CreateLiveboardSchema,
	GetAnswerSchema,
	GetDashboardStatusInputSchema,
	GetDataSourceSuggestionsSchema,
	GetRelevantQuestionsSchema,
	GetSessionUpdatesInputSchema,
	ModifyDashboardInputSchema,
	SendSessionMessageInputSchema,
	SpotterVizCreateSessionInputSchema,
	SpotterVizGetUpdatesInputSchema,
	SpotterVizSaveLiveboardInputSchema,
	SpotterVizSubmitQueryInputSchema,
	SwitchOrgInputSchema,
	ToolName,
} from "./tool-definitions";
import {
	type VersionConfig,
	resolveApiVersion,
	resolveApiVersionMetrics,
} from "./version-registry";

/**
 * Superseded by `create_dashboard` / `modify_dashboard`. Hidden from `tools/list` so calling agents
 * are not asked to choose between overlapping tools, but still dispatchable for existing callers.
 */
const HIDDEN_SPOTTERVIZ_TOOLS: ReadonlySet<string> = new Set([
	ToolName.SpotterVizCreateSession,
	ToolName.SpotterVizSubmitQuery,
	ToolName.SpotterVizGetUpdates,
	ToolName.SpotterVizSaveLiveboard,
]);

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

		// The low-level SpotterViz session tools are superseded by `create_dashboard` /
		// `modify_dashboard`, which do the same work in one call. Listing both makes a calling
		// agent choose between overlapping tools and get it wrong, so these are hidden. They stay
		// dispatchable for callers that already integrated against them.
		tools = tools.filter((tool) => !HIDDEN_SPOTTERVIZ_TOOLS.has(tool.name));

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

			case ToolName.ModifyDashboard: {
				return this.callModifyDashboard(request, recorder);
			}

			case ToolName.GetDashboardStatus: {
				return this.callGetDashboardStatus(request, recorder);
			}

			case ToolName.SpotterVizCreateSession: {
				return this.callSpotterVizCreateSession(request, recorder);
			}

			case ToolName.SpotterVizSubmitQuery: {
				return this.callSpotterVizSubmitQuery(request, recorder);
			}

			case ToolName.SpotterVizGetUpdates: {
				return this.callSpotterVizGetUpdates(request, recorder);
			}

			case ToolName.SpotterVizSaveLiveboard: {
				return this.callSpotterVizSaveLiveboard(request, recorder);
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
		const { title, answers, design_context, data_source_id, skip_layout } =
			CreateDashboardInputSchema.parse(request.params.arguments);
		const hasAnswers = Boolean(answers && answers.length > 0);
		span?.setAttributes({
			total_answers: answers?.length ?? 0,
			has_design_context: Boolean(design_context),
			skip_layout: skip_layout === true,
		});

		let liveboardId: string | undefined;
		let link: string | undefined;

		if (hasAnswers) {
			let transformedAnswers: Answer[] = [];
			try {
				transformedAnswers = (answers ?? []).map((answer) => {
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
			).fetchTMLAndCreateLiveboard(title, transformedAnswers);

			if (liveboard.error) {
				return this.createErrorResponse(
					"Encountered an error while creating the dashboard. Please check your inputs and try again.",
					`Error creating dashboard ${liveboard.error.message}`,
				);
			}

			liveboardId = liveboard.liveboardId;
			link = liveboard.url;
		}

		// Only skip the design pass when the caller explicitly asked to. Assembling answers alone
		// yields a uniform grid in array order with no grouping or styling, which is not worth
		// sharing; the previous tool set got styled because the calling agent was told to follow
		// every create with a styling call, and that outcome has to be preserved here.
		if (skip_layout) {
			return this.createStructuredContentSuccessResponse(
				{
					status: "completed" as const,
					dashboard_id: liveboardId,
					dashboard_url: link,
					link,
					changes_applied: true,
				},
				"Dashboard created successfully",
			);
		}

		return this.runDashboardWork(
			recorder,
			{
				existingLiveboardId: liveboardId,
				newLiveboardName: liveboardId ? undefined : title,
				buildMessage: () =>
					composeCreatePrompt({
						title,
						designContext: design_context,
						dataSourceId: data_source_id,
						hasExistingAnswers: hasAnswers,
					}),
			},
			{ link, legacyLink: true },
		);
	}

	@WithSpan("call-modify-dashboard")
	async callModifyDashboard(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const span = trace.getSpan(context.active());
		const { dashboard_id, task_id, instructions, data_source_id } =
			ModifyDashboardInputSchema.parse(request.params.arguments);
		span?.setAttributes({
			dashboard_id,
			has_task_id: Boolean(task_id),
		});

		// A task is bound to the dashboard it was opened against. Continuing one while naming a
		// different dashboard would silently change the wrong dashboard, so reject the mismatch
		// rather than trusting either value.
		if (task_id) {
			const mismatch = await this.findTaskDashboardMismatch(
				task_id,
				dashboard_id,
			);
			if (mismatch) {
				return this.createErrorResponse(mismatch.userMessage, mismatch.logNote);
			}
		}

		return this.runDashboardWork(recorder, {
			existingLiveboardId: dashboard_id,
			existingTaskId: task_id,
			buildMessage: () =>
				composeModifyPrompt({
					instructions,
					dataSourceId: data_source_id,
				}),
		});
	}

	/**
	 * Check that a task handle belongs to the dashboard the caller named. Returns a message to
	 * surface when it does not, or when the task can no longer be resolved at all.
	 */
	private async findTaskDashboardMismatch(
		taskId: string,
		dashboardId: string,
	): Promise<{ userMessage: string; logNote: string } | undefined> {
		let taskDashboardId: string | undefined;
		try {
			const storage = await this.getStorageService();
			const metadata = await storage.getMetadata<{ liveboardId?: string }>(
				taskId,
			);
			taskDashboardId = metadata.liveboardId;
		} catch (error) {
			console.error("Error resolving dashboard task:", error);
			return {
				userMessage:
					"That `task_id` could not be found. It may have expired. Call `modify_dashboard` again with just `dashboard_id` and your full instruction to start a fresh change.",
				logNote: `Failed to resolve task ${taskId}: ${error}`,
			};
		}

		if (!taskDashboardId) {
			return {
				userMessage:
					"That `task_id` is no longer available, most likely because it expired. Call `modify_dashboard` again with just `dashboard_id` and your full instruction to start a fresh change.",
				logNote: `Task ${taskId} has no liveboardId in metadata`,
			};
		}

		if (taskDashboardId !== dashboardId) {
			return {
				userMessage: `That \`task_id\` belongs to a different dashboard (${taskDashboardId}), not ${dashboardId}. Pass the \`dashboard_id\` the task was started against, or omit \`task_id\` to start a fresh change on ${dashboardId}.`,
				logNote: `Task ${taskId} is bound to ${taskDashboardId}, caller passed ${dashboardId}`,
			};
		}

		return undefined;
	}

	@WithSpan("call-get-dashboard-status")
	async callGetDashboardStatus(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const span = trace.getSpan(context.active());
		const { task_id } = GetDashboardStatusInputSchema.parse(
			request.params.arguments,
		);
		span?.setAttribute("dashboard_task_id", task_id);

		try {
			const service = await this.getSpotterVizService(recorder);
			const storage = await this.getStorageService();
			const outcome = await pollDashboardTurn(service, storage, task_id);
			return this.dashboardOutcomeResponse(outcome);
		} catch (error) {
			console.error("Error checking dashboard status:", error);
			return this.createErrorResponse(
				`Failed to check the dashboard status: ${(error as Error).message}`,
				"Dashboard status check failed",
			);
		}
	}

	/**
	 * Shared path for create and modify: resolve or reuse a designer session, run one turn under
	 * the hybrid wait, and map the outcome onto the tool result contract.
	 */
	private async runDashboardWork(
		recorder: MetricsRecorder,
		params: {
			existingLiveboardId?: string;
			newLiveboardName?: string;
			existingTaskId?: string;
			buildMessage: () => string;
		},
		extra: { link?: string; legacyLink?: boolean } = {},
	) {
		const { existingLiveboardId, newLiveboardName, existingTaskId } = params;

		try {
			const service = await this.getSpotterVizService(recorder);
			const storage = await this.getStorageService();

			// Continuing an existing task keeps the designer's prior context, which is what makes
			// answering its question work.
			const taskId =
				existingTaskId ??
				(
					await service.createSession({
						existingLiveboardId,
						newLiveboardName,
					})
				).spotterVizSessionId;

			const outcome = await runDashboardTurn({
				service,
				storage,
				taskId,
				message: params.buildMessage(),
				waitUntil: this.ctx.ctx?.waitUntil?.bind(this.ctx.ctx),
			});

			return this.dashboardOutcomeResponse(outcome, extra);
		} catch (error) {
			if (error instanceof DashboardTurnBusyError) {
				return this.createErrorResponse(
					"This dashboard is still being worked on. Call `get_dashboard_status` with the `task_id` you were given until it reports a final status, then try again.",
					`Dashboard turn already in flight: ${error.message}`,
				);
			}
			console.error("Error running dashboard work:", error);
			return this.createErrorResponse(
				`Failed to build the dashboard: ${(error as Error).message}`,
				"Dashboard work failed",
			);
		}
	}

	/**
	 * Map an orchestrator outcome onto the tool result contract shared by the dashboard tools.
	 *
	 * `legacyLink` is only set for `create_dashboard`, which has carried a `link` field since
	 * before these tools existed. The other tools' output schemas do not declare it, and Zod emits
	 * closed schemas, so adding it there would fail client-side validation.
	 */
	private dashboardOutcomeResponse(
		outcome: DashboardTurnOutcome,
		extra: { link?: string; legacyLink?: boolean } = {},
	) {
		const span = trace.getSpan(context.active());
		span?.setAttributes({
			dashboard_status: outcome.status,
			dashboard_task_id: outcome.taskId,
		});

		if (outcome.status === "in_progress") {
			return this.createStructuredContentSuccessResponse(
				{
					status: outcome.status,
					task_id: outcome.taskId,
					steps: outcome.steps,
					events_seen: outcome.eventsSeen,
					...(outcome.text ? { summary: outcome.text } : {}),
				},
				"Dashboard work still in progress",
			);
		}

		const base = {
			status: outcome.status,
			task_id: outcome.taskId,
			changes_applied: outcome.liveboardUpdated,
			steps: outcome.steps,
			...(outcome.text ? { summary: outcome.text } : {}),
		};

		if (outcome.status === "needs_input") {
			return this.createStructuredContentSuccessResponse(
				{
					...base,
					...(outcome.question ? { question: outcome.question } : {}),
					...(outcome.choice ? { choices: outcome.choice.choices } : {}),
				},
				"Dashboard work needs more input",
			);
		}

		if (outcome.status === "failed") {
			return this.createStructuredContentSuccessResponse(
				{ ...base, error: outcome.error },
				"Dashboard work failed",
			);
		}

		const url = outcome.dashboardUrl ?? extra.link;
		return this.createStructuredContentSuccessResponse(
			{
				...base,
				...(outcome.dashboardId ? { dashboard_id: outcome.dashboardId } : {}),
				...(url ? { dashboard_url: url } : {}),
				...(url && extra.legacyLink ? { link: url } : {}),
			},
			"Dashboard ready",
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

	@WithSpan("call-spotterviz-save-liveboard")
	async callSpotterVizSaveLiveboard(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const { spotterviz_session_id } = SpotterVizSaveLiveboardInputSchema.parse(
			request.params.arguments,
		);

		try {
			const service = await this.getSpotterVizService(recorder);
			const { liveboardId, liveboardUrl } = await service.saveLiveboard({
				spotterVizSessionId: spotterviz_session_id,
			});

			return this.createStructuredContentSuccessResponse(
				{ liveboard_id: liveboardId, liveboard_url: liveboardUrl },
				"SpotterViz liveboard saved successfully",
			);
		} catch (error) {
			console.error("Error saving SpotterViz liveboard:", error);
			return this.createErrorResponse(
				`Failed to save SpotterViz liveboard: ${(error as Error).message}`,
				"SpotterViz save liveboard failed",
			);
		}
	}

	@WithSpan("call-spotterviz-get-updates")
	async callSpotterVizGetUpdates(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const { spotterviz_session_id } = SpotterVizGetUpdatesInputSchema.parse(
			request.params.arguments,
		);

		try {
			const service = await this.getSpotterVizService(recorder);
			const { updates, isDone } = await service.getUpdates({
				spotterVizSessionId: spotterviz_session_id,
			});

			return this.createStructuredContentSuccessResponse(
				{ updates, is_done: isDone },
				"SpotterViz session updates retrieved successfully",
			);
		} catch (error) {
			console.error("Error getting SpotterViz updates:", error);
			return this.createErrorResponse(
				`Failed to get SpotterViz updates: ${(error as Error).message}`,
				"SpotterViz get updates failed",
			);
		}
	}

	@WithSpan("call-spotterviz-submit-query")
	async callSpotterVizSubmitQuery(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const { spotterviz_session_id, message } =
			SpotterVizSubmitQueryInputSchema.parse(request.params.arguments);

		const storageService = await this.getStorageService();
		try {
			await storageService.initializeConversation(spotterviz_session_id);
		} catch (error) {
			console.error(
				"Error initializing SpotterViz conversation in storage service:",
				error,
			);
			return this.createErrorResponse(
				"The SpotterViz session has an ongoing response to the previous message. Please continue to call `spotterviz_get_updates` until `is_done` is true before sending a followup message.",
				`Error submitting SpotterViz query for session ${spotterviz_session_id}: ${error}`,
			);
		}

		try {
			const service = await this.getSpotterVizService(recorder);
			const { streamPromise } = await service.submitQuery({
				spotterVizSessionId: spotterviz_session_id,
				message,
			});

			// Hand the stream-drain off to the Worker runtime so we can return immediately.
			// Falls through harmlessly in tests / non-Worker runtimes where waitUntil is absent.
			this.ctx.ctx?.waitUntil?.(streamPromise);

			return this.createStructuredContentSuccessResponse(
				{ success: true },
				"SpotterViz query submitted successfully",
			);
		} catch (error) {
			console.error("Error submitting SpotterViz query:", error);
			return this.createErrorResponse(
				`Failed to submit SpotterViz query: ${(error as Error).message}`,
				"SpotterViz submit query failed",
			);
		}
	}

	@WithSpan("call-spotterviz-create-session")
	async callSpotterVizCreateSession(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const { new_liveboard_name, existing_liveboard_id } =
			SpotterVizCreateSessionInputSchema.parse(request.params.arguments);

		try {
			const service = await this.getSpotterVizService(recorder);
			const result = await service.createSession({
				newLiveboardName: new_liveboard_name,
				existingLiveboardId: existing_liveboard_id,
			});

			return this.createStructuredContentSuccessResponse(
				{
					spotterviz_session_id: result.spotterVizSessionId,
					liveboard_id: result.liveboardId,
					liveboard_name: result.liveboardName,
				},
				"SpotterViz session created successfully",
			);
		} catch (error) {
			console.error("Error creating SpotterViz session:", error);
			return this.createErrorResponse(
				`Failed to create SpotterViz session: ${(error as Error).message}`,
				"SpotterViz session create failed",
			);
		}
	}
}
