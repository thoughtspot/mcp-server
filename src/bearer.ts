import type { ThoughtSpotMCP } from '.';
import type honoApp from './handlers';
import { validateAndSanitizeUrl } from './oauth-manager/oauth-utils';
import { WithSpan } from './metrics/tracing/tracing-utils';

class BearerHandler {
    constructor(
        private app: typeof honoApp,
        private MCPServer: typeof ThoughtSpotMCP
    ) {}

    @WithSpan('bearer-token-validation')
    private async validateBearerToken(req: Request): Promise<{
        accessToken: string;
        instanceUrl: string;
        clientName: string;
    }> {
        const authHeader = req.headers.get("authorization");
        if (!authHeader) {
            console.log("Bearer handler: No auth header found");
            throw new Error("Bearer token is required");
        }

        let accessToken = authHeader.split(" ")[1];
        let tsHost: string | null;

        if (accessToken.includes('@')) {
            [accessToken, tsHost] = accessToken.split("@");
        } else {
            tsHost = req.headers.get("x-ts-host");
        }

        if (!tsHost) {
            throw new Error("TS Host is required, either in the authorization header as 'token@ts-host' or as a separate 'x-ts-host' header");
        }

        const clientName = req.headers.get("x-ts-client-name") || "Bearer Token client";
        const instanceUrl = validateAndSanitizeUrl(tsHost);

        return {
            accessToken,
            instanceUrl,
            clientName
        };
    }

    @WithSpan('bearer-route-handler')
    private async handleRoute(req: Request, env: any, ctx: any): Promise<Response> {
        if (req.url.endsWith("/mcp")) {
            return (this.MCPServer as any).serve("/mcp").fetch(req, env, ctx);
        }

        if (req.url.endsWith("/sse")) {
            return (this.MCPServer as any).serveSSE("/sse").fetch(req, env, ctx);
        }

        console.log("Bearer handler: No matching route found");
        throw new Error("Route not found for bearer handler");
    }

    @WithSpan('bearer-handler')
    async handle(req: Request, env: any, ctx: any): Promise<Response> {
        try {
            console.log("Bearer handler executing");
            
            const { accessToken, instanceUrl, clientName } = await this.validateBearerToken(req);

            ctx.props = {
                accessToken,
                instanceUrl,
                clientName,
            };

            return await this.handleRoute(req, env, ctx);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            console.error("Bearer handler error:", errorMessage);
            
            if (errorMessage.includes("Bearer token is required")) {
                return new Response(errorMessage, { status: 400 });
            }
            if (errorMessage.includes("TS Host is required")) {
                return new Response(errorMessage, { status: 400 });
            }
            if (errorMessage.includes("Route not found")) {
                return new Response("Not found", { status: 404 });
            }
            
            return new Response("Internal server error", { status: 500 });
        }
    }
}

export function withBearerHandler(app: typeof honoApp, MCPServer: typeof ThoughtSpotMCP): typeof honoApp {
    const handler = new BearerHandler(app, MCPServer);
    
    app.mount("/bearer", async (req, env, ctx) => {
        return handler.handle(req, env, ctx);
    });

    return app;
}