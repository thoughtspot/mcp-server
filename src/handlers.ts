import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import type { Props } from './utils';
import { parseRedirectApproval, renderApprovalDialog, buildSamlRedirectUrl } from './oauth-manager/oauth-utils';
import { renderTokenCallback } from './oauth-manager/token-utils';
import { any } from 'zod';
import { encodeBase64Url, decodeBase64Url } from 'hono/utils/encode';
import { WithSpan } from './metrics/tracing/tracing-utils';
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>()

class OAuthHandler {
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
        const span = trace.getSpan(context.active());        
        const oauthReqInfo = await oauthProvider.parseAuthRequest(request);
        const { clientId } = oauthReqInfo;
        
        span?.setAttribute("client_id", clientId || "unknown");
        
        if (!clientId) {
            span?.setStatus({ code: SpanStatusCode.ERROR, message: "Missing client ID" });
            throw new Error('Invalid request');
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
        const span = trace.getSpan(context.active());        
        try {
            const { state, instanceUrl } = await parseRedirectApproval(request);
            
            span?.setAttribute("instance_url", instanceUrl || "unknown");
            
            if (!state.oauthReqInfo) {
                span?.setStatus({ code: SpanStatusCode.ERROR, message: "Missing OAuth request info" });
                throw new Error('Invalid request');
            }

            if (!instanceUrl) {
                span?.setStatus({ code: SpanStatusCode.ERROR, message: "Missing instance URL" });
                throw new Error('Missing instance URL');
            }

            const redirectUrl = buildSamlRedirectUrl(
                instanceUrl,
                state.oauthReqInfo,
                new URL(requestUrl).origin
            );
            
            console.log("redirectUrl", redirectUrl);

            return redirectUrl;
        } catch (error) {
            span?.setStatus({ code: SpanStatusCode.ERROR, message: `Error in POST /authorize: ${error}` });
            console.error('Error in POST /authorize:', error);
            throw error;
        }
    }

    @WithSpan('oauth-callback')
    async handleCallback(request: Request, assets: any, requestUrl: string) {
        const span = trace.getSpan(context.active());
        
        const url = new URL(request.url);
        const instanceUrl = url.searchParams.get('instanceUrl');
        const encodedOauthReqInfo = url.searchParams.get('oauthReqInfo')
            // Added as a workaround for https://thoughtspot.atlassian.net/browse/SCAL-258056
            ?.replace('/10023.html', '');

        span?.setAttribute("instance_url", instanceUrl || "unknown");
        span?.setAttribute("has_oauth_req_info", !!encodedOauthReqInfo);

        if (!instanceUrl) {
            span?.setStatus({ code: SpanStatusCode.ERROR, message: "Missing instance URL" });
            throw new Error('Missing instance URL');
        }
        if (!encodedOauthReqInfo) {
            span?.setStatus({ code: SpanStatusCode.ERROR, message: "Missing OAuth request info" });
            throw new Error('Missing OAuth request info');
        }

        let decodedOAuthReqInfo: any;
        try {
            decodedOAuthReqInfo = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedOauthReqInfo)));
        } catch (error) {
            span?.setStatus({ code: SpanStatusCode.ERROR, message: `Error decoding OAuth request info: ${error}` });
            console.error('Error decoding OAuth request info:', error);
            throw new Error('Invalid OAuth request info format');
        }
        const origin = new URL(requestUrl).origin;
        try {
            const htmlContent = await renderTokenCallback(instanceUrl, decodedOAuthReqInfo, assets, origin);
            span?.setStatus({ code: SpanStatusCode.OK, message: "Token callback rendered successfully" });
            return htmlContent;
        } catch (error) {
            span?.setStatus({ code: SpanStatusCode.ERROR, message: `Error rendering token callback: ${error}` });
            console.error('Error rendering token callback:', error);
            throw new Error('Error rendering token callback');
        }
    }



    @WithSpan('store-token')
    async storeToken(request: Request, oauthProvider: OAuthHelpers) {
        const span = trace.getSpan(context.active());
        
        let token: any;
        let oauthReqInfo: any;
        let instanceUrl: string;
        
        try {
            const body = await request.json() as any;
            token = body.token;
            oauthReqInfo = body.oauthReqInfo;
            instanceUrl = body.instanceUrl;
        } catch (error) {
            span?.setStatus({ code: SpanStatusCode.ERROR, message: `Error parsing JSON: ${error}` });
            console.error('Error parsing JSON in store-token:', error);
            throw new Error('Invalid JSON format');
        }
        
        span?.setAttribute("instance_url", instanceUrl || "unknown");
        span?.setAttribute("has_token", !!token);
        span?.setAttribute("has_oauth_req_info", !!oauthReqInfo);
        
        if (!token || !oauthReqInfo || !instanceUrl) {
            span?.setStatus({ code: SpanStatusCode.ERROR, message: "Missing required fields" });
            throw new Error('Missing token or OAuth request info or instanceUrl');
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

const handler = new OAuthHandler();

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