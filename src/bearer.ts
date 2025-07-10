import type { ThoughtSpotMCP } from '.';
import type honoApp from './handlers';
import { validateAndSanitizeUrl } from './oauth-manager/oauth-utils';
import { withSpan } from './metrics/tracing/tracing-utils';

export function withBearerHandler(app: typeof honoApp, MCPServer: typeof ThoughtSpotMCP): typeof honoApp {
    app.mount("/bearer", async (req, env, ctx) => {
        return withSpan('with-bearer-mcp', async (span) => {
            const authHeader = req.headers.get("authorization");
            if (!authHeader) {
                span.setAttributes({
                    error: true,
                    error_message: "Bearer token is required"
                });
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
                span.setAttributes({
                    error: true,
                    error_message: "TS Host is required"
                });
                return new Response("TS Host is required, either in the authorization header as 'token@ts-host' or as a separate 'x-ts-host' header", { status: 400 });
            }

            const clientName = req.headers.get("x-ts-client-name") || "Bearer Token client";
            const instanceUrl = validateAndSanitizeUrl(tsHost);

            // Set span attributes for better tracing
            span.setAttributes({
                instance_url: instanceUrl,
                client_name: clientName,
                has_access_token: !!accessToken,
            });

            ctx.props = {
                accessToken: accessToken,
                instanceUrl: instanceUrl,
                clientName,
            };

            if (req.url.endsWith("/mcp")) {
                span.setAttributes({ route: "mcp" });
                return (MCPServer as any).serve("/mcp").fetch(req, env, ctx);
            }

            if (req.url.endsWith("/sse")) {
                span.setAttributes({ route: "sse" });
                return (MCPServer as any).serveSSE("/sse").fetch(req, env, ctx);
            }

            span.setAttributes({
                error: true,
                error_message: "Route not found"
            });
            return new Response("Not found", { status: 404 });
        });
    });

    return app;
}