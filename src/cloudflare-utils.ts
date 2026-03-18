import { McpAgent } from "agents/mcp";
import { instrumentDO, type ResolveConfigFn } from '@microlabs/otel-cf-workers';
import type { BaseMCPServer, Context } from "./servers/mcp-server-base";
import type { Props } from "./utils";
import { StreamingConversationState } from "./servers/mcp-server";

export function instrumentedMCPServer<T extends BaseMCPServer>(MCPServer: new (
    ctx: Context,
    getConversationState: (
        conversationId: string,
    ) => Promise<StreamingConversationState | undefined>,
    updateConversationStateAndResetTtlTimeout: (
        conversationId: string,
        newState: StreamingConversationState,
    ) => Promise<void>,
) => T, config: ResolveConfigFn) {
    const Agent = class extends McpAgent<Env, any, Props> {
        server = new MCPServer(
            this as Context,
            this.getConversationState.bind(this),
            this.updateConversationStateAndResetTtlTimeout.bind(this),
        );

        // Argument of type 'typeof ThoughtSpotMCPWrapper' is not assignable to parameter of type 'DOClass'.
        // Cannot assign a 'protected' constructor type to a 'public' constructor type.
        // Created to satisfy the DOClass type.
        // biome-ignore lint/complexity/noUselessConstructor: required for DOClass
        public constructor(state: DurableObjectState, env: Env) {
            super(state, env);
        }

        async init() {
            await this.server.init();
            this.ctx.storage
        }

        public static serve(path: string) {
            const server = McpAgent.serve(path, {
                corsOptions: {
                    headers: "Content-Type, Accept, mcp-session-id, mcp-protocol-version, Authorization, x-ts-host"
                }
            });
            const serverFetch = server.fetch;
            server.fetch = async (request: Request, env: any, ctx: ExecutionContext) => {
                // Due to https://community.openai.com/t/the-responses-api-terminates-a-session-too-early/1312539/16
                // We need to ignore DELETE requests from OpenAI MCP clients. As the DELETE makes the session terminate too early.
                if (request.method === "DELETE" && request.headers.get("user-agent")?.includes("openai-mcp")) {
                    return new Response(null, { status: 403 });
                }
                return serverFetch(request, env, ctx);
            }
            return server;
        }

        private async getConversationState(conversationId: string) {
            return await this.ctx.storage?.get<StreamingConversationState>(conversationId);
        }

        private async updateConversationStateAndResetTtlTimeout(
            conversationId: string,
            newState: StreamingConversationState,
        ) {
            const oldState = await this.getConversationState(conversationId);
            if (oldState?.ttlTimeoutId) {
                await this.cancelSchedule(oldState.ttlTimeoutId);
            }

            const schedule = await this.schedule(30, 'clearConversationState' as any, {
                conversationId,
            });

            await this.ctx.storage?.put(conversationId, {
                ...newState,
                ttlTimeoutId: schedule.id,
            });
        }

        private async clearConversationState(payload: { conversationId: string }) {
            console.log('>>> clearing conversation state', payload.conversationId);
            await this.ctx.storage?.delete(payload.conversationId);
        }
    }

    return instrumentDO(Agent, config) as unknown as typeof Agent;
}
