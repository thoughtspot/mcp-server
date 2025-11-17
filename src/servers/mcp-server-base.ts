import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ToolSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    type ListToolsResult
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { context, type Span, SpanStatusCode } from "@opentelemetry/api";
import { getActiveSpan, withSpan } from "../metrics/tracing/tracing-utils";
import { Trackers, type Tracker, TrackEvent } from "../metrics";
import type { Props } from "../utils";
import { MixpanelTracker } from "../metrics/mixpanel/mixpanel";
import { getThoughtSpotClient } from "../thoughtspot/thoughtspot-client";
import { ThoughtSpotService } from "../thoughtspot/thoughtspot-service";

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
}

export abstract class BaseMCPServer extends Server {
    protected trackers: Trackers = new Trackers();
    protected sessionInfo: any;

    constructor(
        protected ctx: Context,
        serverName?: string,
        serverVersion?: string
    ) {
        super({
            name: serverName || "ThoughtSpot",
            version: serverVersion || "1.0.0",
        }, {
            capabilities: {
                tools: {},
                completion: {},
                resources: {},
            }
        });
    }

    /**
     * Check if data source discovery is available
     */
    protected isDatasourceDiscoveryAvailable(): boolean {
        const enableSpotterDataSourceDiscovery = this.sessionInfo?.enableSpotterDataSourceDiscovery;
        return !!enableSpotterDataSourceDiscovery;
    };

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
    protected createErrorResponse(message: string, statusMessage?: string): ErrorResponse {
        const span = this.initSpanWithCommonAttributes();
        span?.setStatus({ code: SpanStatusCode.ERROR, message: statusMessage || message });
        return {
            isError: true,
            content: [{ type: "text", text: `ERROR: ${message}` }],
        };
    }

    /**
     * Create a standardized success response with a single message
     */
    protected createSuccessResponse(message: string, statusMessage?: string): SuccessResponse {
        const span = this.initSpanWithCommonAttributes();
        span?.setStatus({ code: SpanStatusCode.OK, message: statusMessage || message });
        return {
            content: [{ type: "text", text: message }],
        };
    }

    /**
     * Create a standardized success response with multiple content items
     */
    protected createMultiContentSuccessResponse(content: ContentItem[], statusMessage: string): SuccessResponse {
        const span = this.initSpanWithCommonAttributes();
        span?.setStatus({ code: SpanStatusCode.OK, message: statusMessage });
        return {
            content,
        };
    }

    /**
     * Create a standardized success response with an array of text items
     */
    protected createArraySuccessResponse(texts: string[], statusMessage: string): SuccessResponse {
        const span = this.initSpanWithCommonAttributes();
        span?.setStatus({ code: SpanStatusCode.OK, message: statusMessage });
        return {
            content: texts.map(text => ({ type: "text", text })),
        };
    }

    protected createStructuredContentSuccessResponse<T>(structuredContent: T, statusMessage: string): SuccessResponse<T> {
        const span = this.initSpanWithCommonAttributes();
        span?.setStatus({ code: SpanStatusCode.OK, message: statusMessage });
        return {
            content: [{
                type: "text",
                text: JSON.stringify(structuredContent),
            }],
            structuredContent,
        };
    }

    protected getThoughtSpotService() {
        return new ThoughtSpotService(getThoughtSpotClient(this.ctx.props.instanceUrl, this.ctx.props.accessToken));
    }

    protected async initializeService(): Promise<void> {
        this.sessionInfo = await this.getThoughtSpotService().getSessionInfo();
        const mixpanel = new MixpanelTracker(
            this.sessionInfo,
            this.ctx.props.clientName
        );
        this.addTracker(mixpanel);
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
    protected abstract readResource(request: z.infer<typeof ReadResourceRequestSchema>): Promise<{ contents: any[] }>;

    /**
     * Abstract method to be implemented by subclasses for calling tools
     */
    protected abstract callTool(request: z.infer<typeof CallToolRequestSchema>): Promise<any>;

    async init() {
        // Initialize the service-specific functionality
        await this.initializeService();

        // Track initialization
        this.trackers.track(TrackEvent.Init);

        // Set up request handlers
        this.setRequestHandler(ListToolsRequestSchema, async () => {
            return withSpan('list-tools', async () => {
                this.initSpanWithCommonAttributes();
                return this.listTools();
            });
        });

        this.setRequestHandler(ListResourcesRequestSchema, async () => {
            return withSpan('list-resources', async () => {
                this.initSpanWithCommonAttributes();
                return this.listResources();
            });
        });

        this.setRequestHandler(ReadResourceRequestSchema, async (request: z.infer<typeof ReadResourceRequestSchema>) => {
            return withSpan('read-resource', async () => {
                this.initSpanWithCommonAttributes();
                return this.readResource(request);
            });
        });

        // Handle call tool request
        this.setRequestHandler(CallToolRequestSchema, async (request: z.infer<typeof CallToolRequestSchema>) => {
            return withSpan('call-tool', async () => {
                this.initSpanWithCommonAttributes();
                return this.callTool(request);
            });
        });
    }

    async addTracker(tracker: Tracker) {
        this.trackers.add(tracker);
    }
}
