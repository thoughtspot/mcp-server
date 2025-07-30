import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import type { Props } from './utils';
import { McpServerError } from './utils';
import { parseRedirectApproval, renderApprovalDialog, buildSamlRedirectUrl } from './oauth-manager/oauth-utils';
import { renderTokenCallback } from './oauth-manager/token-utils';
import { any } from 'zod';
import { encodeBase64Url, decodeBase64Url } from 'hono/utils/encode';
import { getActiveSpan, WithSpan } from './metrics/tracing/tracing-utils';
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>()

class Handler {
    @WithSpan('serve-index')
    async serveIndex(env: Env) {
        return env.ASSETS.fetch('/index.html');
    }

    @WithSpan('hello-world')
    async helloWorld() {
        return { message: "Hello, World!" };
    }

    @WithSpan('authorize-get')
    async getAuthorize(request: Request, oauthProvider: OAuthHelpers) {
        const span = getActiveSpan();
        const oauthReqInfo = await oauthProvider.parseAuthRequest(request);
        const { clientId } = oauthReqInfo;

        span?.setAttribute("client_id", clientId || "unknown");

        if (!clientId) {
            throw new McpServerError({ message: "Missing client ID" }, 400);
        }
        const client = await oauthProvider.lookupClient(clientId);
        return renderApprovalDialog(request, {
            client,
            server: {
                name: "ThoughtSpot MCP Server",
                logo: "https://avatars.githubusercontent.com/u/8906680?s=200&v=4",
                description: 'MCP Server for ThoughtSpot Agent',
            },
            state: { oauthReqInfo },
        });
    }

    @WithSpan('authorize-post')
    async postAuthorize(request: Request, requestUrl: string) {
        const span = getActiveSpan();
        try {
            const { state, instanceUrl } = await parseRedirectApproval(request);

            span?.setAttribute("instance_url", instanceUrl || "unknown");

            if (!state.oauthReqInfo) {
                throw new McpServerError({ message: "Missing OAuth request info" }, 400);
            }

            if (!instanceUrl) {
                throw new McpServerError({ message: "Missing instance URL" }, 400);
            }

            const origin = new URL(requestUrl).origin;

            // TODO: Remove this once we have a proper way to handle this
            // This is a temporary fix to handle the case where the instance URL is a free trial instance URL
            // Since, free trial does not support IAMv2, we will assume that the user is logged in.
            if (instanceUrl.match(/https:\/\/team\d+\.thoughtspot\.cloud|https:\/\/my\d+\.thoughtspot\.cloud/)) {
                const callbackUrl = new URL("/callback", origin);
                callbackUrl.searchParams.set("instanceUrl", instanceUrl);
                callbackUrl.searchParams.set(
                    "oauthReqInfo",
                    encodeBase64Url(new TextEncoder().encode(JSON.stringify(state.oauthReqInfo)).buffer)
                );
                return callbackUrl.toString();
            }

            const redirectUrl = buildSamlRedirectUrl(
                instanceUrl,
                state.oauthReqInfo,
                origin
            );

            console.log("redirectUrl", redirectUrl);

            return redirectUrl;
        } catch (error) {
            throw new McpServerError(error, 500);
        }
    }

