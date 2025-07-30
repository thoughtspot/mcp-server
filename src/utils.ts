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
    hostName: string;
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
        private _server: T | undefined;
        private _env: Env;

        // Lazy getter for server that creates it when first accessed
        // 
        // WHY THIS APPROACH:
        // Originally we passed 'this' directly as Context: `server = new MCPServer(this)`
        // This worked when Context was just { props: Props }, but broke when we added env.
        // 
        // PROBLEMS WITH ORIGINAL APPROACH:
        // 1. McpAgent's 'env' property is protected, but Context expects public
        // 2. TypeScript error: "Property 'env' is protected but public in Context"
        // 
        // WHY NOT CONSTRUCTOR CREATION:
        // We tried creating server in constructor: `new MCPServer({ props: this.props, env })`
        // But this.props is undefined during constructor - it gets set later by McpAgent._init()
        // Runtime error: "Cannot read properties of undefined (reading 'instanceUrl')"
        // 
        // SOLUTION - LAZY INITIALIZATION:
        // - Store env from constructor (available immediately)
        // - Create server only when first accessed (after props are set by McpAgent lifecycle)
        // - Combine both props and env into proper Context object
        get server(): T {
            if (!this._server) {
                const context: Context = {
                    props: this.props, // Available after McpAgent._init() sets it
                    env: this._env     // Stored from constructor
                };
                this._server = new MCPServer(context);
            }
            return this._server;
        }

        // Argument of type 'typeof ThoughtSpotMCPWrapper' is not assignable to parameter of type 'DOClass'.
        // Cannot assign a 'protected' constructor type to a 'public' constructor type.
        // Created to satisfy the DOClass type.
        // biome-ignore lint/complexity/noUselessConstructor: required for DOClass
        public constructor(state: DurableObjectState, env: Env) {
            super(state, env);
            // Store env for later use - props aren't available yet in constructor
            // McpAgent lifecycle: constructor → _init(props) → init()
            this._env = env;
        }

        async init() {
            // Access the server property to trigger lazy initialization
            // At this point, props have been set by McpAgent._init()
            await this.server.init();
        }
    }

    return instrumentDO(Agent, config);
}

export async function putInKV(key: string, value: any, env: Env) {
    if (env?.OAUTH_KV) {
        await env.OAUTH_KV.put(key, JSON.stringify(value), {
            expirationTtl: 60 * 60 * 3 // 3 hours
        });
    }
}

export async function getFromKV(key: string, env: Env) {
    console.log("[DEBUG] Getting from KV", key);
    if (env?.OAUTH_KV) {
        const value = await env.OAUTH_KV.get(key, { type: "json" });
        if (value) {
            return value;
        }
        return null;
    }
}