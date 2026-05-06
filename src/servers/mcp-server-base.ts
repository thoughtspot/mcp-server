import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	type ListToolsResult,
	ReadResourceRequestSchema,
	ToolSchema,
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
import type { MetricEventIdentity } from "../metrics/runtime/metrics-sink";
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

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

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

	protected getStorageService(): StorageServiceClient {
		return new StorageServiceClient(
			this.ctx.env
				.CONVERSATION_STORAGE_OBJECT as unknown as DurableObjectNamespace,
		);
	}

	protected getThoughtSpotService(recorder?: MetricsRecorder) {
		return new ThoughtSpotService(
			getThoughtSpotClient(
				this.ctx.props.instanceUrl,
				this.ctx.props.accessToken,
			),
			{
				recorder,
				metricsEnv: this.ctx.env as unknown as Record<string, unknown>,
				waitUntil: this.getMetricsWaitUntil(),
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

	protected getMetricEventIdentity(): MetricEventIdentity | undefined {
		if (!this.sessionInfo) {
			return undefined;
		}

		const tenantId = this.sessionInfo.currentOrgId
			? String(this.sessionInfo.currentOrgId)
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
	}

	async addTracker(tracker: Tracker) {
		this.trackers.add(tracker);
	}
}
