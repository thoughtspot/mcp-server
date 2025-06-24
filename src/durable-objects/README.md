# OpenTelemetry Integration with OAuth Provider

This directory contains the OpenTelemetry integration for the ThoughtSpot MCP Server using `@microlabs/otel-cf-workers`.

## Overview

The `InstrumentedOAuthProviderDO` is a durable object that wraps the OAuth provider functionality with OpenTelemetry instrumentation. This enables distributed tracing and observability for all OAuth-related operations.

## Configuration

### Environment Variables

Add the following environment variable to your `.dev.vars` file or Cloudflare Workers environment:

```bash
HONEYCOMB_API_KEY=your_honeycomb_api_key_here
```

### Wrangler Configuration

The durable object is configured in `wrangler.jsonc`:

```json
{
  "durable_objects": {
    "bindings": [
      {
        "class_name": "InstrumentedOAuthProviderDO",
        "name": "OAUTH_PROVIDER_DO"
      }
    ]
  }
}
```

## Usage

The main `index.ts` file delegates all requests to the instrumented durable object:

```typescript
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const id = env.OAUTH_PROVIDER_DO.idFromName('oauth-provider');
        const obj = env.OAUTH_PROVIDER_DO.get(id);
        return obj.fetch(request);
    }
};
```

## Features

- **Distributed Tracing**: All OAuth operations are traced with OpenTelemetry
- **Honeycomb Integration**: Traces are exported to Honeycomb for analysis
- **Durable Object Persistence**: OAuth state is maintained across requests
- **Automatic Instrumentation**: No manual span creation required

## Tracing

The following operations are automatically traced:

- OAuth authorization requests
- Token exchanges
- Client registration
- MCP server operations
- API server operations

## Honeycomb Dashboard

You can view traces in Honeycomb by:

1. Setting up a Honeycomb account
2. Creating a new dataset for your service
3. Using the API key in your environment variables
4. Viewing traces in the Honeycomb UI

## Example Trace

A typical OAuth flow will generate traces like:

```
OAuth Authorization Request
├── Client Lookup
├── Approval Dialog Rendering
├── Token Exchange
└── MCP Server Initialization
```

## Troubleshooting

### Missing HONEYCOMB_API_KEY

If you see errors about missing the Honeycomb API key, ensure it's set in your environment variables.

### Type Errors

If you encounter TypeScript errors related to Request types, this is a known issue with different versions of Cloudflare Workers types. The code uses type assertions to work around this.

### Durable Object Not Found

Ensure the durable object is properly configured in `wrangler.jsonc` and the migration has been applied. 