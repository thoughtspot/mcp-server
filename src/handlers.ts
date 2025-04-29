import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import { Props } from './utils';


const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>()

app.get("/authorize", async (c) => {
    // TODO: Implement
    const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: "userId",
        metadata: {
            label: "username",
        },
        scope: oauthReqInfo.scope,
        // This will be available on this.props inside ThoughtSpotMCP
        props: {
            accessToken: c.env.ACCESS_TOKEN,
            instanceUrl: c.env.INSTANCE_URL,
        } as Props,
    });

    return Response.redirect(redirectTo);
})

app.post("/authorize", async (c) => {
    // TODO: Implement
})

app.get("/callback", async (c) => {
    // TODO: Implement
})

export default app;