    @WithSpan('oauth-callback')
    async handleCallback(request: Request, assets: any, requestUrl: string) {
        const span = getActiveSpan();

        const url = new URL(request.url);
        const instanceUrl = url.searchParams.get('instanceUrl');
        const encodedOauthReqInfo = url.searchParams.get('oauthReqInfo')
            // Added as a workaround for https://thoughtspot.atlassian.net/browse/SCAL-258056
            ?.replace('/10023.html', '');

        span?.setAttributes({
            instance_url: instanceUrl || "unknown",
            has_oauth_req_info: !!encodedOauthReqInfo,
        });

        if (!instanceUrl) {
            throw new McpServerError({ message: "Missing instance URL" }, 400);
        }
        if (!encodedOauthReqInfo) {
            throw new McpServerError({ message: "Missing OAuth request info" }, 400);
        }

        let decodedOAuthReqInfo: any;
        try {
            decodedOAuthReqInfo = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedOauthReqInfo)));
        } catch (error) {
            throw new McpServerError({ message: "Invalid OAuth request info format", details: error }, 400);
        }
        const origin = new URL(requestUrl).origin;
        try {
            const htmlContent = await renderTokenCallback(instanceUrl, decodedOAuthReqInfo, assets, origin);
            span?.setStatus({ code: SpanStatusCode.OK, message: "Token callback rendered successfully" });
            return htmlContent;
        } catch (error) {
            throw new McpServerError({ message: "Error rendering token callback", details: error }, 500);
        }
    }



    @WithSpan('store-token')
    async storeToken(request: Request, oauthProvider: OAuthHelpers) {
        const span = getActiveSpan();

        let token: any;
        let oauthReqInfo: any;
        let instanceUrl: string;

        try {
            const body = await request.json() as any;
            token = body.token;
            oauthReqInfo = body.oauthReqInfo;
            instanceUrl = body.instanceUrl;
        } catch (error) {
            throw new McpServerError({ message: "Invalid JSON format", details: error }, 400);
        }
        span?.setAttributes({
            instance_url: instanceUrl || "unknown",
            has_token: !!token,
            has_oauth_req_info: !!oauthReqInfo,
        });

        if (!token || !oauthReqInfo || !instanceUrl) {
            throw new McpServerError({ message: "Missing token or OAuth request info or instanceUrl" }, 400);
        }

        const { clientId } = oauthReqInfo;
        span?.setAttribute("client_id", clientId || "unknown");

        const clientName = await oauthProvider.lookupClient(clientId);

        span?.addEvent("complete-authorization");
        // Complete the authorization with the provided information
        const { redirectTo } = await oauthProvider.completeAuthorization({
            request: oauthReqInfo,
            userId: "default", // Using a default user ID since username is not required
            metadata: {
                label: "default",
            },
            scope: oauthReqInfo.scope,
            props: {
                accessToken: token.data.token,
                instanceUrl: instanceUrl,
                clientName: clientName,
            } as Props,
        });

        span?.setStatus({ code: SpanStatusCode.OK, message: "Token stored successfully" });

        return { redirectTo };
    }
}

const handler = new Handler();

app.get("/", async (c) => {
    const response = await handler.serveIndex(c.env);
    return response;
});

app.get("/hello", async (c) => {
    const result = await handler.helloWorld();
    return c.json(result);
});

app.get("/authorize", async (c) => {
    try {
        const response = await handler.getAuthorize(c.req.raw, c.env.OAUTH_PROVIDER);
        return response;
    } catch (error) {
        return c.text(`Internal Server Error ${error}`, 500);
    }
});

app.post("/authorize", async (c) => {
    try {

        const redirectUrl = await handler.postAuthorize(c.req.raw, c.req.url);
        return Response.redirect(redirectUrl);
    } catch (error) {
        if (error instanceof Error && error.message.includes('Missing instance URL')) {
            return new Response('Missing instance URL', { status: 400 });
        }
        return new Response(`Internal Server Error ${error}`, { status: 500 });
    }
});

app.get("/callback", async (c) => {
    try {
        const htmlContent = await handler.handleCallback(c.req.raw, c.env.ASSETS, c.req.url);
        return new Response(htmlContent, {
            headers: {
                'Content-Type': 'text/html',
            },
        });
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes('Missing instance URL')) {
                return c.text(`Missing instance URL ${error}`, 400);
            }
            if (error.message.includes('Missing OAuth request info')) {
                return c.text(`Missing OAuth request info ${error}`, 400);
            }
            if (error.message.includes('Invalid OAuth request info format')) {
                return c.text(`Invalid OAuth request info format ${error}`, 400);
            }
        }
        return c.text(`Internal server error ${error}`, 500);
    }
});

app.post("/store-token", async (c) => {
    try {
        const result = await handler.storeToken(c.req.raw, c.env.OAUTH_PROVIDER);
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: {
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes('Invalid JSON format')) {
                return c.text(`Invalid JSON format ${error}`, 400);
            }
            if (error.message.includes('Missing token or OAuth request info or instanceUrl')) {
                return c.text(`Missing token or OAuth request info or instanceUrl ${error}`, 400);
            }
        }
        return c.text(`Internal server error ${error}`, 500);
    }
});

export default app;