import { describe, it, expect, vi, beforeEach } from "vitest";
import { withBearerHandler } from "../src/bearer";
import { ThoughtSpotMCP } from "../src";
import { Hono } from "hono";
import { encodeBase64Url, decodeBase64Url } from 'hono/utils/encode';

// For correctly-typed Request
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Bearer Handler", () => {
    let app: any;
    let mockEnv: any;
    let mockCtx: any;
    let mockMcpServer: any;

    beforeEach(() => {
        // Create a simple Hono app for testing
        app = new Hono();
        
        // Mock environment
        mockEnv = {
            ASSETS: {
                fetch: vi.fn().mockResolvedValue(new Response('<html>Test</html>'))
            },
            OAUTH_PROVIDER: {
                parseAuthRequest: vi.fn(),
                lookupClient: vi.fn(),
                completeAuthorization: vi.fn()
            }
        };

        // Mock execution context
        mockCtx = {
            props: {},
            waitUntil: vi.fn()
        };

        // Mock the MCP server
        mockMcpServer = {
            serve: vi.fn().mockReturnValue({
                fetch: vi.fn().mockResolvedValue(new Response('MCP Response', { status: 200 }))
            }),
            serveSSE: vi.fn().mockReturnValue({
                fetch: vi.fn().mockResolvedValue(new Response('SSE Response', { status: 200 }))
            })
        };

        // Mock ThoughtSpotMCP class
        vi.mocked(ThoughtSpotMCP).serve = mockMcpServer.serve;
        vi.mocked(ThoughtSpotMCP).serveSSE = mockMcpServer.serveSSE;
    });

    describe("withBearerHandler", () => {
        it("should mount bearer routes to the app", () => {
            const result = withBearerHandler(app, ThoughtSpotMCP);
            expect(result).toBe(app);
        });

        it("should handle requests to /bearer/mcp endpoint", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer test-token@test.thoughtspot.cloud",
                    "x-ts-client-name": "Test Client"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);
            
            // The request should be handled by the bearer handler
            expect(result).toBeDefined();
        });

        it("should handle requests to /bearer/sse endpoint", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/sse", {
                headers: {
                    "authorization": "Bearer test-token@test.thoughtspot.cloud",
                    "x-ts-client-name": "Test Client"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);
            
            // The request should be handled by the bearer handler
            expect(result).toBeDefined();
        });

        it("should route /bearer/mcp to MCP server and call serve method", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer test-token@test.thoughtspot.cloud",
                    "x-ts-client-name": "Test Client"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);
            
            // Verify that the MCP server's serve method was called with the correct path
            expect(mockMcpServer.serve).toHaveBeenCalledWith("/mcp");
            
            // Verify that the serve method returned a fetch function that was called
            const mockServeReturn = mockMcpServer.serve();
            expect(mockServeReturn.fetch).toHaveBeenCalledWith(request, mockEnv, mockCtx);
            
            // Verify the response
            expect(result.status).toBe(200);
            expect(await result.text()).toBe("MCP Response");
        });

        it("should route /bearer/sse to MCP server SSE and call serveSSE method", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/sse", {
                headers: {
                    "authorization": "Bearer test-token@test.thoughtspot.cloud",
                    "x-ts-client-name": "Test Client"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);
            
            // Verify that the MCP server's serveSSE method was called with the correct path
            expect(mockMcpServer.serveSSE).toHaveBeenCalledWith("/sse");
            
            // Verify that the serveSSE method returned a fetch function that was called
            const mockServeSSEReturn = mockMcpServer.serveSSE();
            expect(mockServeSSEReturn.fetch).toHaveBeenCalledWith(request, mockEnv, mockCtx);
            
            // Verify the response
            expect(result.status).toBe(200);
            expect(await result.text()).toBe("SSE Response");
        });

        it("should set context properties correctly when routing to MCP server", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-access-token@https://my-instance.thoughtspot.cloud",
                    "x-ts-client-name": "Custom Test Client"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);
            
            // Verify that the MCP server's serve method was called
            expect(mockMcpServer.serve).toHaveBeenCalledWith("/mcp");
            
            // Verify that the serve method returned a fetch function that was called
            const mockServeReturn = mockMcpServer.serve();
            expect(mockServeReturn.fetch).toHaveBeenCalledWith(request, mockEnv, mockCtx);
            
            // Verify that the context properties were set correctly
            expect(mockCtx.props).toEqual({
                accessToken: "my-access-token",
                instanceUrl: "https://my-instance.thoughtspot.cloud",
                clientName: "Custom Test Client"
            });
            
            // Verify the response
            expect(result.status).toBe(200);
            expect(await result.text()).toBe("MCP Response");
        });

        it("should set default client name when x-ts-client-name is not provided", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-access-token@https://my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);
            
            // Verify that the context properties were set correctly with default client name
            expect(mockCtx.props).toEqual({
                accessToken: "my-access-token",
                instanceUrl: "https://my-instance.thoughtspot.cloud",
                clientName: "Bearer Token client"
            });
            
            // Verify the response
            expect(result.status).toBe(200);
            expect(await result.text()).toBe("MCP Response");
        });
    });

    describe("Authorization Header Parsing", () => {
        it("should return 400 when authorization header is missing", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp");
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            expect(result.status).toBe(400);
            expect(await result.text()).toBe("Bearer token is required");
        });

        it("should parse token and host from authorization header with @ separator", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-token@my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should not return 400 for missing host
            expect(result.status).not.toBe(400);
        });

        it("should use x-ts-host header when token doesn't contain @ separator", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-token",
                    "x-ts-host": "my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should not return 400 for missing host
            expect(result.status).not.toBe(400);
        });

        it("should return 400 when neither @ separator nor x-ts-host header is provided", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-token"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            expect(result.status).toBe(400);
            expect(await result.text()).toBe("TS Host is required, either in the authorization header as 'token@ts-host' or as a separate 'x-ts-host' header");
        });
    });

    describe("Client Name Handling", () => {
        it("should use provided x-ts-client-name header", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-token@my-instance.thoughtspot.cloud",
                    "x-ts-client-name": "Custom Client Name"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should not return 400 for missing client name
            expect(result.status).not.toBe(400);
        });

        it("should use default client name when x-ts-client-name is not provided", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-token@my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should not return 400 for missing client name
            expect(result.status).not.toBe(400);
        });
    });

    describe("URL Validation", () => {
        it("should validate and sanitize the TS host URL", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-token@https://my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should not return 400 for invalid URL
            expect(result.status).not.toBe(400);
        });

        it("should handle URLs without protocol", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-token@my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should not return 400 for URL without protocol
            expect(result.status).not.toBe(400);
        });
    });

    describe("Endpoint Routing", () => {
        it("should route /bearer/mcp to MCP server", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-token@my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should be handled by MCP server (not return 404)
            expect(result.status).not.toBe(404);
        });

        it("should route /bearer/sse to MCP server SSE", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/sse", {
                headers: {
                    "authorization": "Bearer my-token@my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should be handled by MCP server SSE (not return 404)
            expect(result.status).not.toBe(404);
        });

        it("should return 404 for unknown endpoints under /bearer", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/unknown", {
                headers: {
                    "authorization": "Bearer my-token@my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            expect(result.status).toBe(404);
            expect(await result.text()).toBe("Not found");
        });
    });

    describe("Context Properties", () => {
        it("should set accessToken in context props", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-access-token@my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should not return 400 for missing access token
            expect(result.status).not.toBe(400);
        });

        it("should set instanceUrl in context props", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-token@https://my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should not return 400 for missing instance URL
            expect(result.status).not.toBe(400);
        });

        it("should set clientName in context props", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-token@my-instance.thoughtspot.cloud",
                    "x-ts-client-name": "Test Client"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should not return 400 for missing client name
            expect(result.status).not.toBe(400);
        });
    });

    describe("Edge Cases", () => {
        it("should handle empty token", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer @my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should not return 400 for empty token
            expect(result.status).not.toBe(400);
        });

        it("should handle malformed authorization header", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "InvalidFormat my-token@my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should handle malformed header gracefully
            expect(result.status).not.toBe(400);
        });

        it("should handle multiple @ symbols in token", async () => {
            const appWithBearer = withBearerHandler(app, ThoughtSpotMCP);
            
            const request = new Request("https://example.com/bearer/mcp", {
                headers: {
                    "authorization": "Bearer my-token@with@multiple@symbols@my-instance.thoughtspot.cloud"
                }
            });
            
            const result = await appWithBearer.fetch(request, mockEnv, mockCtx);

            // Should handle multiple @ symbols
            expect(result.status).not.toBe(400);
        });
    });
});