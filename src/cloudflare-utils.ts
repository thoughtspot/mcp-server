import { McpAgent } from "agents/mcp";
import { instrumentDO, type ResolveConfigFn } from "@microlabs/otel-cf-workers";
import type { BaseMCPServer, Context } from "./servers/mcp-server-base";
import type { Props } from "./utils";
import { StreamingMessagesStorageWithTtl } from "./streaming-message-storage-with-ttl/streaming-message-storage-with-ttl";

export function instrumentedMCPServer<T extends BaseMCPServer>(
	MCPServer: new (
		ctx: Context,
		streamingMessageStorage: StreamingMessagesStorageWithTtl,
	) => T,
	config: ResolveConfigFn,
) {
	const Agent = class extends McpAgent<Env, any, Props> {
		streamingMessageStorage = new StreamingMessagesStorageWithTtl(
			// TODO(Rifdhan) optional chaining is needed to fix test failures, need to investigate
			this.ctx?.storage,
			this.scheduleTimer.bind(this),
			this.cancelTimer.bind(this),
		);
		server = new MCPServer(this as Context, this.streamingMessageStorage);

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

		public static serve(path: string) {
			const server = McpAgent.serve(path, {
				corsOptions: {
					headers:
						"Content-Type, Accept, mcp-session-id, mcp-protocol-version, Authorization, x-ts-host",
				},
			});
			const serverFetch = server.fetch;
			server.fetch = async (
				request: Request,
				env: any,
				ctx: ExecutionContext,
			) => {
				// Due to https://community.openai.com/t/the-responses-api-terminates-a-session-too-early/1312539/16
				// We need to ignore DELETE requests from OpenAI MCP clients. As the DELETE makes the session terminate too early.
				if (
					request.method === "DELETE" &&
					request.headers.get("user-agent")?.includes("openai-mcp")
				) {
					return new Response(null, { status: 403 });
				}
				return serverFetch(request, env, ctx);
			};
			return server;
		}

		private async scheduleTimer(
			delaySeconds: number,
			conversationId: string,
		): Promise<string> {
			const schedule = await this.schedule(
				delaySeconds,
				"onTimerTriggered" as keyof this,
				conversationId,
			);
			return schedule.id;
		}

		private async cancelTimer(timerId: string): Promise<void> {
			await this.cancelSchedule(timerId);
		}

		/*
		 * This will be called by the scheduler when a timer gets triggered
		 */
		private async onTimerTriggered(conversationId: string): Promise<void> {
			await this.streamingMessageStorage.onTimerTriggered(conversationId);
		}
	};

	return instrumentDO(Agent, config) as unknown as typeof Agent;
}
