import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	type ListToolsResult,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type Span, SpanStatusCode } from "@opentelemetry/api";
import type { z } from "zod";
import { TrackEvent, type Tracker, Trackers } from "../metrics";
import { MixpanelTracker } from "../metrics/mixpanel/mixpanel";
import type { ApiVersionMode } from "../metrics/runtime/metric-types";
import {
	type MetricsRecorder,
	scheduleMetricsFlush,
} from "../metrics/runtime/metrics-recorder";
import type {
	MetricAnalyticsContext,
	MetricEventIdentity,
} from "../metrics/runtime/metrics-sink";
import { createRequestMetricsRecorder } from "../metrics/runtime/request-metrics";
import {
	type ToolMetricApiSurface,
	getToolMetricOutcomeFromError,
	getToolMetricOutcomeFromResult,
	recordToolInvocationMetrics,
} from "../metrics/runtime/tool-metrics";
import { getActiveSpan, withSpan } from "../metrics/tracing/tracing-utils";
import { OrgStorageServiceClient } from "../storage-service/org-storage-service";
import { StorageServiceClient } from "../storage-service/storage-service";
import { OrgService } from "../thoughtspot/org-service";
import { getThoughtSpotClient } from "../thoughtspot/thoughtspot-client";
import { ThoughtSpotService } from "../thoughtspot/thoughtspot-service";
import type { SessionInfo } from "../thoughtspot/types";
import type { Props } from "../utils";

// Response utility types
export type ContentItem = {
	type: "text";
	text: string;
};

export type SuccessResponse<T = any> = {
	content: ContentItem[];
	structuredContent?: T;
};

export type ErrorResponse = {
	isError: true;
	content: ContentItem[];
};

export type ToolResponse = SuccessResponse | ErrorResponse;

export interface Context {
	props: Props;
	env: Env;
	ctx?: DurableObjectState;
}

export abstract class BaseMCPServer extends Server {
	protected trackers: Trackers = new Trackers();
	protected sessionInfo: SessionInfo | undefined;
	// In-flight ensureSessionInfo() refetch, so concurrent callers share one fetch.
	private sessionInfoPromise?: Promise<void>;

	constructor(
		protected ctx: Context,
		serverName?: string,
		serverVersion?: string,
	) {
		super(
			{
				name: serverName || "ThoughtSpot",
				version: serverVersion || "1.0.0",
			},
			{
				capabilities: {
					tools: {},
					completion: {},
					// listChanged: the resource set (datasources) changes on switch_org,
					// so we notify clients to re-list.
					resources: { listChanged: true },
				},
			},
		);
	}

	/**
	 * Whether Spotter data source discovery (Auto Mode) is enabled.
	 *
	 * Fails OPEN (returns true) when sessionInfo is unavailable. sessionInfo can
	 * be null if getSessionInfo failed at init (e.g. a transient cluster error, or
	 * historically a post-expiry reconnect where the fetch used the dead frozen
	 * props token — now fixed by the preInit token reorder). This flag only tunes
	 * how a tool runs (auto datasource discovery), not whether it may run, so
	 * defaulting it on during a brief session-info gap is the least-surprising,
	 * non-breaking choice. Contrast getActiveToken(), which fails CLOSED because a
	 * wrong answer there would send a dead token upstream.
	 */
	protected isSpotterDataSourceDiscoveryEnabled(): boolean {
		if (!this.sessionInfo) {
			console.warn(
				"Session info not available when checking data source discovery flag; defaulting ON (fail-open)",
			);
			return true;
		}
		return this.sessionInfo.isSpotterDataSourceDiscoveryEnabled === true;
	}

	/**
	 * Whether the Orgs feature is enabled on the cluster.
	 *
	 * Returns true when sessionInfo is unavailable, but this does NOT by itself
	 * expose org tools: the only caller, areOrgToolsAvailable(), also requires
	 * authMode === "oauth", a grant refresh token, and an API version that carries
	 * list_orgs. So a null-sessionInfo "true" here still can't surface org tools on
	 * a bearer/pre-org/old-version session — it just avoids hiding them for a
	 * fully-eligible session during a transient session-info gap (the same gap the
	 * preInit reorder + listTools ensureSessionInfo close).
	 */
	protected isOrgsEnabled(): boolean {
		if (!this.sessionInfo) {
			console.warn(
				"Session info not available when checking orgs flag; deferring to the other areOrgToolsAvailable() gates",
			);
			return true;
		}
		return this.sessionInfo.orgsEnabled === true;
	}

