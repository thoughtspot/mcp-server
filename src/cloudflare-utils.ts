import { type ResolveConfigFn, instrumentDO } from "@microlabs/otel-cf-workers";
import { McpAgent } from "agents/mcp";
import { checkMcpInstanceAllowed } from "./instance-allowlist";
import type { BaseMCPServer, Context } from "./servers/mcp-server-base";
import type { Props } from "./utils";

const MCP_SERVE_OPTIONS = {
	corsOptions: {
		headers:
			"Content-Type, Accept, mcp-session-id, mcp-protocol-version, Authorization, x-ts-host",
	},
};

type McpServeHandler = {
	fetch: (
		request: Request,
		env: any,
		ctx: ExecutionContext,
	) => Promise<Response>;
};

function isInstanceBlocked(env: any, instanceUrl: string | undefined): boolean {
	// Block access to instances based on blocklist from environment variables.
	// The env var keeps its original CLUSTER_URL_BLOCKLIST name so existing
	// deployments stay configured.
	if (!env?.CLUSTER_URL_BLOCKLIST) {
		return false;
	}
	try {
		// Trim and drop empty entries: a trailing comma would otherwise yield ""
		// and `includes("")` is true for every instance, blocking all requests.
		const blocklist: string[] = env.CLUSTER_URL_BLOCKLIST.split(",")
			.map((item: string) => item.trim())
			.filter(Boolean);
		if (
			blocklist.length > 0 &&
			blocklist.some((blocked) => instanceUrl?.includes(blocked))
		) {
			console.error(
				"Rejecting request from instance",
				instanceUrl,
				"due to presence in blocklist",
			);
			return true;
		}
	} catch (error) {
		console.error("Error using instance URL blocklist", error);
	}
	return false;
}

function guardMcpServer<T extends McpServeHandler>(server: T): T {
	const serverFetch = server.fetch;
	server.fetch = async (request: Request, env: any, ctx: ExecutionContext) => {
		const instanceUrl = (ctx.props as any)?.instanceUrl as string | undefined;
		if (isInstanceBlocked(env, instanceUrl)) {
			return new Response(
				"This instance is not permitted to connect to MCP Server. Please contact your administrator to enable access.",
				{ status: 403 },
			);
		}

		const allowlistRejection = checkMcpInstanceAllowed(
			request,
			env,
			instanceUrl,
		);
		if (allowlistRejection) {
			return allowlistRejection;
		}

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

export function instrumentedMCPServer<T extends BaseMCPServer>(
	MCPServer: new (ctx: Context) => T,
	config: ResolveConfigFn,
) {
	const Agent = class extends McpAgent<Env, any, Props> {
		server = new MCPServer(this as unknown as Context);

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
			return guardMcpServer(McpAgent.serve(path, MCP_SERVE_OPTIONS));
		}

		// McpAgent.serveSSE calls McpAgent.serve directly, bypassing the override
		// above, so SSE needs its own guarded wrapper.
		public static serveSSE(path: string) {
			return guardMcpServer(McpAgent.serveSSE(path, MCP_SERVE_OPTIONS));
		}
	};

	return instrumentDO(Agent, config) as unknown as typeof Agent;
}
