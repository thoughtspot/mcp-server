import { OAuthProviderDO, ThoughtSpotMCP } from './index';

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // Get or create the OAuthProviderDO instance
        const id = env.OAUTH_PROVIDER_OBJECT.idFromName('default');
        const obj = env.OAUTH_PROVIDER_OBJECT.get(id);
        
        // Forward the request to the durable object
        return obj.fetch(request);
    }
};

// Export the durable object classes
export { OAuthProviderDO, ThoughtSpotMCP }; 