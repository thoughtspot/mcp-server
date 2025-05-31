import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import type { Props } from './utils';
import { parseRedirectApproval, renderApprovalDialog } from './oauth-manager/oauth-utils';
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
    // Validates form submission and extracts state
    const { state, instanceUrl } = await parseRedirectApproval(c.req.raw)
    if (!state.oauthReqInfo) {
        return c.text('Invalid request', 400)
    }

    if (!instanceUrl) {
        return new Response('Missing instance URL', { status: 400 });
    }

    // Construct the redirect URL to v1/saml
    const redirectUrl = new URL('callosum/v1/saml/login', instanceUrl);


    // TODO(shikhar.bhargava): remove this once we have a proper callback URL
    // the proper callback URL is the one /callosum/v1/v2/auth/token/authroize endpoint
    // which gives the encrypted token to the client. Also with that it will have the 
    // redirect URL as query params = new URL("/callback", c.req.url).href to 
    // send the user back to callback endpoint.
    // The callback endpoint will get the encrypted token and decrypt it to get the user's access token.

    // const targetURLAuthorize = new URL("callosum/v1/v2/auth/token/authorize", instanceUrl);
    // targetURLAuthorize.searchParams.append('validity_time_in_sec', "86400");
    // const targetURLCallbackPath = new URL("/callback", c.req.url);
    // targetURLCallbackPath.searchParams.append('instanceUrl', instanceUrl);
    // targetURLAuthorize.searchParams.append('redirect_url', btoa(targetURLCallbackPath.toString()));
    // const encodedState = btoa(JSON.stringify(state.oauthReqInfo));
    // targetURLAuthorize.searchParams.append('state', encodedState);
    // targetURLAuthorize.searchParams.append('token_encryption_key', "1234567812345678");
    // targetURLAuthorize.searchParams.append('encryption_algorithm', 'AES');
    // redirectUrl.searchParams.append('targetURLPath', targetURLAuthorize.href);

    const targetURLPath = new URL("/callback", c.req.url);
    targetURLPath.searchParams.append('instanceUrl', instanceUrl);
    const encodedState = encodeBase64Url(new TextEncoder().encode(JSON.stringify(state.oauthReqInfo)).buffer);
    targetURLPath.searchParams.append('oauthReqInfo', encodedState);
    redirectUrl.searchParams.append('targetURLPath', targetURLPath.href);
    console.log("redirectUrl", redirectUrl.toString());

    return Response.redirect(redirectUrl.toString());
})

app.get("/callback", async (c) => {

    // TODO(shikhar.bhargava): remove this once we have a proper callback URL
    // With the proper callback URL, we will get the encrypted token in the query params
    // along with it we will get the instanceUrl and the state (oauthReqInfo).
    // and we will decrypt the token to get the user's access token and complete the authorization.
    // const encodedOauthReqInfo = c.req.query('state');

    const instanceUrl = c.req.query('instanceUrl');
    const encodedOauthReqInfo = c.req.query('oauthReqInfo');
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
    const { token, oauthReqInfo, instanceUrl } = await c.req.json();
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