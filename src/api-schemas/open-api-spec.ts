import { Hono } from 'hono';
import { toolDefinitionsMCPServer } from '../servers/mcp-server';
import { capitalize } from '../utils';

export const openApiSpecHandler = new Hono();

// Helper function to generate tool schema
const generateToolSchema = (tool: typeof toolDefinitionsMCPServer[0]) => {
    const schemaName = `${capitalize(tool.name)}Request`;
    const generatedSchema = { ...tool.inputSchema } as any;
    generatedSchema.$schema = undefined;
    return { schemaName, schema: generatedSchema };
};

// Helper function to generate response schema
const generateResponseSchema = () => {
    return {
        type: 'object',
        description: 'Response from the API endpoint'
    };
};

// Create individual endpoints for each tool
for (const tool of toolDefinitionsMCPServer) {
    const { schemaName, schema } = generateToolSchema(tool);
    const responseSchema = generateResponseSchema();

    openApiSpecHandler.get(`/tools/${tool.name}`, async (c) => {
        const toolSpec = {
            openapi: '3.0.0',
            info: {
                title: 'ThoughtSpot API',
                version: '1.0.0',
                description: 'API for interacting with ThoughtSpot services'
            },
            servers: [
                {
                    url: '<TS_AGENT_URL>',
                    description: 'ThoughtSpot agent url'
                }
            ],
            paths: {
                [`/api/tools/${tool.name}`]: {
                    post: {
                        summary: tool.description,
                        description: tool.description,
                        operationId: tool.name,
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
                                        schema: {
                                            $ref: `#/components/schemas/${capitalize(tool.name)}Response`
                                        }
                                    }
                                }
                            },
                            '400': {
                                description: 'Bad request - Invalid input parameters'
                            },
                            '401': {
                                description: 'Unauthorized - Invalid or missing authentication'
                            },
                            '500': {
                                description: 'Internal server error'
                            }
                        }
                    }
                }
            },
            components: {
                schemas: {
                    [schemaName]: schema,
                    [`${capitalize(tool.name)}Response`]: responseSchema
                }
            }
        };

        return c.json(toolSpec);
    });
}

// Main OpenAPI spec endpoint that combines all tools
openApiSpecHandler.get('/', async (c) => {
    const paths: Record<string, any> = {};
    const schemas: Record<string, any> = {};

    // any tool added to the toolDefinitionsMCPServer will be added to the openapi spec automatically
    // the api server path should be /api/tools/<tool-name>
    for (const tool of toolDefinitionsMCPServer) {
        const { schemaName, schema } = generateToolSchema(tool);
        const responseSchema = generateResponseSchema();

        schemas[schemaName] = schema;
        schemas[`${capitalize(tool.name)}Response`] = responseSchema;
        
        paths[`/api/tools/${tool.name}`] = {
            post: {
                summary: tool.description,
                description: tool.description,
                operationId: tool.name,
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
                                schema: {
                                    $ref: `#/components/schemas/${capitalize(tool.name)}Response`
                                }
                            }
                        }
                    },
                    '400': {
                        description: 'Bad request - Invalid input parameters'
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
            description: 'API for interacting with ThoughtSpot services'
        },
        servers: [
            {
                url: '<TS_AGENT_URL>',
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