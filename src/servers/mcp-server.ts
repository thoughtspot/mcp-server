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
import type { MetricAnalyticsContext } from "../metrics/runtime/metrics-sink";
import type { ToolMetricApiSurface } from "../metrics/runtime/tool-metrics";
import { WithSpan } from "../metrics/tracing/tracing-utils";
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
	// In-memory mirrors of the active org + its org-scoped token, loaded each
	// request from the shared per-user store (the durable source of truth; shared
	// so the token is minted once and reused across the user's fanned-out sessions).
	private activeOrgId: string | undefined;
	private activeOrgToken: string | undefined;

	// In-memory copy of the keep-warm global token, loaded from the (alarm-refreshed)
	// token store on connect; props is only the login-time seed/fallback.
	private warmGlobalToken: string | undefined;

	constructor(ctx: Context) {
		super(ctx, "ThoughtSpot", "2.0.0");
	}

	// Keep-warm token if loaded, else the login-time props token.
	private getGlobalToken(): string {
		return this.warmGlobalToken ?? this.ctx.props.accessToken;
	}

	protected getActiveOrgId(): string | undefined {
		return this.activeOrgId;
	}

	// Org-scoped token for the active org if held, else the global token.
	protected getActiveBearerToken(): string {
		const orgToken = this.activeOrgId ? this.activeOrgToken : undefined;
		return orgToken ?? this.getGlobalToken();
	}

	// Load active org + its token from the shared store. Re-read on each org-aware
	// call so a switch in another fanned-out session is reflected.
	private async loadActiveOrg(): Promise<void> {
		const storage = await this.getStorageService();
		const stored = await storage.getActiveOrg();
		this.activeOrgId = stored.activeOrgId ?? undefined;
		this.activeOrgToken = stored.orgToken ?? undefined;
	}

	private async setActiveOrg(orgId: string): Promise<void> {
		this.activeOrgId = orgId;
		this.activeOrgToken = undefined; // belongs to the prior org; re-minted lazily
		const storage = await this.getStorageService();
		await storage.setActiveOrg(orgId);
	}

	// Return the active org's token, reusing the shared-store one if present, else
	// minting from the global token and persisting it (so the fan-out mints once).
	private async ensureOrgToken(
		orgId: string,
		recorder?: MetricsRecorder,
	): Promise<string> {
		if (this.activeOrgId === orgId && this.activeOrgToken) {
			return this.activeOrgToken;
		}
		const globalToken = this.getGlobalToken();
		const orgToken = await this.getOrgService(
			globalToken,
			undefined,
			recorder,
		).fetchOrgBearerToken(globalToken, orgId);
		this.activeOrgToken = orgToken;
		const storage = await this.getStorageService();
		await storage.setActiveOrgToken(orgToken);
		return orgToken;
	}

	// HTTP status from an error (thrown, or stored on an `{ error }` result),
	// preferring the structured ThoughtSpotApiError. Falls back to parsing a
	// "status NNN" message for untyped errors (e.g. from the SDK or network layer).
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

	// Whether an error carries a 401 (the org-token-stale signal for re-mint).
	private isUnauthorizedError(value: unknown): boolean {
		return this.apiErrorStatus(value) === 401;
	}

	// Evict the active org's token (memory + shared store) and re-mint. Recovers
	// from a stale org token (30-day validity) without making the user re-switch.
	private async forceRemintOrgToken(
		orgId: string,
		recorder?: MetricsRecorder,
	): Promise<void> {
		this.activeOrgToken = undefined;
		try {
			const storage = await this.getStorageService();
			await storage.setActiveOrgToken("");
		} catch (error) {
			// Best-effort: a failed clear must not block the re-mint.
			console.error("Failed to clear stale org token in store:", error);
		}
		await this.ensureOrgToken(orgId, recorder);
	}

	// Run an org-scoped call with a single reactive re-mint+retry on a 401, but
	// only when an org token is actually in use (a global-token 401 is a separate
	// concern and passes through). Handles both thrown and `{ error }`-result 401s.
	protected async withOrgTokenRetry<T>(
		recorder: MetricsRecorder | undefined,
		fn: (service: ThoughtSpotService) => Promise<T>,
		analyticsContextOverride?: MetricAnalyticsContext,
	): Promise<T> {
		const orgId = this.activeOrgId;
		const usedOrgToken = Boolean(orgId && this.activeOrgToken);

		const attempt = () =>
			fn(this.getThoughtSpotService(recorder, analyticsContextOverride));

		if (!usedOrgToken || !orgId) {
			return attempt();
		}

		try {
			const result = await attempt();
			if (this.isUnauthorizedError(result)) {
				await this.forceRemintOrgToken(orgId, recorder);
				return attempt();
			}
			return result;
		} catch (error) {
			if (this.isUnauthorizedError(error)) {
				await this.forceRemintOrgToken(orgId, recorder);
				return attempt();
			}
			throw error;
		}
	}

	// validateConnection maps a 401 to `false` (no throw / no `{ error }`), so the
	// generic retry can't see it. If it fails while an org token is in use, re-mint
	// and re-validate — a stale org token is the likely cause.
	private async validateConnectionWithOrgRetry(
		recorder?: MetricsRecorder,
	): Promise<boolean> {
		const orgId = this.activeOrgId;
		const usedOrgToken = Boolean(orgId && this.activeOrgToken);
		const ok = await this.getThoughtSpotService(recorder).validateConnection();
		if (ok || !usedOrgToken || !orgId) {
			return ok;
		}
		await this.forceRemintOrgToken(orgId, recorder);
		return this.getThoughtSpotService(recorder).validateConnection();
	}

	// On connect (OAuth only): keep the cluster-wide token warm, then — only when
	// org tools are available (OAuth + orgs enabled + v2) — establish the active
	// org (a prior switch wins, else the session's current org) and mint its token.
	// A v1 or non-org session gets no org overlay. Best-effort: never break connect.
	protected async postInit(): Promise<void> {
		if (!this.isOAuthAuth()) {
			return;
		}
		try {
			await this.loadOrSeedWarmToken();
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
					await this.setActiveOrg(currentOrgId);
				}
			}
			// After the id is set, so setActiveOrg doesn't clear what we mint.
			if (this.activeOrgId) {
				await this.ensureOrgToken(this.activeOrgId);
			}
		} catch (error) {
			console.error("Failed to set/mint active org on connect:", error);
		}
	}

	// Load the keep-warm global token into memory. Re-seed from props when the
	// store is unseeded OR holds an expired token (the refresh chain died) — the
	// connect's props carry a fresh grant token, which heals the chain. Otherwise
	// the alarm-refreshed store is the source of truth.
	private async loadOrSeedWarmToken(): Promise<void> {
		const storage = await this.getStorageService();
		const store = await storage.getTokenStore();
		const storedExpired =
			typeof store.expiresAt === "number" && store.expiresAt <= Date.now();
		if (store.accessToken && !storedExpired) {
			this.warmGlobalToken = store.accessToken;
			return;
		}
		const { accessToken, refreshToken, tokenExpiryDuration, instanceUrl } =
			this.ctx.props;
		if (accessToken && refreshToken) {
			await storage.seedTokenStore({
				accessToken,
				refreshToken,
				instanceUrl,
				expiresAt:
					typeof tokenExpiryDuration === "number"
						? tokenExpiryDuration
						: undefined,
			});
			this.warmGlobalToken = accessToken;
			return;
		}
		// No refresh token to re-seed with: use whatever we have.
		this.warmGlobalToken = store.accessToken ?? accessToken;
	}

	// Record user activity for idle detection. Fire-and-forget (throttle + delete
	// live in the DO); no-op if there's no keep-warm store.
	private touchLastSeen(): void {
		this.getStorageService()
			.then((storage) => storage.touchLastSeen())
			.catch((error) => {
				console.error("Failed to record last-seen activity:", error);
			});
	}

	protected getToolMetricApiSurface(): ToolMetricApiSurface {
		return "mcp";
	}

	/**
	 * Whether the current connection authenticated via OAuth (as opposed to a static
	 * bearer/token). Used to gate OAuth-only tools such as `list_orgs`.
	 */
	protected isOAuthAuth(): boolean {
		return this.ctx.props.authMode === "oauth";
	}

	// Org tools + overlay require OAuth, orgs enabled, and the v2 surface (v1 gets
	// no org behavior). v2 is inferred from the resolved tool set, not a hardcoded
	// label. Fails closed.
	protected areOrgToolsAvailable(): boolean {
		if (!this.isOAuthAuth() || !this.isOrgsEnabled()) {
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
			!this.isDatasourceDiscoveryAvailable() &&
			tools.some((tool) => tool.name === ToolName.GetDataSourceSuggestions)
		) {
			tools = tools.filter(
				(tool) => tool.name !== ToolName.GetDataSourceSuggestions,
			);
		}

		// Org tools are gated (OAuth + orgs enabled + v2).
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

		// Record activity for idle detection (OAuth sessions only).
		if (this.isOAuthAuth()) {
			this.touchLastSeen();
		}

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
				if (!(await this.validateConnectionWithOrgRetry(recorder))) {
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
				// Defense in depth: also reject direct invocation when unavailable.
				if (!this.areOrgToolsAvailable()) {
					return this.createErrorResponse(
						"The list_orgs tool is only available when authenticated via OAuth on a cluster with Orgs enabled.",
						"List orgs rejected: org tools unavailable",
					);
				}
				return this.callListOrgs(recorder);
			}

			case ToolName.SwitchOrg: {
				// Defense in depth: also reject direct invocation when unavailable.
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
			response = await this.withOrgTokenRetry(recorder, (svc) =>
				svc.createAgentConversation(data_source_id),
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

		await this.withOrgTokenRetry(
			recorder,
			(svc) =>
				svc.sendAgentConversationMessageStreaming(
					analytical_session_id,
					message,
					storageService.appendMessages.bind(storageService),
					additional_context,
				),
			{ analyticalSessionId: analytical_session_id },
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

		const liveboard = await this.withOrgTokenRetry(recorder, (svc) =>
			svc.fetchTMLAndCreateLiveboard(title, transformedAnswers, note_tile),
		);

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

	@WithSpan("call-list-orgs")
	async callListOrgs(recorder: MetricsRecorder) {
		const span = trace.getSpan(context.active());

		// User-scoped list via the global token — no org header.
		const orgs = await this.getOrgService(
			this.getGlobalToken(),
			undefined,
			recorder,
		).listOrgs();
		span?.setAttribute("total_orgs", orgs.length);

		// Re-read from the shared store: this may run on a different DO than the switch.
		await this.loadActiveOrg();
		const activeOrgId = this.getActiveOrgId();

		return this.createStructuredContentSuccessResponse(
			{
				orgs: orgs.map((org) => ({
					...org,
					is_active:
						activeOrgId !== undefined && String(org.id) === activeOrgId,
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
		const orgId = String(org_id);
		span?.setAttribute("requested_org_id", orgId);

		// The mint validates access — 401/403 means the user can't reach the org.
		await this.setActiveOrg(orgId);
		try {
			await this.ensureOrgToken(orgId, recorder);
		} catch (error) {
			const status = this.apiErrorStatus(error);
			if (status === 401 || status === 403) {
				return this.createErrorResponse(
					`You do not have access to org "${orgId}", or it does not exist. Call list_orgs to see the orgs you can access.`,
					"Switch org failed: org not accessible (401/403)",
				);
			}
			return this.createErrorResponse(
				`Failed to switch to org "${orgId}". Please try again.`,
				`Error switching org ${(error as Error)?.message ?? ""}`,
			);
		}

		// Data sources are org-specific; drop the cached set so the next lookup
		// reflects the newly selected org.
		this._sources = null;
		span?.setAttribute("active_org_id", orgId);

		return this.createStructuredContentSuccessResponse(
			{ success: true, active_org_id: org_id },
			`Switched to org ${orgId}`,
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
