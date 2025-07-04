import type { ThoughtSpotMCP } from '.';
import type honoApp from './handlers';
import { validateAndSanitizeUrl } from './oauth-manager/oauth-utils';

export function withBearerHandler(app: typeof honoApp, MCPServer: typeof ThoughtSpotMCP) {
    app.mount("/bearer", (req, env, ctx) => {
        const authHeader = req.headers.get("authorization");
        if (!authHeader) {
            return new Response("Bearer token is required", { status: 400 });
        }

        let accessToken = authHeader.split(" ")[1];
        let tsHost: string | null;

        if (accessToken.includes('@')) {
            [accessToken, tsHost] = accessToken.split("@");
        } else {
            tsHost = req.headers.get("x-ts-host");
        }

        if (!tsHost) {
            return new Response("TS Host is required, either in the authorization header as 'token@ts-host' or as a separate 'x-ts-host' header", { status: 400 });
        }

        const clientName = req.headers.get("x-ts-client-name") || "Bearer Token client";

        ctx.props = {
            accessToken: accessToken,
            instanceUrl: validateAndSanitizeUrl(tsHost),
            clientName,
        };

        if (req.url.endsWith("/mcp")) {
            // Handle OPTIONS requests for CORS preflight
            if (req.method === "OPTIONS") {
                return new Response(null, {
                    status: 200,
                    headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ts-host, x-ts-client-name",
                        "Access-Control-Max-Age": "86400"
                    }
                });
            }
            
            // Handle GET requests for tool listing
            if (req.method === "GET") {
                console.log("GET /mcp", req.body);
                return new Response(JSON.stringify({
                    tools: [
                        {
                            name: "ping",
                            description: "Simple ping tool to test connectivity and Auth",
                            inputSchema: {
                                type: "object",
                                properties: {},
                                required: []
                            }
                        },
                        {
                            name: "getRelevantQuestions",
                            description: "Get relevant data questions from ThoughtSpot database",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    query: {
                                        type: "string",
                                        description: "The query to get relevant data questions for"
                                    },
                                    additionalContext: {
                                        type: "string",
                                        description: "Additional context to add to the query"
                                    },
                                    datasourceIds: {
                                        type: "array",
                                        items: { type: "string" },
                                        description: "The datasources to get questions for"
                                    }
                                },
                                required: ["query", "datasourceIds"]
                            }
                        },
                        {
                            name: "getAnswer",
                            description: "Get the answer to a question from ThoughtSpot database",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    question: {
                                        type: "string",
                                        description: "The question to get the answer for"
                                    },
                                    datasourceId: {
                                        type: "string",
                                        description: "The datasource to get the answer for"
                                    }
                                },
                                required: ["question", "datasourceId"]
                            }
                        },
                        {
                            name: "createLiveboard",
                            description: "Create a liveboard from a list of answers",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    name: {
                                        type: "string",
                                        description: "The name of the liveboard to create"
                                    },
                                    answers: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            properties: {
                                                question: { type: "string" },
                                                session_identifier: { type: "string" },
                                                generation_number: { type: "number" }
                                            },
                                            required: ["question", "session_identifier", "generation_number"]
                                        },
                                        description: "The answers to create the liveboard from"
                                    }
                                },
                                required: ["name", "answers"]
                            }
                        }
                    ]
                }), {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ts-host, x-ts-client-name"
                    }
                });
            }
            
            // Handle POST requests for MCP protocol
            return MCPServer.serve("/mcp").fetch(req, env, ctx);
        }

        if (req.url.endsWith("/sse")) {
            return MCPServer.serveSSE("/sse").fetch(req, env, ctx);
        }

        return new Response("Not found", { status: 404 });
    });

    return app;
}