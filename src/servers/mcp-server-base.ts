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
import { StorageServiceClient } from "../storage-service/storage-service";
import { getThoughtSpotClient } from "../thoughtspot/thoughtspot-client";
import { ThoughtSpotService } from "../thoughtspot/thoughtspot-service";
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
	protected sessionInfo: any;

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
					resources: {},
				},
			},
		);
	}

	/**
	 * Check if data source discovery is available
	 */
	protected isDatasourceDiscoveryAvailable(): boolean {
		if (!this.sessionInfo) {
			console.warn(
				"[DEBUG] sessionInfo is not initialized when checking datasource discovery availability",
			);
			return false;
		}
		return String(this.sessionInfo.enableSpotterDataSourceDiscovery) === "true";
	}

	/**
	 * Whether Orgs are enabled on this cluster (from session info). Fails closed:
	 * if session info is unavailable or the flag is absent, returns false so the
	 * org tools stay hidden.
	 */
	protected isOrgsEnabled(): boolean {
		if (!this.sessionInfo) {
			return false;
		}
		return this.sessionInfo.orgsEnabled === true;
	}

	/**
	 * Initialize span with common attributes (user_guid and instance_url)
	 */
	protected initSpanWithCommonAttributes(): Span | undefined {
		const span = getActiveSpan();
		if (this.sessionInfo?.userGUID) {
			span?.setAttributes({
				user_guid: this.sessionInfo.userGUID,
				instance_url: this.ctx.props.instanceUrl,
			});
		}
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
		const keyToken = this.ctx.props.refreshToken ?? this.ctx.props.accessToken;
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
			this.ctx.env.USER_TOKEN_OBJECT as unknown as DurableObjectNamespace,
		);
	}

	/**
	 * The org currently active for this session, if any. When set, all
	 * ThoughtSpot calls are scoped to this org via the x-thoughtspot-orgs header.
	 * Subclasses override this to expose their per-session org state. Defaults to
	 * undefined (the user's default org, as resolved by the cluster).
	 */
	protected getActiveOrgId(): string | undefined {
		return undefined;
	}

	/**
	 * The bearer token to use for ThoughtSpot calls. Defaults to the token from
	 * the session. Subclasses override this to return an org-scoped bearer token
	 * when an org has been selected.
	 */
	protected getActiveBearerToken(): string {
		return this.ctx.props.accessToken;
	}

	/**
	 * Build a ThoughtSpot service bound to an explicit bearer token and org,
	 * bypassing the active-org/token resolution. Used for org-token minting,
	 * which must authenticate with a specific token.
	 */
	protected getThoughtSpotServiceWithToken(
		bearerToken: string,
		orgId?: string,
		recorder?: MetricsRecorder,
		analyticsContextOverride?: MetricAnalyticsContext,
	) {
		return new ThoughtSpotService(
			getThoughtSpotClient(this.ctx.props.instanceUrl, bearerToken, orgId),
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

	protected getThoughtSpotService(
		recorder?: MetricsRecorder,
		analyticsContextOverride?: MetricAnalyticsContext,
	) {
		return new ThoughtSpotService(
			getThoughtSpotClient(
				this.ctx.props.instanceUrl,
				this.getActiveBearerToken(),
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
			console.error("Error initializing session info:", error);
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
	 * Optional hook for subclasses to run setup after init(). Default no-op.
	 */
	protected async postInit(): Promise<void> {}

	async addTracker(tracker: Tracker) {
		this.trackers.add(tracker);
	}
}
