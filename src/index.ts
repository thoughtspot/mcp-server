import { trace } from '@opentelemetry/api';
import { instrument, type ResolveConfigFn, instrumentDO } from '@microlabs/otel-cf-workers';
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import handler from "./handlers";
import { type Props, instrumentedMCPServer } from "./utils";
import { MCPServer } from "./servers/mcp-server";
import { apiServer } from "./servers/api-server";
import { withBearerHandler } from "./bearer";
import { OpenAIDeepResearchMCPServer } from './servers/openai-mcp-server';
import { type AgentExecutor, JsonRpcTransportHandler } from '@a2a-js/sdk/server';
import { DefaultRequestHandler, InMemoryTaskStore, type TaskStore } from '@a2a-js/sdk/server';
import { thoughtSpotAgentCard } from './a2a/agent-card';
import { MyAgentExecutor } from './a2a/agent-executor';
import type { JSONRPCSuccessResponse } from '@a2a-js/sdk';

// Create request handlers for both basic and extended cards

async function handleA2ARequest(req: Request, env: Env, ctx: ExecutionContext) {

    const taskStore: TaskStore = new InMemoryTaskStore();
const agentExecutor: AgentExecutor = new MyAgentExecutor();
(agentExecutor as MyAgentExecutor).setThoughtSpotContext(ctx.props as Props);
const basicRequestHandler = new DefaultRequestHandler(
    thoughtSpotAgentCard,
    taskStore,
    agentExecutor
  );
    const jsonHandler = new JsonRpcTransportHandler(basicRequestHandler);
    const requestBody = await req.json();
    //console.log("ctx", ctx);
    try {
        const rpcResponseOrStream = await jsonHandler.handle(requestBody);
        //console.log(rpcResponseOrStream);

        // Check if it's an AsyncGenerator (stream)
        if (typeof (rpcResponseOrStream as any)?.[Symbol.asyncIterator] === 'function') {
            const stream = new ReadableStream({
                async start(controller) {
                  try {
                    for await (const event of rpcResponseOrStream as AsyncGenerator<JSONRPCSuccessResponse, void, undefined>) {
                      const sseData = `id: ${new Date().getTime()}\ndata: ${JSON.stringify(event)}\n\n`;
                      controller.enqueue(new TextEncoder().encode(sseData));
                    }
                    controller.close();
                  } catch (error) {
                    // Handle errors by enqueueing error event and closing
                    const errorEvent = `id: ${new Date().getTime()}\nevent: error\ndata: ${JSON.stringify(error)}\n\n`;
                    controller.enqueue(new TextEncoder().encode(errorEvent));
                    controller.close();
                  }
                }
              });
              
              return new Response(stream, {
                headers: {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                  'Transfer-Encoding': 'chunked'
                }
              });
            }
    } catch (error) {
        console.error('Error in A2A handler:', error);
        return new Response('Internal Server Error', { status: 500 });
    }
}

const a2aHandler = {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // console.log('A2A handler');
        // console.log(request);
        // console.log(request.headers);
        return await handleA2ARequest(request, env, ctx) as Response;
    }
}

// Wrapper to make requestHandler compatible with OAuth provider
// const a2aHandler = {
//   async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
//     try {
//       // ALTERNATIVE: Full Agent Card Protection
//       // Uncomment the lines below to require authentication for ALL requests including agent card
//       // const props = (ctx as any).props as Props;
//       // if (!props?.accessToken || !props?.instanceUrl) {
//       //   return new Response('Unauthorized: Authentication required for agent card access', { status: 401 });
//       // }
      
//       // Handle GET requests (agent card discovery)
//       if (request.method === 'GET') {
//         // Check if user is authenticated
//         const props = (ctx as any).props as Props;
        
