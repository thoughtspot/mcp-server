import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import type { Props } from './utils';
import { parseRedirectApproval, renderApprovalDialog, buildSamlRedirectUrl } from './oauth-manager/oauth-utils';
import { renderTokenCallback } from './oauth-manager/token-utils';
import { any } from 'zod';
import { encodeBase64Url, decodeBase64Url } from 'hono/utils/encode';



const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>()

app.get("/", async (c) => {
    return c.env.ASSETS.fetch('/index.html');
});

app.get("/hello", async (c) => {
    return c.json({ message: "Hello, World!" });
});

app.get("/authorize", async (c) => {
    const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    const { clientId } = oauthReqInfo
    if (!clientId) {
        return c.text('Invalid request', 400)
    }
    return renderApprovalDialog(c.req.raw, {
        client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
        server: {
            name: "ThoughtSpot MCP Server",
            logo: "https://avatars.githubusercontent.com/u/8906680?s=200&v=4",
            description: 'MCP Server for ThoughtSpot Agent', // optional
        },
        state: { oauthReqInfo }, // arbitrary data that flows through the form submission below
    })
})

app.post("/authorize", async (c) => {
    try {
        // Validates form submission and extracts state
        const { state, instanceUrl } = await parseRedirectApproval(c.req.raw)
        if (!state.oauthReqInfo) {
            return c.text('Invalid request', 400)
        }

        if (!instanceUrl) {
            return new Response('Missing instance URL', { status: 400 });
        }

        // Use the new utility function to build the redirect URL
        const redirectUrl = buildSamlRedirectUrl(
            instanceUrl,
            state.oauthReqInfo,
            new URL(c.req.url).origin
        );
        console.log("redirectUrl", redirectUrl);

        return Response.redirect(redirectUrl);
    } catch (error) {
        console.error('Error in POST /authorize:', error);
        if (error instanceof Error && error.message.includes('Missing instance URL')) {
            return new Response('Missing instance URL', { status: 400 });
        }
        return new Response('Invalid request', { status: 400 });
    }
})

app.get("/callback", async (c) => {

    // TODO(shikhar.bhargava): remove this once we have a proper callback URL
    // With the proper callback URL, we will get the encrypted token in the query params
    // along with it we will get the instanceUrl and the state (oauthReqInfo).
    // and we will decrypt the token to get the user's access token and complete the authorization.
    // const encodedOauthReqInfo = c.req.query('state');

    const instanceUrl = c.req.query('instanceUrl');
    const encodedOauthReqInfo = c.req
        .query('oauthReqInfo')
        // Added as a workaround for https://thoughtspot.atlassian.net/browse/SCAL-258056
        ?.replace('/10023.html', '');
    if (!instanceUrl) {
        return c.text('Missing instance URL', 400);
    }
    if (!encodedOauthReqInfo) {
        return c.text('Missing OAuth request info', 400);
    }

    try {
        const decodedOAuthReqInfo = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedOauthReqInfo)));
        return new Response(renderTokenCallback(instanceUrl, decodedOAuthReqInfo), {
            headers: {
                'Content-Type': 'text/html',
            },
        });
    } catch (error) {
        console.error('Error decoding OAuth request info:', error);
        return c.text('Invalid OAuth request info format', 400);
    }
})

app.post("/store-token", async (c) => {
    let token, oauthReqInfo, instanceUrl;
    
    try {
        const body = await c.req.json();
        token = body.token;
        oauthReqInfo = body.oauthReqInfo;
        instanceUrl = body.instanceUrl;
    } catch (error) {
        console.error('Error parsing JSON in store-token:', error);
        return c.text('Invalid JSON format', 400);
    }
    
    if (!token || !oauthReqInfo || !instanceUrl) {
        return c.text('Missing token or OAuth request info or instanceUrl', 400);
    }

    const { clientId } = oauthReqInfo;
    const clientName = await c.env.OAUTH_PROVIDER.lookupClient(clientId);

    // Complete the authorization with the provided information
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
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

    // Add CORS headers to the response
    return new Response(JSON.stringify({
        redirectTo: redirectTo
    }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json'
        }
    });
});

export default app;