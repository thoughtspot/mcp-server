import { McpAgent } from "agents/mcp";
import { instrumentDO, type ResolveConfigFn } from '@microlabs/otel-cf-workers';
import { BaseMCPServer, Context } from "./servers/mcp-server-base";
import { Props } from "./utils";

export function instrumentedMCPServer<T extends BaseMCPServer>(MCPServer: new (ctx: Context) => T, config: ResolveConfigFn) {
    const Agent = class extends McpAgent<Env, any, Props> {
        server = new MCPServer(this as Context);

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

    return instrumentDO(Agent, config) as unknown as typeof Agent;
}