	/**
	 * On-demand repair of sessionInfo when it's still null.
	 *
	 * Background: getSessionInfo runs once at init. It authenticates with a token,
	 * and on a post-expiry reconnect the frozen props access token is dead — so
	 * the fetch failed and left sessionInfo null for the instance's lifetime,
	 * which mis-gated org-tool visibility ("org tools disappear after ~24h" even
	 * though the kept-warm DO token was still valid). preInit now loads the
	 * kept-warm token BEFORE that init fetch, so it normally succeeds. This method
	 * is the remaining fallback: if the init fetch still failed (e.g. a transient
	 * cluster error), refetch on demand when a caller reads session-info-gated
	 * state — by now the valid token is loaded, so the retry authenticates cleanly.
	 *
	 * No-op once populated. Concurrent callers share one in-flight fetch via
	 * sessionInfoPromise. Best-effort: a failure leaves sessionInfo null and the
	 * gates fall back to their documented defaults (org tools fail-closed via the
	 * areOrgToolsAvailable() gates; Spotter feature flags fail-open). Refetch is
	 * bounded by client (human-paced) request rate, so no back-off is needed.
	 */
	protected async ensureSessionInfo(): Promise<void> {
		if (this.sessionInfo) {
			return;
		}
		if (!this.sessionInfoPromise) {
			this.sessionInfoPromise = this.initializeService().finally(() => {
				this.sessionInfoPromise = undefined;
			});
		}
		await this.sessionInfoPromise;
	}

	/**
	 * Whether Spotter chat history (save chat) is enabled.
	 *
	 * Fails OPEN (returns true) when sessionInfo is unavailable, for the same
	 * reason as isSpotterDataSourceDiscoveryEnabled: it tunes tool behavior, not
	 * tool availability, so defaulting on during a transient session-info gap is
	 * non-breaking.
	 */
	protected isSpotterChatHistoryEnabled(): boolean {
		if (!this.sessionInfo) {
			console.warn(
				"Session info not available when checking chat history flag; defaulting ON (fail-open)",
			);
			return true;
		}
		return this.sessionInfo.isSpotterChatHistoryEnabled === true;
	}

	/**
	 * Initialize span with common attributes (user_guid and instance_url)
	 */
	protected initSpanWithCommonAttributes(): Span | undefined {
		const span = getActiveSpan();
		span?.setAttributes({
			user_guid: this.sessionInfo?.userGUID || "unknown",
			instance_url: this.ctx.props?.instanceUrl || "unknown",
		});
		return span;
	}

	/**
	 * Create a standardized error response
	 */
	protected createErrorResponse(
		message: string,
		statusMessage?: string,
	): ErrorResponse {
		const span = this.initSpanWithCommonAttributes();
		span?.setStatus({
			code: SpanStatusCode.ERROR,
			message: statusMessage || message,
		});
		return {
			isError: true,
			content: [{ type: "text", text: `ERROR: ${message}` }],
		};
	}

	/**
	 * Create a standardized success response with a single message
	 */
	protected createSuccessResponse(
		message: string,
		statusMessage?: string,
	): SuccessResponse {
		const span = this.initSpanWithCommonAttributes();
		span?.setStatus({
			code: SpanStatusCode.OK,
			message: statusMessage || message,
		});
		return {
			content: [{ type: "text", text: message }],
		};
	}

	/**
	 * Create a standardized success response with multiple content items
	 */
	protected createMultiContentSuccessResponse(
		content: ContentItem[],
		statusMessage: string,
	): SuccessResponse {
		const span = this.initSpanWithCommonAttributes();
		span?.setStatus({ code: SpanStatusCode.OK, message: statusMessage });
		return {
			content,
		};
	}

	/**
	 * Create a standardized success response with an array of text items
	 */
	protected createArraySuccessResponse(
		texts: string[],
		statusMessage: string,
	): SuccessResponse {
		const span = this.initSpanWithCommonAttributes();
		span?.setStatus({ code: SpanStatusCode.OK, message: statusMessage });
		return {
			content: texts.map((text) => ({ type: "text", text })),
		};
	}

	protected createStructuredContentSuccessResponse<T>(
		structuredContent: T,
		statusMessage: string,
	): SuccessResponse<T> {
		const span = this.initSpanWithCommonAttributes();
		span?.setStatus({ code: SpanStatusCode.OK, message: statusMessage });
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

	/**
	 * Stable per-login hash used to namespace this user's durable storage (both
	 * conversation buffers and active-org state), keeping users isolated.
	 *
	 * Keyed on the refresh token when present (OAuth): it is stable across the
	 * access token's 24h rotation and only changes on full reauthentication, so
	 * storage survives token refresh and resets on reauth. Falls back to the
	 * access token for static bearer/token connections, which have no refresh
	 * token (their token is long-lived).
	 */
	protected async getStorageKeyHash(): Promise<string> {
		const keyToken =
			this.ctx.props.globalRefreshToken ?? this.ctx.props.accessToken;
		if (!keyToken || keyToken.length === 0) {
			throw new Error("A token is required to derive the storage key");
		}
		const hashBuffer = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(keyToken),
		);
		return Buffer.from(new Uint8Array(hashBuffer)).toString("base64url");
	}

