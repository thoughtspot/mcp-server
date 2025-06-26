import { ThoughtSpotMCP, ThoughtSpotOAuthProvider } from "./oauth-provider";

// Export the instrumented durable objects for Wrangler
export { ThoughtSpotOAuthProvider, ThoughtSpotMCP };

// Create a simple handler that delegates to the durable object
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // Get or create the durable object instance
        const id = env.OAUTH_PROVIDER_DO.idFromName('oauth-provider');
        const obj = env.OAUTH_PROVIDER_DO.get(id);
        return obj.fetch(request);
    }
};
