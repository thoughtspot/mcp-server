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
	// In-memory mirror of the active org, loaded once per request lifecycle from
	// the shared per-user store (keyed by the storage-key hash, so it is the same
	// across all of the user's MCP sessions/DOs). Read synchronously by the
	// active-org/token accessors; the durable source of truth is the store.
	private activeOrgId: string | undefined;

	// In-memory mirror of the active org's bearer token, loaded from the shared
	// store alongside activeOrgId. The org token lives in the shared store (not a
	// per-DO map) so it is minted ONCE and reused across all of the user's
	// fanned-out MCP sessions/DOs — avoiding a mint call per fanned-out request
	// (important for clients like ChatGPT that open a new session per tool call).
	private activeOrgToken: string | undefined;

	// In-memory copy of the keep-warm global token loaded from the token store on
	// connect. The token store (refreshed by a DO alarm) is the source of truth so
	// the token survives the ~24h expiry even while the user is absent; props is
	// only the login-time seed/fallback.
	private warmGlobalToken: string | undefined;

	constructor(ctx: Context) {
		super(ctx, "ThoughtSpot", "2.0.0");
	}

	/**
	 * The global (cluster-wide) token to use: the keep-warm token from the token
	 * store if loaded, else the login-time token from props.
	 */
	private getGlobalToken(): string {
		return this.warmGlobalToken ?? this.ctx.props.accessToken;
	}

	/**
	 * The single accessor for the active org. Reads the in-memory mirror, which is
	 * loaded from the shared store on connect (postInit).
	 */
	protected getActiveOrgId(): string | undefined {
		return this.activeOrgId;
	}

	/**
	 * Use the org-scoped bearer token for the active org if we hold one; otherwise
	 * fall back to the session's global access token (from props/grant).
	 */
	protected getActiveBearerToken(): string {
		const orgToken = this.activeOrgId ? this.activeOrgToken : undefined;
		return orgToken ?? this.getGlobalToken();
	}

	/**
	 * Load the active org (id + org token) from the shared per-user store into the
	 * in-memory mirrors. Keyed by the storage-key hash (refresh-token based), so a
	 * switch made in any of the user's MCP sessions is visible here.
	 */
	private async loadActiveOrg(): Promise<void> {
		const storage = await this.getStorageService();
		const stored = await storage.getActiveOrg();
		// Always reflect the store (including back to undefined if cleared), since
		// the value may have changed in another of the user's sessions/DOs.
		this.activeOrgId = stored.activeOrgId ?? undefined;
		this.activeOrgToken = stored.orgToken ?? undefined;
	}

	/**
	 * Re-read the active org from the shared store. Because the MCP client may
	 * fan requests across multiple DOs, we re-read on each org-aware tool call so
	 * a switch made elsewhere is reflected, rather than trusting a stale mirror.
	 */
	private async ensureActiveOrgLoaded(): Promise<void> {
		await this.loadActiveOrg();
	}

	/**
	 * Persist the active org to the shared per-user store and update the in-memory
	 * mirror. Shared across the user's sessions; persists until the next switch or
	 * reauthentication (a new login changes the storage-key hash).
	 */
	private async setActiveOrg(orgId: string): Promise<void> {
		this.activeOrgId = orgId;
		// Changing the active org invalidates any held org token; it is re-minted
		// lazily on next use. setActiveOrg also clears the stored token (DO route).
		this.activeOrgToken = undefined;
		const storage = await this.getStorageService();
		await storage.setActiveOrg(orgId);
	}

	/**
	 * Ensure we hold an org-scoped bearer token for the active `orgId`. If the
	 * shared store already has one (minted by this or another fanned-out session),
	 * reuse it. Otherwise mint from the keep-warm global token and persist it to the
	 * shared store so other sessions/DOs reuse it instead of re-minting. Returns the
	 * org token.
	 */
	private async ensureOrgToken(
		orgId: string,
		recorder?: MetricsRecorder,
	): Promise<string> {
		// Reuse the token already loaded for this org (from the shared store).
		if (this.activeOrgId === orgId && this.activeOrgToken) {
			return this.activeOrgToken;
		}
		// Mint from the keep-warm global token so it works even after the login-time
		// token would have expired.
		const globalToken = this.getGlobalToken();
		const orgToken = await this.getThoughtSpotServiceWithToken(
			globalToken,
			undefined,
			recorder,
		).fetchOrgBearerToken(globalToken, orgId);
		this.activeOrgToken = orgToken;
		// Persist to the shared store so the fan-out reuses it (one mint, not N).
		const storage = await this.getStorageService();
		await storage.setActiveOrgToken(orgToken);
		return orgToken;
	}

	/**
	 * Whether an error (thrown Error, or an `{ error }` result returned by a
	 * service method) carries a 401/unauthorized signal. ThoughtSpot client
	 * methods throw `Error`s whose message embeds the HTTP status (e.g.
	 * "... failed with status 401: ..."); some service methods catch that and
	 * return it nested under `error`. We sniff both shapes for the status code.
	 */
	private isUnauthorizedError(value: unknown): boolean {
		const message =
			value instanceof Error
				? value.message
				: typeof (value as { error?: { message?: string } } | null)?.error
							?.message === "string"
					? (value as { error: { message: string } }).error.message
					: "";
		return /status 401\b/.test(message) || /\b401\b/.test(message);
	}

	/**
	 * Drop the active org's token (in memory and in the shared store) and mint a
	 * fresh one from the keep-warm global token. Used to recover from a stale
	 * org token: org-scoped tokens have a 30-day validity, so a user returning to
	 * a previously-selected org after a long absence can hit a 401 with no other
	 * recovery path than re-switching. This re-mints transparently instead.
	 */
	private async forceRemintOrgToken(
		orgId: string,
		recorder?: MetricsRecorder,
	): Promise<void> {
		this.activeOrgToken = undefined;
		// Clear the shared store too, so other fanned-out sessions don't keep
		// reusing the stale token. ensureOrgToken re-persists the fresh one.
		try {
			const storage = await this.getStorageService();
			await storage.setActiveOrgToken("");
		} catch (error) {
			// Best-effort: a failed clear must not block the re-mint+retry.
			console.error("Failed to clear stale org token in store:", error);
		}
		await this.ensureOrgToken(orgId, recorder);
	}

	/**
	 * Run an org-scoped ThoughtSpot call with a single reactive re-mint on a stale
	 * org token. `fn` receives a freshly-bound service (so the retry picks up the
	 * re-minted token). If the first attempt fails with a 401 AND an org token was
	 * actually in use, we re-mint that org's token once and retry. All other
	 * failures — and the case where no org token is active (so the global token is
	 * what 401'd) — pass straight through unchanged.
	 *
	 * Covers both error shapes: methods that throw, and methods that return an
	 * `{ error }` result. The retry triggers on either.
	 */
	protected async withOrgTokenRetry<T>(
		recorder: MetricsRecorder | undefined,
		fn: (service: ThoughtSpotService) => Promise<T>,
		analyticsContextOverride?: MetricAnalyticsContext,
	): Promise<T> {
		const orgId = this.activeOrgId;
		const usedOrgToken = Boolean(orgId && this.activeOrgToken);

		const attempt = () =>
			fn(this.getThoughtSpotService(recorder, analyticsContextOverride));

		// Only org-token calls are eligible for re-mint. If no org token is in use,
		// a 401 is about the global token (a different concern) — pass through.
		if (!usedOrgToken || !orgId) {
			return attempt();
		}

		try {
			const result = await attempt();
			// Methods that swallow the 401 into an `{ error }` result: re-mint+retry
			// once if that's what we got.
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

	/**
	 * validateConnection swallows a 401 into a `false` return (no throw, no
	 * `{ error }`), so withOrgTokenRetry can't see the auth failure. Handle it
	 * directly: if the check fails WHILE an org token is in use, re-mint that
	 * org's token once and re-validate — a stale org token is the most likely
	 * cause of a false negative here.
	 */
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

	/**
	 * On connect:
	 * 1. Always seed + keep warm the cluster-wide (global) token. This is org
	 *    agnostic: on a non-org cluster it is the only token, and on an org cluster
	 *    it is the basis for minting org-scoped tokens. Runs regardless of orgs.
	 * 2. If (and only if) Orgs are enabled on the cluster, establish the active
	 *    org and mint its org-scoped token. On a non-org cluster we read no org
	 *    info from session info and attach no org header — calls just use the
	 *    cluster-wide token.
	 *
	 * Active-org rule when orgs are enabled: a prior switch (stored in the shared
	 * per-user store) wins; otherwise default to the session's current org.
	 * Best-effort: failures must not break the connection. Only OAuth sessions
	 * carry a cluster-wide token that can mint tokens, so this is a no-op otherwise.
	 */
	protected async postInit(): Promise<void> {
		if (!this.isOAuthAuth()) {
			return;
		}
		// Always: keep the cluster-wide token warm (org-agnostic).
		try {
			await this.loadOrSeedWarmToken();
		} catch (error) {
			console.error("Failed to load/seed keep-warm token on connect:", error);
		}

		// Org overlay: only when org tools are available (OAuth + Orgs enabled on
		// the cluster + the v2 API surface). On a non-org cluster or a v1 session we
		// skip all org logic — no active org, no org-scoped token, no
		// x-thoughtspot-orgs header — and calls fall back to the cluster-wide token.
		if (!this.areOrgToolsAvailable()) {
			return;
		}
		try {
			await this.loadActiveOrg();
			// First connect / nothing stored: default the active org to the session's
			// current org (set the id; the org token is minted lazily below).
			if (!this.activeOrgId) {
				const currentOrgId =
					this.sessionInfo?.currentOrgId != null
						? String(this.sessionInfo.currentOrgId)
						: undefined;
				if (currentOrgId) {
					await this.setActiveOrg(currentOrgId);
				}
			}
			// Ensure the active org's token exists in the shared store (mint once,
			// reused across the fan-out). Runs after the id is set so the token isn't
			// cleared by setActiveOrg.
			if (this.activeOrgId) {
				await this.ensureOrgToken(this.activeOrgId);
			}
		} catch (error) {
			console.error("Failed to set/mint active org on connect:", error);
		}
	}

	/**
	 * Load the keep-warm global token from the per-user token store into memory. If
	 * the store hasn't been seeded yet (first connect), seed it from the login-time
	 * props (token + refresh token + expiry) so the DO alarm can keep it fresh, and
	 * use the props token for this request. The store (alarm-refreshed) is the
	 * source of truth thereafter, so the token survives the ~24h expiry across an
	 * absence.
	 */
	private async loadOrSeedWarmToken(): Promise<void> {
		const storage = await this.getStorageService();
		const store = await storage.getTokenStore();
		if (store.accessToken) {
			this.warmGlobalToken = store.accessToken;
			return;
		}
		// Not seeded yet — seed from props if we have both tokens.
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
		}
		this.warmGlobalToken = accessToken;
	}

	/**
	 * Record user activity for idle-session detection. Fire-and-forget: never
	 * block or fail a tool call on this (the throttling + delete logic lives in
	 * the DO). No-op if there's no keep-warm store to age out.
	 */
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

	/**
	 * Whether the resolved API surface is v2 (the tool set that includes the org
	 * tools). Org behavior is v2-only: v1 (backwards-compatibility) sessions must
	 * behave exactly as legacy single-org, with no org overlay. Determined from the
	 * same resolveApiVersion the tool listing uses (single source of truth) by
	 * checking whether the resolved tool set contains the org tools — so it tracks
	 * the registry rather than hardcoding version labels. Fails closed on error.
	 */
	protected isV2ApiSurface(): boolean {
		try {
			const versionConfig = resolveApiVersion(this.ctx.props.apiVersion);
			return versionConfig.tools.some(
				(tool) => tool?.name === ToolName.ListOrgs,
			);
		} catch {
			return false;
		}
	}

	/**
	 * Org tools (list_orgs/switch_org) AND the org overlay (active org, org-scoped
	 * token, x-thoughtspot-orgs header) are available only when the connection is
	 * OAuth (the only auth mode that can mint org-scoped tokens), the cluster has
	 * Orgs enabled, AND the client is on the v2 API surface. v1 sessions get no org
	 * behavior at all. Fails closed if anything is unknown.
	 */
	protected areOrgToolsAvailable(): boolean {
		return this.isOAuthAuth() && this.isOrgsEnabled() && this.isV2ApiSurface();
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

		// Org tools (list_orgs, switch_org) require OAuth AND Orgs enabled on the
		// cluster.
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

		// Record user activity for idle-session detection (best-effort, throttled
		// server-side). Only OAuth sessions have a keep-warm token store to age out.
		if (this.isOAuthAuth()) {
			this.touchLastSeen();
		}

		switch (name) {
			case ToolName.Ping: {
				if (this.ctx.props.accessToken && this.ctx.props.instanceUrl) {
					if (!(await this.validateConnectionWithOrgRetry(recorder))) {
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
				// Defense in depth: omitted from listTools when unavailable, but
				// reject direct invocation as well.
				if (!this.areOrgToolsAvailable()) {
					return this.createErrorResponse(
						"The list_orgs tool is only available when authenticated via OAuth on a cluster with Orgs enabled.",
						"List orgs rejected: org tools unavailable",
					);
				}
				return this.callListOrgs(recorder);
			}

			case ToolName.SwitchOrg: {
				// Defense in depth: omitted from listTools when unavailable, but
				// reject direct invocation as well.
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

		const relevantQuestions = await this.withOrgTokenRetry(recorder, (svc) =>
			svc.getRelevantQuestions(query, sourceIds!, additionalContext ?? ""),
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
	async callGetAnswer(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	) {
		const { question, datasourceId: sourceId } = GetAnswerSchema.parse(
			request.params.arguments,
		);

		const answer = await this.withOrgTokenRetry(recorder, (svc) =>
			svc.getAnswerForQuestion(question, sourceId, false),
		);

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
		const liveboard = await this.withOrgTokenRetry(recorder, (svc) =>
			svc.fetchTMLAndCreateLiveboard(name, transformedAnswers, noteTile),
		);

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
		const dataSources = await this.withOrgTokenRetry(recorder, (svc) =>
			svc.getDataSourceSuggestions(query),
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

		// List the user's own orgs via the user-scoped v1 session/orgs endpoint
		// (NOT the admin orgs/search, which 403s for non-admins). It is authenticated
		// with the global/cluster-wide token and sends no org header, so it does not
		// go through withOrgTokenRetry — there is no org token in play to re-mint.
		const orgs = await this.getThoughtSpotServiceWithToken(
			this.getGlobalToken(),
			undefined,
			recorder,
		).listOrgs();
		span?.setAttribute("total_orgs", orgs.length);

		// Read the active org from the shared per-user store (the single source of
		// truth). Ensure it's loaded first — this request may run on a different DO
		// than the one that handled postInit/switch_org.
		await this.ensureActiveOrgLoaded();
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

		// Set the active org first (clears any prior org's token), then mint the new
		// org's token and persist it to the shared store. Minting also validates
		// access: no pre-validation against list_orgs — if the user can't access the
		// org, the mint returns 401, surfaced as "org not accessible".
		await this.setActiveOrg(orgId);
		try {
			await this.ensureOrgToken(orgId, recorder);
		} catch (error) {
			const message = (error as Error)?.message ?? "";
			if (message.includes("401")) {
				return this.createErrorResponse(
					`You do not have access to org "${orgId}", or it does not exist. Call list_orgs to see the orgs you can access.`,
					"Switch org failed: org not accessible (401)",
				);
			}
			return this.createErrorResponse(
				`Failed to switch to org "${orgId}". Please try again.`,
				`Error switching org ${message}`,
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

		const sources = await this.withOrgTokenRetry(recorder, (svc) =>
			svc.getDataSources(),
		);
		this._sources = {
			list: sources,
			map: new Map(sources.map((s) => [s.id, s])),
		};
		return this._sources;
	}
}