	protected async getStorageService(): Promise<StorageServiceClient> {
		const hashUrlSafe = await this.getStorageKeyHash();
		return new StorageServiceClient(
			this.ctx.env
				.CONVERSATION_STORAGE_OBJECT as unknown as DurableObjectNamespace,
			hashUrlSafe,
		);
	}

	protected async getOrgStorageService(): Promise<OrgStorageServiceClient> {
		const hashUrlSafe = await this.getStorageKeyHash();
		return new OrgStorageServiceClient(
			this.ctx.env.USER_TOKEN_OBJECT as unknown as DurableObjectNamespace,
			hashUrlSafe,
		);
	}

	protected abstract getActiveOrgId(): string | undefined;
	// The token to authenticate the current request: the org-scoped token when an
	// org is active, otherwise the global/cluster token.
	protected abstract getActiveToken(): string;

	// Build an OrgService bound to an explicit (cluster-wide) token for org listing
	// / org-token minting.
	protected getOrgService(
		bearerToken: string,
		orgId?: string,
		recorder?: MetricsRecorder,
	) {
		return new OrgService(
			getThoughtSpotClient(this.ctx.props.instanceUrl, bearerToken, orgId),
			recorder,
		);
	}

	protected getThoughtSpotService(
		recorder?: MetricsRecorder,
		analyticsContextOverride?: MetricAnalyticsContext,
	) {
		return new ThoughtSpotService(
			getThoughtSpotClient(
				this.ctx.props.instanceUrl,
				this.getActiveToken(),
				this.getActiveOrgId(),
			),
			{
				recorder,
				metricsEnv: this.ctx.env as unknown as Record<string, unknown>,
				waitUntil: this.getMetricsWaitUntil(),
				analyticsContext: this.mergeMetricAnalyticsContext(
					analyticsContextOverride,
				),
				eventIdentity: this.getMetricEventIdentity(),
			},
		);
	}

	protected abstract getToolMetricApiSurface(): ToolMetricApiSurface;

	protected getToolMetricApiVersionLabel(): string | undefined {
		return undefined;
	}

	protected getToolMetricApiVersionModeLabel(): ApiVersionMode | undefined {
		return undefined;
	}

	protected getToolMetricApiReleaseDateLabel(): string | undefined {
		return undefined;
	}

	protected getMetricAnalyticsContext(): MetricAnalyticsContext | undefined {
		const apiRequestedVersion = this.ctx.props.apiRequestedVersion;
		if (
			typeof apiRequestedVersion !== "string" ||
			apiRequestedVersion.length === 0
		) {
			return undefined;
		}

		return {
			apiRequestedVersion,
		};
	}

	protected mergeMetricAnalyticsContext(
		override?: MetricAnalyticsContext,
	): MetricAnalyticsContext | undefined {
		const baseContext = this.getMetricAnalyticsContext();
		if (!baseContext && !override) {
			return undefined;
		}

		return {
			...baseContext,
			...override,
		};
	}

	protected getMetricEventIdentity(): MetricEventIdentity | undefined {
		if (!this.sessionInfo) {
			return undefined;
		}

		const tenantId = this.sessionInfo.clusterId
			? String(this.sessionInfo.clusterId)
			: undefined;
		const userId = this.sessionInfo.userGUID
			? String(this.sessionInfo.userGUID)
			: undefined;
		if (!tenantId && !userId) {
			return undefined;
		}

		return {
			tenantId,
			userId,
		};
	}

	private getMetricsWaitUntil() {
		return this.ctx.ctx?.waitUntil?.bind(this.ctx.ctx);
	}

	private createToolMetricsRecorder(): MetricsRecorder {
		const recorder = createRequestMetricsRecorder(
			this.ctx.env as unknown as Record<string, unknown>,
		);
		recorder.setAnalyticsContext(this.getMetricAnalyticsContext());
		recorder.setEventIdentity(this.getMetricEventIdentity());
		return recorder;
	}

	private recordToolMetricsSafe(
		recorder: MetricsRecorder,
		toolName: string,
		outcome: ReturnType<typeof getToolMetricOutcomeFromError>,
		durationMs: number,
	): void {
		try {
			recordToolInvocationMetrics(
				recorder,
				toolName,
				this.getToolMetricApiSurface(),
				outcome,
				durationMs,
				this.getToolMetricApiVersionLabel(),
				this.getToolMetricApiVersionModeLabel(),
				this.getToolMetricApiReleaseDateLabel(),
			);
		} catch (error) {
			console.error(
				`[metrics] Failed to record tool metrics for ${toolName}`,
				error,
			);
		}
	}

