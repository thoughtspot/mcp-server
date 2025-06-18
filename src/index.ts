import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import handler from "./handlers";
import type { Props } from "./utils";
import { MCPServer } from "./servers/mcp-server";
import { apiServer } from "./servers/api-server";
import { withBearerHandler } from "./bearer";
import { wrapModule } from "@cloudflare/workers-honeycomb-logger";
import { Tracer } from "./metrics/honeycomb/tracer";
import { setTracer } from "./metrics/honeycomb/shared-tracer";

export class ThoughtSpotMCP extends McpAgent<Env, any, Props> {
    server = new MCPServer(this);

    async init() {
        await this.server.init();
    }
}

const interfaceOauth = new OAuthProvider({
    apiHandlers: {
        "/mcp": ThoughtSpotMCP.serve("/mcp") as any, // TODO: Remove 'any'
        "/sse": ThoughtSpotMCP.serveSSE("/sse") as any, // TODO: Remove 'any'
        "/api": apiServer as any, // TODO: Remove 'any'
    },
    defaultHandler: withBearerHandler(handler, ThoughtSpotMCP) as any, // TODO: Remove 'any'
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
});

const honeycombLoggerConfig = {
    apiKey: process.env.HONEYCOMB_API_KEY, // can also be provided by setting env var HONEYCOMB_API_KEY
    dataset: process.env.HONEYCOMB_DATASET, // can also be provided by setting env var HONEYCOMB_DATASET
    sendTraceContext: true,
    acceptTraceContext: true,
  }

const worker = {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
        //console.log('request', request);
        if (request.tracer) {
            const tracer = new Tracer(request.tracer);
            setTracer(tracer);
        }
        return interfaceOauth.fetch(request, env, ctx);
    }
};

export default wrapModule(honeycombLoggerConfig, worker);
