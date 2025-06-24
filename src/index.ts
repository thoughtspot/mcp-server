import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import handler from "./handlers";
import type { Props } from "./utils";
import { MCPServer } from "./servers/mcp-server";
import { apiServer } from "./servers/api-server";
import { withBearerHandler } from "./bearer";
import { InstrumentedOAuthProviderDO, ThoughtSpotMCP } from "./durable-objects/otel-oauth-provider";
import { trace } from "@opentelemetry/api";

// export class ThoughtSpotMCP extends McpAgent<Env, any, Props> {
//     server = new MCPServer(this);

//     async init() {
//         await this.server.init();
//     }
// }

// Export the instrumented durable objects for Wrangler
export { InstrumentedOAuthProviderDO, ThoughtSpotMCP };

// Create a simple handler that delegates to the durable object
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // Get or create the durable object instance
        const id = env.OAUTH_PROVIDER_DO.idFromName('oauth-provider');
        const obj = env.OAUTH_PROVIDER_DO.get(id);
        return obj.fetch(request);
    }
};
