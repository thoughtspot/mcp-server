import type { ThoughtSpotMCP } from '.';
import type honoApp from './handlers';
import { validateAndSanitizeUrl } from './oauth-manager/oauth-utils';

export function withBearerHandler(app: typeof honoApp, MCPServer: typeof ThoughtSpotMCP) {
    app.mount("/bearer", (req, env, ctx) => {
        const authHeader = req.headers.get("authorization");
        if (!authHeader) {
            return new Response("Bearer token is required", { status: 400 });
        }

        let accessToken = authHeader.split(" ")[1];
        let tsHost: string | null;

        if (accessToken.includes('@')) {
            [accessToken, tsHost] = accessToken.split("@");
        } else {
            tsHost = req.headers.get("x-ts-host");
        }

        if (!tsHost) {
            return new Response("TS Host is required, either in the authorization header as 'token@ts-host' or as a separate 'x-ts-host' header", { status: 400 });
        }

        const clientName = req.headers.get("x-ts-client-name") || "Bearer Token client";

        ctx.props = {
            accessToken: accessToken,
            instanceUrl: validateAndSanitizeUrl(tsHost),
            clientName,
        };

        if (req.url.endsWith("/mcp")) {
            return MCPServer.serve("/mcp").fetch(req, env, ctx);
        }

        if (req.url.endsWith("/sse")) {
            return MCPServer.serveSSE("/sse").fetch(req, env, ctx);
        }

        return new Response("Not found", { status: 404 });
    });

    return app;
}