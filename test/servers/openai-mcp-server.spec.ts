import { describe, it, expect, vi, beforeEach } from "vitest";
import { connect } from "mcp-testing-kit";
import { OpenAIDeepResearchMCPServer } from "../../src/servers/openai-mcp-server";
import * as thoughtspotService from "../../src/thoughtspot/thoughtspot-service";
import * as thoughtspotClient from "../../src/thoughtspot/thoughtspot-client";
import { MixpanelTracker } from "../../src/metrics/mixpanel/mixpanel";

// Mock the MixpanelTracker
vi.mock("../../src/metrics/mixpanel/mixpanel", () => ({
    MixpanelTracker: vi.fn().mockImplementation(() => ({
        track: vi.fn(),
    })),
}));

describe("OpenAI Deep Research MCP Server", () => {
    let server: OpenAIDeepResearchMCPServer;
    let mockProps: any;

    beforeEach(() => {
        // Reset all mocks
        vi.clearAllMocks();

        // Mock getThoughtSpotClient
        vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
            getSessionInfo: vi.fn().mockResolvedValue({
                clusterId: "test-cluster-123",
                clusterName: "test-cluster",
                releaseVersion: "10.13.0.cl-10",
                userGUID: "test-user-123",
                configInfo: {
                    mixpanelConfig: {
                        devSdkKey: "test-dev-token",
                        prodSdkKey: "test-prod-token",
                        production: false,
                    },
                    selfClusterName: "test-cluster",
                    selfClusterId: "test-cluster-123",
                },
                userName: "test-user",
                currentOrgId: "test-org",
                privileges: [],
            }),
            singleAnswer: vi.fn().mockResolvedValue({
                session_identifier: "session-123",
                generation_number: 1,
            }),
            exportAnswerReport: vi.fn().mockResolvedValue({
                text: vi.fn().mockResolvedValue("The total revenue is $1,000,000"),
            }),
            instanceUrl: "https://test.thoughtspot.cloud",
        } as any);

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

        server = new OpenAIDeepResearchMCPServer({
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
                    releaseVersion: "10.13.0.cl-10",
                    userGUID: "test-user-123",
                    mixpanelToken: "test-dev-token",
                    userName: "test-user",
                    currentOrgId: "test-org",
                    privileges: [],
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

            expect(result.tools).toHaveLength(2);
            expect(result.tools?.map(t => t.name)).toEqual([
                "search",
                "fetch"
            ]);
        });

        it("should include correct tool descriptions", async () => {
            await server.init();
            const { listTools } = connect(server);

            const result = await listTools();

            const searchTool = result.tools?.find(t => t.name === "search");
            expect(searchTool?.description).toBe("Tool to search for relevant data queries to answer the given question based on the datasource passed to this tool, which is a datasource id, see the query description for the syntax. The datasource id is mandatory and should be passed as part of the query. Any textual question can be passed to this tool, and it will do its best to find relevant data queries to answer the question.");

            const fetchTool = result.tools?.find(t => t.name === "fetch");
            expect(fetchTool?.description).toBe("Tool to retrieve data from the retail sales dataset for a given query.");
        });

        it("should include correct input schemas", async () => {
            await server.init();
            const { listTools } = connect(server);

            const result = await listTools();

            const searchTool = result.tools?.find(t => t.name === "search");
            expect(searchTool?.inputSchema).toMatchObject({
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: expect.stringContaining("The question/task to search for relevant data queries")
                    }
                },
                required: ["query"]
            });

            const fetchTool = result.tools?.find(t => t.name === "fetch");
            expect(fetchTool?.inputSchema).toMatchObject({
                type: "object",
                properties: {
                    id: {
                        type: "string",
                        description: "The id of the search result to fetch."
                    }
                },
                required: ["id"]
            });
        });

        it("should include correct output schemas", async () => {
            await server.init();
            const { listTools } = connect(server);

            const result = await listTools();

            const searchTool = result.tools?.find(t => t.name === "search");
            expect(searchTool?.outputSchema).toMatchObject({
                type: "object",
                properties: {
                    results: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                id: {
                                    type: "string",
                                    description: "The id of the search result."
                                },
                                title: {
                                    type: "string",
                                    description: "The title of the search result."
                                },
                                text: {
                                    type: "string",
                                    description: "The text of the search result."
                                },
                                url: {
                                    type: "string",
                                    description: "The url of the search result."
                                }
                            },
                            required: ["id", "title", "text", "url"]
                        }
                    }
                },
                required: ["results"]
            });

            const fetchTool = result.tools?.find(t => t.name === "fetch");
            expect(fetchTool?.outputSchema).toMatchObject({
                type: "object",
                properties: {
                    id: {
                        type: "string",
                        description: "The id of the search result."
                    },
                    title: {
                        type: "string",
                        description: "The title of the search result."
                    },
                    text: {
                        type: "string",
                        description: "The text of the search result."
                    },
                    url: {
                        type: "string",
                        description: "The url of the search result."
                    }
                },
                required: ["id", "title", "text", "url"]
            });
        });
    });

    describe("List Resources", () => {
        it("should return empty resources list", async () => {
            await server.init();
            const { listResources } = connect(server);

            const result = await listResources();

            expect(result.resources).toHaveLength(0);
        });
    });

    describe("Read Resource", () => {
        it("should return empty contents", async () => {
            await server.init();

            // Test the protected method directly since it's abstract
            const result = await (server as any).readResource({
                method: "resources/read",
                params: { uri: "datasource:///test-id" }
            });

            expect(result.contents).toHaveLength(0);
        });
    });

    describe("Search Tool", () => {
        it("should return relevant questions for query with datasource ID", async () => {
            // Mock the ThoughtSpot service to return relevant questions
            const mockGetRelevantQuestions = vi.fn().mockResolvedValue({
                questions: [
                    { question: "What is the total revenue?" },
                    { question: "How many customers do we have?" }
                ],
                error: null
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getRelevantQuestions')
                .mockImplementation(mockGetRelevantQuestions);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("search", {
                query: "datasource:asdhshd-123123-12dd How to reduce customer churn?"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({
                results: [
                    {
                        id: "asdhshd-123123-12dd: What is the total revenue?",
                        title: "What is the total revenue?",
                        text: "What is the total revenue?",
                        url: ""
                    },
                    {
                        id: "asdhshd-123123-12dd: How many customers do we have?",
                        title: "How many customers do we have?",
                        text: "How many customers do we have?",
                        url: ""
                    }
                ]
            });
            // The text field contains the JSON stringified structured content
            expect((result.content as any[])[0].text).toContain('"results"');
            expect((result.content as any[])[0].text).toContain('"What is the total revenue?"');
        });

        it("should handle error from ThoughtSpot service", async () => {
            // Mock the ThoughtSpot service to return error
            const mockGetRelevantQuestions = vi.fn().mockResolvedValue({
                questions: [],
                error: { message: "Service unavailable" }
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getRelevantQuestions')
                .mockImplementation(mockGetRelevantQuestions);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("search", {
                query: "datasource:asdhshd-123123-12dd How to reduce customer churn?"
            });

            expect(result.isError).toBe(true);
            expect((result.content as any[])[0].text).toBe("ERROR: Service unavailable");
        });

        it("should handle empty questions response", async () => {
            // Mock the ThoughtSpot service to return empty questions
            const mockGetRelevantQuestions = vi.fn().mockResolvedValue({
                questions: [],
                error: null
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getRelevantQuestions')
                .mockImplementation(mockGetRelevantQuestions);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("search", {
                query: "datasource:asdhshd-123123-12dd How to reduce customer churn?"
            });

            expect(result.isError).toBeUndefined();
            // When no questions found, it uses createSuccessResponse, not createStructuredContentSuccessResponse
            expect((result.content as any[])[0].text).toBe("No relevant questions found");
        });

        it("should handle query without datasource ID when version < 10.13", async () => {
            // Mock version to be less than 10.13
            vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
                getSessionInfo: vi.fn().mockResolvedValue({
                    clusterId: "test-cluster-123",
                    clusterName: "test-cluster",
                    releaseVersion: "10.12.0", // Version less than 10.13
                    userGUID: "test-user-123",
                    configInfo: {
                        mixpanelConfig: {
                            devSdkKey: "test-dev-token",
                            prodSdkKey: "test-prod-token",
                            production: false,
                        },
                        selfClusterName: "test-cluster",
                        selfClusterId: "test-cluster-123",
                    },
                    userName: "test-user",
                    currentOrgId: "test-org",
                    privileges: [],
                }),
                singleAnswer: vi.fn().mockResolvedValue({
                    session_identifier: "session-123",
                    generation_number: 1,
                }),
                exportAnswerReport: vi.fn().mockResolvedValue({
                    text: vi.fn().mockResolvedValue("The total revenue is $1,000,000"),
                }),
                instanceUrl: "https://test.thoughtspot.cloud",
            } as any);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("search", {
                query: "How to reduce customer churn?"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({ results: [] });
            // The text field contains the JSON stringified structured content
            expect((result.content as any[])[0].text).toContain('"results"');
            expect((result.content as any[])[0].text).toContain('[]');
        });

        it("should use data source suggestions when version >= 10.13 and no datasource ID provided", async () => {
            // Mock the ThoughtSpot service methods
            const mockGetDataSourceSuggestions = vi.fn().mockResolvedValue([
                {
                    confidence: 0.85,
                    header: {
                        description: "Customer analytics data",
                        displayName: "Customer Data",
                        guid: "ds-suggested-123"
                    },
                    llmReasoning: "This data source contains customer information relevant to churn analysis"
                }
            ]);

            const mockGetRelevantQuestions = vi.fn().mockResolvedValue({
                questions: [
                    { question: "What is the customer retention rate?" },
                    { question: "Which customers are at risk of churning?" }
                ],
                error: null
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getDataSourceSuggestions')
                .mockImplementation(mockGetDataSourceSuggestions);
            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getRelevantQuestions')
                .mockImplementation(mockGetRelevantQuestions);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("search", {
                query: "How to reduce customer churn?"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({
                results: [
                    {
                        id: "ds-suggested-123: What is the customer retention rate?",
                        title: "What is the customer retention rate?",
                        text: "What is the customer retention rate?",
                        url: ""
                    },
                    {
                        id: "ds-suggested-123: Which customers are at risk of churning?",
                        title: "Which customers are at risk of churning?",
                        text: "Which customers are at risk of churning?",
                        url: ""
                    }
                ]
            });
        });

        it("should handle error when data source suggestions fail for version >= 10.13", async () => {
            // Mock the ThoughtSpot service methods to return empty suggestions
            const mockGetDataSourceSuggestions = vi.fn().mockResolvedValue([]);

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getDataSourceSuggestions')
                .mockImplementation(mockGetDataSourceSuggestions);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("search", {
                query: "How to reduce customer churn?"
            });

            expect(result.isError).toBe(true);
            expect((result.content as any[])[0].text).toBe("ERROR: No data source suggestions found");
        });

        it("should handle query with complex datasource ID", async () => {
            // Mock the ThoughtSpot service to return relevant questions
            const mockGetRelevantQuestions = vi.fn().mockResolvedValue({
                questions: [
                    { question: "What is the total revenue?" }
                ],
                error: null
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getRelevantQuestions')
                .mockImplementation(mockGetRelevantQuestions);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("search", {
                query: "datasource:abc-123-def-456 How to increase sales?"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({
                results: [
                    {
                        id: "abc-123-def-456: What is the total revenue?",
                        title: "What is the total revenue?",
                        text: "What is the total revenue?",
                        url: ""
                    }
                ]
            });
        });

        it("should handle query with mixed case datasource ID", async () => {
            // Mock the ThoughtSpot service to return relevant questions
            const mockGetRelevantQuestions = vi.fn().mockResolvedValue({
                questions: [
                    { question: "What is the total revenue?" }
                ],
                error: null
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getRelevantQuestions')
                .mockImplementation(mockGetRelevantQuestions);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("search", {
                query: "datasource:ABC123def How to increase sales?"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({
                results: [
                    {
                        id: "ABC123def: What is the total revenue?",
                        title: "What is the total revenue?",
                        text: "What is the total revenue?",
                        url: ""
                    }
                ]
            });
        });

        it("should handle query without datasource ID for version 10.12 (no data source suggestions)", async () => {
            // Mock version to be less than 10.13
            vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
                getSessionInfo: vi.fn().mockResolvedValue({
                    clusterId: "test-cluster-123",
                    clusterName: "test-cluster",
                    releaseVersion: "10.12.0.cl-144", // Version < 10.13
                    userGUID: "test-user-123",
                    configInfo: {
                        mixpanelConfig: {
                            devSdkKey: "test-dev-token",
                            prodSdkKey: "test-prod-token",
                            production: false,
                        },
                        selfClusterName: "test-cluster",
                        selfClusterId: "test-cluster-123",
                    },
                    userName: "test-user",
                    currentOrgId: "test-org",
                    privileges: [],
                })
            } as any);

            const versionSpecificServer = new OpenAIDeepResearchMCPServer({
                props: {
                    instanceUrl: "https://test.thoughtspot.cloud",
                    accessToken: "test-access-token",
                    clientName: {
                        clientId: "test-client-id",
                        clientName: "test-client",
                        registrationDate: Date.now(),
                    },
                },
            });

            await versionSpecificServer.init();
            const { callTool } = connect(versionSpecificServer);

            const result = await callTool("search", {
                query: "How to reduce customer churn?"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({ results: [] });
            expect((result.content as any[])[0].text).toContain('"results"');
            expect((result.content as any[])[0].text).toContain('[]');
        });

        it("should use data source suggestions for version 10.14 when no datasource ID provided", async () => {
            // Mock getDataSourceSuggestions to return a suggestion
            const mockGetDataSourceSuggestions = vi.fn().mockResolvedValue([
                {
                    confidence: 0.85,
                    header: {
                        description: 'Customer data for analysis',
                        displayName: 'Customer Data',
                        guid: 'ds-suggested-456'
                    },
                    llmReasoning: 'This data source contains customer information relevant to churn analysis'
                }
            ]);

            // Mock getRelevantQuestions to return questions for the suggested datasource
            const mockGetRelevantQuestions = vi.fn().mockResolvedValue({
                questions: [
                    { question: "What is the customer retention rate?" },
                    { question: "Which customers are at risk of churning?" }
                ],
                error: null
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getDataSourceSuggestions')
                .mockImplementation(mockGetDataSourceSuggestions);
            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getRelevantQuestions')
                .mockImplementation(mockGetRelevantQuestions);

            // Mock version to be greater than 10.13
            vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
                getSessionInfo: vi.fn().mockResolvedValue({
                    clusterId: "test-cluster-123",
                    clusterName: "test-cluster",
                    releaseVersion: "10.14.0.cl-155", // Version > 10.13
                    userGUID: "test-user-123",
                    configInfo: {
                        mixpanelConfig: {
                            devSdkKey: "test-dev-token",
                            prodSdkKey: "test-prod-token",
                            production: false,
                        },
                        selfClusterName: "test-cluster",
                        selfClusterId: "test-cluster-123",
                    },
                    userName: "test-user",
                    currentOrgId: "test-org",
                    privileges: [],
                })
            } as any);

            const versionSpecificServer = new OpenAIDeepResearchMCPServer({
                props: {
                    instanceUrl: "https://test.thoughtspot.cloud",
                    accessToken: "test-access-token",
                    clientName: {
                        clientId: "test-client-id",
                        clientName: "test-client",
                        registrationDate: Date.now(),
                    },
                },
            });

            await versionSpecificServer.init();
            const { callTool } = connect(versionSpecificServer);

            const result = await callTool("search", {
                query: "How to reduce customer churn?"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({
                results: [
                    {
                        id: "ds-suggested-456: What is the customer retention rate?",
                        title: "What is the customer retention rate?",
                        text: "What is the customer retention rate?",
                        url: ""
                    },
                    {
                        id: "ds-suggested-456: Which customers are at risk of churning?",
                        title: "Which customers are at risk of churning?",
                        text: "Which customers are at risk of churning?",
                        url: ""
                    }
                ]
            });

            // Verify that getDataSourceSuggestions was called
            expect(mockGetDataSourceSuggestions).toHaveBeenCalledWith("How to reduce customer churn?");
            // Verify that getRelevantQuestions was called with the suggested datasource
            expect(mockGetRelevantQuestions).toHaveBeenCalledWith("How to reduce customer churn?", ["ds-suggested-456"], "");
        });
    });

    describe("Fetch Tool", () => {
        it("should return answer for a valid question ID", async () => {
            // Mock the ThoughtSpot service to return answer
            const mockGetAnswerForQuestion = vi.fn().mockResolvedValue({
                data: "The total revenue is $1,000,000",
                error: null
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("fetch", {
                id: "asdhshd-123123-12dd: What is the total revenue?"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({
                id: "asdhshd-123123-12dd: What is the total revenue?",
                title: " What is the total revenue?",
                text: "The total revenue is $1,000,000",
                url: "https://test.thoughtspot.cloud/#/insights/conv-assist?query=What is the total revenue?&worksheet=asdhshd-123123-12dd&executeSearch=true"
            });
            // The text field contains the JSON stringified structured content
            expect((result.content as any[])[0].text).toContain('"id"');
            expect((result.content as any[])[0].text).toContain('"The total revenue is $1,000,000"');
        });

        it("should handle error from ThoughtSpot service", async () => {
            // Mock the ThoughtSpot service to return error
            const mockGetAnswerForQuestion = vi.fn().mockResolvedValue({
                data: null,
                error: { message: "Question not found" }
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("fetch", {
                id: "asdhshd-123123-12dd: What is the total revenue?"
            });

            expect(result.isError).toBe(true);
            expect((result.content as any[])[0].text).toBe("ERROR: Question not found");
        });

        it("should handle ID with complex datasource ID", async () => {
            // Mock the ThoughtSpot service to return answer
            const mockGetAnswerForQuestion = vi.fn().mockResolvedValue({
                data: "The total revenue is $1,000,000",
                error: null
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("fetch", {
                id: "abc-123-def-456: What is the total revenue?"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({
                id: "abc-123-def-456: What is the total revenue?",
                title: " What is the total revenue?",
                text: "The total revenue is $1,000,000",
                url: "https://test.thoughtspot.cloud/#/insights/conv-assist?query=What is the total revenue?&worksheet=abc-123-def-456&executeSearch=true"
            });
        });

        it("should handle ID with question containing special characters", async () => {
            // Mock the ThoughtSpot service to return answer
            const mockGetAnswerForQuestion = vi.fn().mockResolvedValue({
                data: "The revenue increased by 15%",
                error: null
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("fetch", {
                id: "ds-123: How much did revenue increase? (in %)"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({
                id: "ds-123: How much did revenue increase? (in %)",
                title: " How much did revenue increase? (in %)",
                text: "The revenue increased by 15%",
                url: "https://test.thoughtspot.cloud/#/insights/conv-assist?query=How much did revenue increase? (in %)&worksheet=ds-123&executeSearch=true"
            });
        });
    });

    describe("Error Handling", () => {
        it("should handle empty fetch ID", async () => {
            // Mock the ThoughtSpot service to return answer for empty ID test
            const mockGetAnswerForQuestion = vi.fn().mockResolvedValue({
                data: "The total revenue is $1,000,000",
                error: null
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("fetch", {
                id: "" // Empty ID
            });

            // Empty ID will cause the split to return ["", ""], which results in empty datasourceId and undefined question
            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({
                id: "",
                title: "",
                text: "The total revenue is $1,000,000",
                url: "https://test.thoughtspot.cloud/#/insights/conv-assist?query=&worksheet=&executeSearch=true"
            });
        });
    });
});
