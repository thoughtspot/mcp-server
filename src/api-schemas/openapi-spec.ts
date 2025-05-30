import { Hono } from 'hono';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ToolName, toolDefinitions } from './schemas';
import { capitalize } from '../utils';

export const openApiSpecHandler = new Hono();

// Helper function to generate tool schema
const generateToolSchema = (tool: typeof toolDefinitions[0]) => {
    const schemaName = `${capitalize(tool.name)}Request`;
    const generatedSchema = zodToJsonSchema(tool.schema) as any;
    delete generatedSchema.$schema;

    // Add hardcoded values and additional properties based on tool name
    switch (tool.name) {
        case ToolName.GetAnswer:
            generatedSchema.properties.datasourceId = {
                type: 'string',
                description: 'The ID of the datasource to use for answering the question',
                example: 'cd252e5c-b552-49a8-821d-3eadaa049cca'
            };
            break;
        case ToolName.GetRelevantQuestions:
            generatedSchema.properties.datasourceIds = {
                type: 'array',
                description: 'List of datasource IDs to search within',
                items: {
                    type: 'string'
                },
                example: ['123e4567-e89b-12d3-a456-426614174000', '987fcdeb-51d3-a456-426614174000']
            };
            generatedSchema.properties.additionalContext = {
                type: 'string',
                description: 'Additional context to help find relevant questions',
                example: 'Looking for monthly trends in the last quarter'
            };
            break;
    }

    return { schemaName, schema: generatedSchema };
};

// Helper function to generate response schema
const generateResponseSchema = (toolName: ToolName) => {
    switch (toolName) {
        case ToolName.GetRelevantQuestions:
            return {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        question: { 
                            type: 'string', 
                            description: 'The relevant question',
                            example: 'What are the monthly sales trends for the last quarter?' 
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
        case ToolName.GetAnswer:
            return {
                type: 'object',
                properties: {
                    answer: { 
                        type: 'string', 
                        description: 'The answer to the question',
                        example: 'The total sales by region are: North - $1.2M, South - $800K, East - $1.5M, West - $900K' 
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
        case ToolName.CreateLiveboard:
            return {
                type: 'string',
                description: 'URL of the created liveboard',
                example: 'https://thoughtspot.thoughtspot.com/viz/123456'
            };
        default:
            return {
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
};

// Create individual endpoints for each tool
for (const tool of toolDefinitions) {
    const { schemaName, schema } = generateToolSchema(tool);
    const responseSchema = generateResponseSchema(tool.name);

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

    for (const tool of toolDefinitions) {
        const { schemaName, schema } = generateToolSchema(tool);
        const responseSchema = generateResponseSchema(tool.name);

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