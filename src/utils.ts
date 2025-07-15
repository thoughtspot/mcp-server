import { type Span, SpanStatusCode } from '@opentelemetry/api';
import { getActiveSpan } from './metrics/tracing/tracing-utils';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpAgent } from 'agents/mcp';
import type { BaseMCPServer, Context } from './servers/mcp-server-base';
import { instrumentDO, type ResolveConfigFn } from '@microlabs/otel-cf-workers';

export type Props = {
    accessToken: string;
    instanceUrl: string;
    clientName: {
        clientId: string;
        clientName: string;
        registrationDate: number;
    };
};

export class McpServerError extends Error {
    public readonly span?: Span;
    public readonly errorJson: any;
    public readonly statusCode: number;

    constructor(errorJson: any, statusCode: number) {
        // Extract message from error JSON or use a default message
        const message = typeof errorJson === 'string'
            ? errorJson
            : errorJson?.message || errorJson?.error || 'Unknown error occurred';

        super(message);

        this.name = 'McpServerError';
        this.span = getActiveSpan();
        this.errorJson = errorJson;
        this.statusCode = statusCode;

        // Set span status if span is provided
        if (this.span) {
            this.span.setStatus({
                code: SpanStatusCode.ERROR,
                message: this.message
            });

            // Record the exception in the span
            this.span.recordException(this);

            // Add error details as span attributes
            if (typeof errorJson === 'object' && errorJson !== null) {
                // Add relevant error details to span attributes
                if (errorJson.code) {
                    this.span.setAttribute('error.code', errorJson.code);
                }
                if (errorJson.type) {
                    this.span.setAttribute('error.type', errorJson.type);
                }
                if (errorJson.details) {
                    this.span.setAttribute('error.details', JSON.stringify(errorJson.details));
                }
            }

            this.span.setAttribute('error.status_code', this.statusCode);
        }

        console.error('Error:', this.message);

        // Ensure proper prototype chain for instanceof checks
        Object.setPrototypeOf(this, McpServerError.prototype);
    }

    /**
     * Convert the error to a JSON representation
     */
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            statusCode: this.statusCode,
            errorJson: this.errorJson,
            stack: this.stack
        };
    }

    /**
     * Get a user-friendly error message
     */
    getUserMessage(): string {
        if (typeof this.errorJson === 'object' && this.errorJson?.userMessage) {
            return this.errorJson.userMessage;
        }
        return this.message;
    }
}

export function instrumentedMCPServer<T extends BaseMCPServer>(MCPServer: new (ctx: Context) => T, config: ResolveConfigFn) {
    const Agent = class extends McpAgent<Env, any, Props> {
        server = new MCPServer(this);

        // Argument of type 'typeof ThoughtSpotMCPWrapper' is not assignable to parameter of type 'DOClass'.
        // Cannot assign a 'protected' constructor type to a 'public' constructor type.
        // Created to satisfy the DOClass type.
        // biome-ignore lint/complexity/noUselessConstructor: required for DOClass
        public constructor(state: DurableObjectState, env: Env) {
            super(state, env);
        }

        async init() {
            await this.server.init();
        }
    }

    return instrumentDO(Agent, config);
}