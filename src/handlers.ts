import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import type { Props } from './utils';
import { parseRedirectApproval, renderApprovalDialog } from './oauth-manager/oauth-utils';
import { renderTokenCallback } from './oauth-manager/token-utils';
import { any } from 'zod';
import { encodeBase64, decodeBase64 } from 'hono/utils/encode';
import { PingSchema, GetRelevantQuestionsSchema, GetAnswerSchema, CreateLiveboardSchema, ToolName, toolDefinitions } from './api-schemas/schemas';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { capitalize } from './utils';


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

app.get("/pong/t", async (c) => {
    console.log("Received Pong request");
    console.log(c.executionCtx);
    const { props } = c.executionCtx;
    if (props.accessToken && props.instanceUrl) {
        console.log(props.accessToken, props.instanceUrl);
        return c.json({
            message: "Pong",
        });
    } else {
        return c.json({
            message: "Fail",
        });
    }
});

app.get('/openapi-spec', async (c) => {
    const paths: Record<string, any> = {};
    const schemas: Record<string, any> = {};

    for (const tool of toolDefinitions) {
        const schemaName = `${capitalize(tool.name)}Request`;
        // Convert Zod schema to JSON schema
        const generatedSchema = zodToJsonSchema(tool.schema) as any;
        delete generatedSchema.$schema;

        // Add hardcoded values and additional properties based on tool name
        switch (tool.name) {
            case ToolName.GetAnswer:
                generatedSchema.properties.datasourceId = {
                    type: 'string',
                    description: 'The ID of the datasource to use for answering the question',
                    example: '123e4567-e89b-12d3-a456-426614174000',
                    default: '123e4567-e89b-12d3-a456-426614174000',
                    enum: ['123e4567-e89b-12d3-a456-426614174000']
                };
                break;
            case ToolName.GetRelevantQuestions:
                generatedSchema.properties.datasourceIds = {
                    type: 'array',
                    description: 'List of datasource IDs to search within',
                    items: {
                        type: 'string'
                    },
                    example: ['123e4567-e89b-12d3-a456-426614174000']
                };
                break;
        }

        schemas[schemaName] = generatedSchema;

        // Create response schema based on tool name
        let responseSchema;
        switch (tool.name) {
            case ToolName.GetRelevantQuestions:
                responseSchema = {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            question: { 
                                type: 'string', 
                                description: 'The relevant question',
                                example: 'What are the monthly sales trends?' 
                            },
                            confidence: { 
                                type: 'number', 
                                description: 'Confidence score of the question relevance',
                                example: 0.85 
                            },
                            datasourceId: { 
                                type: 'string', 
                                description: 'The datasource ID this question is most relevant to',
                                example: '123e4567-e89b-12d3-a456-426614174000' 
                            }
                        }
                    }
                };
                break;
            case ToolName.GetAnswer:
                responseSchema = {
                    type: 'object',
                    properties: {
                        answer: { 
                            type: 'string', 
                            description: 'The answer to the question',
                            example: 'The total sales by region are: North - $1.2M, South - $800K' 
                        },
                        metadata: {
                            type: 'object',
                            description: 'Additional metadata about the answer',
                            properties: {
                                confidence: { 
                                    type: 'number', 
                                    description: 'Confidence score of the answer',
                                    example: 0.95 
                                },
                                source: { 
                                    type: 'string', 
                                    description: 'Source of the answer',
                                    example: 'Sales Analysis Dashboard' 
                                }
                            }
                        }
                    }
                };
                break;
            case ToolName.CreateLiveboard:
                responseSchema = {
                    type: 'string',
                    description: 'URL of the created liveboard',
                    example: 'https://thoughtspot.thoughtspot.com/viz/123456'
                };
                break;
            default:
                responseSchema = {
                    type: 'object',
                    properties: {
                        content: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    type: { type: 'string', example: 'text' },
                                    text: { type: 'string' }
                                }
                            }
                        },
                        isError: { type: 'boolean' }
                    }
                };
        }

        paths[`/api/tools/${tool.name}`] = {
            post: {
                summary: tool.description,
                operationId: `call${capitalize(tool.name)}`,
                tags: ['Tools'],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                $ref: `#/components/schemas/${schemaName}`
                            }
                        }
                    }
                },
                responses: {
                    '200': {
                        description: 'Successful response',
                        content: {
                            'application/json': {
                                schema: responseSchema
                            }
                        }
                    },
                    '400': {
                        description: 'Bad request - Invalid input parameters',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        error: { type: 'string' }
                                    }
                                }
                            }
                        }
                    },
                    '401': {
                        description: 'Unauthorized - Invalid or missing authentication'
                    },
                    '500': {
                        description: 'Internal server error'
                    }
                }
            }
        };
    }

    const openApiDocument = {
        openapi: '3.0.0',
        info: {
            title: 'ThoughtSpot API',
            version: '1.0.0',
            description: 'OpenAPI specification for tools available via the MCP server, generated from Zod schemas.'
        },
        servers: [
            {
                url: '$TS-AGENT-URL',
                description: 'ThoughtSpot agent url'
            }
        ],
        paths: paths,
        components: {
            schemas: schemas
        }
    };

    return c.json(openApiDocument);
});

export default app;