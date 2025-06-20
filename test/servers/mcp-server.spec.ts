import { describe, it, expect, vi, beforeEach } from "vitest";
import { connect } from "mcp-testing-kit";
import { MCPServer } from "../../src/servers/mcp-server";
import * as thoughtspotService from "../../src/thoughtspot/thoughtspot-service";
import * as thoughtspotClient from "../../src/thoughtspot/thoughtspot-client";
import { MixpanelTracker } from "../../src/metrics/mixpanel/mixpanel";

// Mock the MixpanelTracker
vi.mock("../../src/metrics/mixpanel/mixpanel", () => ({
    MixpanelTracker: vi.fn().mockImplementation(() => ({
        track: vi.fn(),
    })),
}));

describe("MCP Server", () => {
    let server: MCPServer;
    let mockProps: any;

    beforeEach(() => {
        // Reset all mocks
        vi.clearAllMocks();

        // Mock getSessionInfo to return valid session info
        vi.spyOn(thoughtspotService, "getSessionInfo").mockResolvedValue({
            clusterId: "test-cluster-123",
            clusterName: "test-cluster",
            releaseVersion: "1.0.0",
            userGUID: "test-user-123",
            mixpanelToken: "test-token-123",
        } as any);

        // Mock getThoughtSpotClient
        vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({} as any);

        // Mock props with correct structure
        mockProps = {
            instanceUrl: "https://test.thoughtspot.cloud",
            accessToken: "test-access-token",
            clientName: {
                clientId: "test-client-id",
                clientName: "test-client",
                registrationDate: Date.now(),
            },
        };

        server = new MCPServer({
            props: mockProps,
        });
    });

    describe("Initialization", () => {
        it("should initialize successfully with valid props", async () => {
            await expect(server.init()).resolves.not.toThrow();
        });

        it("should track initialization event", async () => {
            await server.init();
            expect(MixpanelTracker).toHaveBeenCalledWith(
                {
                    clusterId: "test-cluster-123",
                    clusterName: "test-cluster",
                    releaseVersion: "1.0.0",
                    userGUID: "test-user-123",
                    mixpanelToken: "test-token-123",
                },
                {
                    clientId: "test-client-id",
                    clientName: "test-client",
                    registrationDate: expect.any(Number),
                }
            );
        });
    });

    describe("List Tools", () => {
        it("should return all available tools", async () => {
            await server.init();
            const { listTools } = connect(server);

            const result = await listTools();

            expect(result.tools).toHaveLength(4);
            expect(result.tools?.map(t => t.name)).toEqual([
                "ping",
                "getRelevantQuestions",
                "getAnswer",
                "createLiveboard"
            ]);
        });

        it("should include correct tool descriptions", async () => {
            await server.init();
            const { listTools } = connect(server);

            const result = await listTools();

            const pingTool = result.tools?.find(t => t.name === "ping");
            expect(pingTool?.description).toBe("Simple ping tool to test connectivity and Auth");

            const questionsTool = result.tools?.find(t => t.name === "getRelevantQuestions");
            expect(questionsTool?.description).toBe("Get relevant data questions from ThoughtSpot database");

            const answerTool = result.tools?.find(t => t.name === "getAnswer");
            expect(answerTool?.description).toBe("Get the answer to a question from ThoughtSpot database");

            const liveboardTool = result.tools?.find(t => t.name === "createLiveboard");
            expect(liveboardTool?.description).toBe("Create a liveboard from a list of answers");
        });
    });

    describe("Ping Tool", () => {
        it("should return error when not authenticated", async () => {
            const unauthenticatedServer = new MCPServer({
                props: {
                    instanceUrl: "",
                    accessToken: "",
                    clientName: {
                        clientId: "test-client-id",
                        clientName: "test-client",
                        registrationDate: Date.now(),
                    },
                },
            });
            await unauthenticatedServer.init();

            const { callTool } = connect(unauthenticatedServer);
            const result = await callTool("ping", {});

            expect(result.isError).toBe(true);
            expect((result.content as any[])[0].text).toBe("ERROR: Not authenticated");
        });

        it("should return success when authenticated", async () => {
            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("ping", {});

            expect(result.isError).toBeUndefined();
            expect((result.content as any[])[0].text).toBe("Pong");
        });
    });

    describe("Get Relevant Questions Tool", () => {
        beforeEach(() => {
            vi.spyOn(thoughtspotService, "getRelevantQuestions").mockResolvedValue({
                questions: [
                    {
                        question: "What is the total revenue?",
                        datasourceId: "ds-123",
                    },
                    {
                        question: "How many customers do we have?",
                        datasourceId: "ds-456",
                    },
                ],
                error: null,
            });
        });

        it("should return relevant questions for a query", async () => {
            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("getRelevantQuestions", {
                query: "Show me revenue data",
                datasourceIds: ["ds-123", "ds-456"],
            });

            expect(result.isError).toBeUndefined();
            expect((result.content as any[])).toHaveLength(2);
            expect((result.content as any[])[0].text).toContain("What is the total revenue?");
            expect((result.content as any[])[1].text).toContain("How many customers do we have?");
        });

        it("should handle error from service", async () => {
            vi.spyOn(thoughtspotService, "getRelevantQuestions").mockResolvedValue({
                questions: [],
                error: new Error("Service unavailable"),
            });

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("getRelevantQuestions", {
                query: "Show me revenue data",
                datasourceIds: ["ds-123"],
            });

            expect(result.isError).toBe(true);
            expect((result.content as any[])[0].text).toBe("ERROR: Service unavailable");
        });

        it("should handle empty questions response", async () => {
            vi.spyOn(thoughtspotService, "getRelevantQuestions").mockResolvedValue({
                questions: [],
                error: null,
            });

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("getRelevantQuestions", {
                query: "Show me revenue data",
                datasourceIds: ["ds-123"],
            });

            expect(result.isError).toBeUndefined();
            expect((result.content as any[])[0].text).toBe("No relevant questions found");
        });

        it("should handle optional additional context", async () => {
            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("getRelevantQuestions", {
                query: "Show me revenue data",
                datasourceIds: ["ds-123"],
                additionalContext: "Previous data showed declining trends",
            });

            expect(result.isError).toBeUndefined();
            expect(thoughtspotService.getRelevantQuestions).toHaveBeenCalledWith(
                "Show me revenue data",
                ["ds-123"],
                "Previous data showed declining trends",
                expect.any(Object)
            );
        });
    });

    describe("Get Answer Tool", () => {
        beforeEach(() => {
            vi.spyOn(thoughtspotService, "getAnswerForQuestion").mockResolvedValue({
                question: "What is the total revenue?",
                data: "The total revenue is $1,000,000",
                session_identifier: "session-123",
                generation_number: 1,
                tml: null,
                error: null,
            } as any);
        });

        it("should return answer for a question", async () => {
            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("getAnswer", {
                question: "What is the total revenue?",
                datasourceId: "ds-123",
            });

            expect(result.isError).toBeUndefined();
            expect((result.content as any[])).toHaveLength(2);
            expect((result.content as any[])[0].text).toBe("The total revenue is $1,000,000");
            expect((result.content as any[])[1].text).toContain("Question: What is the total revenue?");
            expect((result.content as any[])[1].text).toContain("Session Identifier: session-123");
            expect((result.content as any[])[1].text).toContain("Generation Number: 1");
        });

        it("should handle error from service", async () => {
            vi.spyOn(thoughtspotService, "getAnswerForQuestion").mockResolvedValue({
                error: new Error("Question not found"),
            });

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("getAnswer", {
                question: "What is the total revenue?",
                datasourceId: "ds-123",
            });

            expect(result.isError).toBe(true);
            expect((result.content as any[])[0].text).toBe("ERROR: Question not found");
        });
    });

    describe("Create Liveboard Tool", () => {
        beforeEach(() => {
            vi.spyOn(thoughtspotService, "fetchTMLAndCreateLiveboard").mockResolvedValue({
                url: "https://test.thoughtspot.cloud/liveboard/123",
                error: null,
            });
        });

        it("should create liveboard successfully", async () => {
            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("createLiveboard", {
                name: "Revenue Dashboard",
                answers: [
                    {
                        question: "What is the total revenue?",
                        session_identifier: "session-123",
                        generation_number: 1,
                    },
                ],
            });

            expect(result.isError).toBeUndefined();
            expect((result.content as any[])[0].text).toContain("Liveboard created successfully");
            expect((result.content as any[])[0].text).toContain("https://test.thoughtspot.cloud/liveboard/123");
        });

        it("should handle error from service", async () => {
            vi.spyOn(thoughtspotService, "fetchTMLAndCreateLiveboard").mockResolvedValue({
                liveboardUrl: null,
                error: new Error("Failed to create liveboard"),
            });

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("createLiveboard", {
                name: "Revenue Dashboard",
                answers: [
                    {
                        question: "What is the total revenue?",
                        session_identifier: "session-123",
                        generation_number: 1,
                    },
                ],
            });

            expect(result.isError).toBe(true);
            expect((result.content as any[])[0].text).toBe("ERROR: Failed to create liveboard");
        });
    });

    describe("List Resources", () => {
        beforeEach(() => {
            vi.spyOn(thoughtspotService, "getDataSources").mockResolvedValue([
                {
                    id: "ds-123",
                    name: "Sales Data",
                    description: "Sales data for the current year",
                },
                {
                    id: "ds-456",
                    name: "Customer Data",
                    description: "Customer information and demographics",
                },
            ]);
        });

        it("should return list of datasources as resources", async () => {
            await server.init();
            const { listResources } = connect(server);

            const result = await listResources();

            expect(result.resources).toHaveLength(2);
            expect(result.resources?.[0]).toEqual({
                uri: "datasource:///ds-123",
                name: "Sales Data",
                description: "Sales data for the current year",
                mimeType: "text/plain",
            });
            expect(result.resources?.[1]).toEqual({
                uri: "datasource:///ds-456",
                name: "Customer Data",
                description: "Customer information and demographics",
                mimeType: "text/plain",
            });
        });
    });

    describe("Caching", () => {
        it("should cache datasources after first call", async () => {
            await server.init();
            const { listResources } = connect(server);

            // First call should fetch from service
            await listResources();
            expect(thoughtspotService.getDataSources).toHaveBeenCalledTimes(1);

            // Second call should use cached data
            await listResources();
            expect(thoughtspotService.getDataSources).toHaveBeenCalledTimes(1);
        });
    });
}); 