	private async withToolMetrics<T>(
		request: z.infer<typeof CallToolRequestSchema>,
		handler: (recorder: MetricsRecorder) => Promise<T>,
	): Promise<T> {
		const recorder = this.createToolMetricsRecorder();
		const startedAt = Date.now();
		let outcome: ReturnType<typeof getToolMetricOutcomeFromError> | undefined;

		try {
			const result = await handler(recorder);
			outcome = getToolMetricOutcomeFromResult(result);
			return result;
		} catch (error) {
			outcome = getToolMetricOutcomeFromError(error);
			throw error;
		} finally {
			if (outcome) {
				this.recordToolMetricsSafe(
					recorder,
					request.params.name,
					outcome,
					Date.now() - startedAt,
				);
			}
			scheduleMetricsFlush(recorder, this.getMetricsWaitUntil());
		}
	}

	protected async initializeService(): Promise<void> {
		try {
			this.sessionInfo = await this.getThoughtSpotService().getSessionInfo();
			const mixpanel = new MixpanelTracker(
				this.sessionInfo,
				this.ctx.props.clientName,
			);
			this.addTracker(mixpanel);
		} catch (error) {
			// getSessionInfo failed, so sessionInfo stays null. Downstream this hides
			// org tools (areOrgToolsAvailable gates fail-closed) and defaults the
			// Spotter feature flags on (fail-open). ensureSessionInfo() repairs this
			// on the next session-info-gated call once a valid token is loaded.
			console.error(
				"Error initializing session info (org tools will be hidden until ensureSessionInfo repairs it):",
				error,
			);
		}
	}

	/**
	 * Abstract method to be implemented by subclasses for listing tools
	 */
	protected abstract listTools(): Promise<ListToolsResult>;

	/**
	 * Abstract method to be implemented by subclasses for listing resources
	 */
	protected abstract listResources(): Promise<{ resources: any[] }>;

	/**
	 * Abstract method to be implemented by subclasses for reading resources
	 */
	protected abstract readResource(
		request: z.infer<typeof ReadResourceRequestSchema>,
	): Promise<{ contents: any[] }>;

	/**
	 * Abstract method to be implemented by subclasses for calling tools
	 */
	protected abstract callTool(
		request: z.infer<typeof CallToolRequestSchema>,
		recorder: MetricsRecorder,
	): Promise<any>;

	async init() {
		// preInit runs BEFORE initializeService()/getSessionInfo so a subclass can
		// load the token that getSessionInfo authenticates with. Ordering matters:
		// props.accessToken is frozen at login and dies after ~24h, so on a
		// reconnect past that, an init-time getSessionInfo using it would fail and
		// leave sessionInfo null for the instance lifetime (the "org tools vanish
		// after 24h" bug). preInit reconciles the still-valid kept-warm DO token
		// first, so the fetch below authenticates with a live token. Best-effort.
		try {
			await this.preInit();
		} catch (error) {
			console.error("preInit failed:", error);
		}

		// Initialize the service-specific functionality
		await this.initializeService();

		// Track initialization
		this.trackers.track(TrackEvent.Init);

		// Set up request handlers
		this.setRequestHandler(ListToolsRequestSchema, async () => {
			return withSpan("list-tools", async () => {
				this.initSpanWithCommonAttributes();
				return this.listTools();
			});
		});

		this.setRequestHandler(ListResourcesRequestSchema, async () => {
			return withSpan("list-resources", async () => {
				this.initSpanWithCommonAttributes();
				return this.listResources();
			});
		});

		this.setRequestHandler(
			ReadResourceRequestSchema,
			async (request: z.infer<typeof ReadResourceRequestSchema>) => {
				return withSpan("read-resource", async () => {
					this.initSpanWithCommonAttributes();
					return this.readResource(request);
				});
			},
		);

		// Handle call tool request
		this.setRequestHandler(
			CallToolRequestSchema,
			async (request: z.infer<typeof CallToolRequestSchema>) => {
				return withSpan("call-tool", async () => {
					this.initSpanWithCommonAttributes();
					return this.withToolMetrics(request, (recorder) =>
						this.callTool(request, recorder),
					);
				});
			},
		);

		// Subclass post-initialization hook (runs after sessionInfo is available
		// and handlers are registered). Best-effort: failures must not break the
		// connection.
		try {
			await this.postInit();
		} catch (error) {
			console.error("postInit failed:", error);
		}
	}

	/**
	 * Optional hook for subclasses to run setup BEFORE initializeService()
	 * (i.e. before getSessionInfo). Default no-op.
	 */
	protected async preInit(): Promise<void> {}

	/**
	 * Optional hook for subclasses to run setup after init(). Default no-op.
	 */
	protected async postInit(): Promise<void> {}

	async addTracker(tracker: Tracker) {
		this.trackers.add(tracker);
	}
}
