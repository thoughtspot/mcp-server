import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import { Props } from './utils';
import { parseRedirectApproval, renderApprovalDialog, renderInfoDialog } from './oauth-manager/oauth-utils';


const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>()

app.get("/", async (c) => {
    return c.json({
        message: "Hello, World!",
    });
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
			// description: 'MCP Server for ThoughtSpot Agent', // optional
		},
		state: { oauthReqInfo }, // arbitrary data that flows through the form submission below
	})
})

app.post("/authorize", async (c) => {

    // Validates form submission, extracts state, and generates Set-Cookie headers to skip approval dialog next time
	const { state, instanceUrl } = await parseRedirectApproval(c.req.raw)
	if (!state.oauthReqInfo) {
		return c.text('Invalid request', 400)
	}

    if (!instanceUrl) {
        return new Response('Missing instance URL', { status: 400 });
    }

    const oauthReqInfo = state.oauthReqInfo;

    console.log("instanceUrl", instanceUrl);
    // Complete the authorization with the provided information
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: "default", // Using a default user ID since username is not required
        metadata: {
            label: "default",
        },
        scope: oauthReqInfo.scope,
        props: {
            accessToken: await c.env.accessToken.get(),
            instanceUrl: instanceUrl,
        } as Props,
    });

    return Response.redirect(redirectTo);
})

app.get("/callback", async (c) => {
    // TODO: Implement
})

export default app;