//         if (props?.accessToken && props?.instanceUrl) {
//           console.log('[A2A] Serving authenticated extended agent card');
//           return await (extendedRequestHandler as any).fetch(request, env, ctx);
//         } else {
//           console.log('[A2A] Serving public basic agent card');
//           return await (basicRequestHandler as any).fetch(request, env, ctx);
//         }
//       }

//       // For all other requests (POST for execution), require OAuth authentication
//       const props = (ctx as any).props as Props;
      
//       if (!props?.accessToken || !props?.instanceUrl) {
//         return new Response('Unauthorized: Missing ThoughtSpot credentials', { status: 401 });
//       }
      
//       // Pass ThoughtSpot context to the agent executor
//       (agentExecutor as MyAgentExecutor).setThoughtSpotContext(props);
      
//       // Pass OAuth context to the A2A handler by enhancing the context
//       const enhancedCtx = {
//         ...ctx,
//         thoughtSpotProps: props
//       };
      
//       console.log('[A2A] Serving authenticated request with ThoughtSpot context');
//       // Use extended handler for authenticated execution
//       return await (extendedRequestHandler as any).fetch(request, env, enhancedCtx);
//     } catch (error) {
//       console.error('Error in A2A handler:', error);
//       return new Response('Internal Server Error', { status: 500 });
//     }
//   }
// };

// OTEL configuration function
const config: ResolveConfigFn = (env: Env, _trigger) => {
    return {
        exporter: {
            url: 'https://api.honeycomb.io/v1/traces',
            headers: { 'x-honeycomb-team': process.env.HONEYCOMB_API_KEY },
        },
        service: { name: process.env.HONEYCOMB_DATASET }
    };
};

// Create the instrumented ThoughtSpotMCP for the main export
export const ThoughtSpotMCP = instrumentedMCPServer(MCPServer, config);

export const ThoughtSpotOpenAIDeepResearchMCP = instrumentedMCPServer(OpenAIDeepResearchMCPServer, config);

// Create the OAuth provider instance
const oauthProvider = new OAuthProvider({
    apiHandlers: {
        "/mcp": ThoughtSpotMCP.serve("/mcp") as any, // TODO: Remove 'any'
        "/sse": ThoughtSpotMCP.serveSSE("/sse") as any, // TODO: Remove 'any'
        '/openai/mcp': ThoughtSpotOpenAIDeepResearchMCP.serve("/openai/mcp", {
            binding: "OPENAI_DEEP_RESEARCH_MCP_OBJECT"
        }) as any, // TODO: Remove 'any'
        '/openai/sse': ThoughtSpotOpenAIDeepResearchMCP.serveSSE("/openai/sse", {
            binding: "OPENAI_DEEP_RESEARCH_MCP_OBJECT"
        }) as any, // TODO: Remove 'any'
        "/a2a": a2aHandler as any, // TODO: Remove 'any'
        "/api": apiServer as any, // TODO: Remove 'any'
    },
    defaultHandler: withBearerHandler(handler, ThoughtSpotMCP) as any, // TODO: Remove 'any'
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",

});

// Wrap the OAuth provider with a handler that includes tracing
const oauthHandler = {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // Add OpenTelemetry tracing attributes
        const span = trace.getActiveSpan();
        if (span) {
            span.setAttributes({
                component: 'OAuthProvider',
                instance_url: (ctx as any).props?.instanceUrl || 'unknown',
                request_url: request.url,
                request_method: request.method,
            });
        }


        if (request.url.includes("/a2a")) {
            console.log('A2A handler');
            console.log(request.headers);
            const response = await oauthProvider.fetch(request, env, ctx);
            response.headers.set('Content-Type', 'text/event-stream');
            response.headers.set('Cache-Control', 'no-cache');
            response.headers.set('Connection', 'keep-alive');
            response.headers.set('Transfer-Encoding', 'chunked');
            return response;
        }

        return oauthProvider.fetch(request, env, ctx);
    }
};


// Export the instrumented handler
export default instrument(oauthHandler, config);

