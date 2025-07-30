import { describe, it, expect, vi, beforeEach } from "vitest";
import { connect } from "mcp-testing-kit";
import { OpenAIDeepResearchMCPServer } from "../../src/servers/openai-mcp-server";
import * as thoughtspotService from "../../src/thoughtspot/thoughtspot-service";
import * as thoughtspotClient from "../../src/thoughtspot/thoughtspot-client";
import { MixpanelTracker } from "../../src/metrics/mixpanel/mixpanel";
import * as utils from "../../src/utils";

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
                releaseVersion: "1.0.0",
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
                    releaseVersion: "1.0.0",
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

        it("should handle query without datasource ID", async () => {
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
    });

    describe("Fetch Tool", () => {
        it("should return answer for a valid question ID", async () => {
            // Mock the ThoughtSpot service to return answer
            const mockGetAnswerForQuestion = vi.fn().mockResolvedValue({
                data: "The total revenue is $1,000,000",
                error: null,
                session_identifier: "session-123",
                generation_number: 1
            });

            const mockGetAnswerImagePNG = vi.fn().mockResolvedValue({
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);
            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerImagePNG')
                .mockImplementation(mockGetAnswerImagePNG);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("fetch", {
                id: "asdhshd-123123-12dd: What is the total revenue?"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({
                id: "asdhshd-123123-12dd: What is the total revenue?",
                title: " What is the total revenue?",
                text: `Data: The total revenue is $1,000,000

        **CHART VISUALIZATION AVAILABLE:**
        There is a data visualization chart for this query available at: "".

        This URL contains a PNG image showing the visual representation of the above data for the question: " What is the total revenue?". 
        Please fetch and display this image to provide a complete analysis with both the data and its visual representation. `,
                url: "https://test.thoughtspot.cloud/#/insights/conv-assist?query=What is the total revenue?&worksheet=asdhshd-123123-12dd&executeSearch=true"
            });
            // The text field contains the JSON stringified structured content
            expect((result.content as any[])[0].text).toContain('"id"');
            expect((result.content as any[])[0].text).toContain('Data: The total revenue is $1,000,000');
        });

        it("should handle error from ThoughtSpot service", async () => {
            // Mock the ThoughtSpot service to return error
            const mockGetAnswerForQuestion = vi.fn().mockResolvedValue({
                data: null,
                error: { message: "Question not found" },
                session_identifier: "session-123",
                generation_number: 1
            });

            const mockGetAnswerImagePNG = vi.fn().mockResolvedValue({
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);
            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerImagePNG')
                .mockImplementation(mockGetAnswerImagePNG);

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
                error: null,
                session_identifier: "session-123",
                generation_number: 1
            });

            const mockGetAnswerImagePNG = vi.fn().mockResolvedValue({
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);
            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerImagePNG')
                .mockImplementation(mockGetAnswerImagePNG);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("fetch", {
                id: "abc-123-def-456: What is the total revenue?"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({
                id: "abc-123-def-456: What is the total revenue?",
                title: " What is the total revenue?",
                text: `Data: The total revenue is $1,000,000

        **CHART VISUALIZATION AVAILABLE:**
        There is a data visualization chart for this query available at: "".

        This URL contains a PNG image showing the visual representation of the above data for the question: " What is the total revenue?". 
        Please fetch and display this image to provide a complete analysis with both the data and its visual representation. `,
                url: "https://test.thoughtspot.cloud/#/insights/conv-assist?query=What is the total revenue?&worksheet=abc-123-def-456&executeSearch=true"
            });
        });

        it("should handle ID with question containing special characters", async () => {
            // Mock the ThoughtSpot service to return answer
            const mockGetAnswerForQuestion = vi.fn().mockResolvedValue({
                data: "The revenue increased by 15%",
                error: null,
                session_identifier: "session-123",
                generation_number: 1
            });

            const mockGetAnswerImagePNG = vi.fn().mockResolvedValue({
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);
            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerImagePNG')
                .mockImplementation(mockGetAnswerImagePNG);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("fetch", {
                id: "ds-123: How much did revenue increase? (in %)"
            });

            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual({
                id: "ds-123: How much did revenue increase? (in %)",
                title: " How much did revenue increase? (in %)",
                text: `Data: The revenue increased by 15%

        **CHART VISUALIZATION AVAILABLE:**
        There is a data visualization chart for this query available at: "".

        This URL contains a PNG image showing the visual representation of the above data for the question: " How much did revenue increase? (in %)". 
        Please fetch and display this image to provide a complete analysis with both the data and its visual representation. `,
                url: "https://test.thoughtspot.cloud/#/insights/conv-assist?query=How much did revenue increase? (in %)&worksheet=ds-123&executeSearch=true"
            });
        });

        it("should generate token and store in KV when OAUTH_KV is available", async () => {
            // Mock the ThoughtSpot service to return answer
            const mockGetAnswerForQuestion = vi.fn().mockResolvedValue({
                data: "The total revenue is $1,000,000",
                error: null,
                session_identifier: "session-123",
                generation_number: 1
            });

            const mockGetAnswerImagePNG = vi.fn().mockResolvedValue({
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
            });

            // Mock putInKV
            const mockPutInKV = vi.fn().mockResolvedValue(undefined);
            vi.spyOn(utils, 'putInKV').mockImplementation(mockPutInKV);

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);
            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerImagePNG')
                .mockImplementation(mockGetAnswerImagePNG);

            // Mock crypto.randomUUID
            const mockToken = "test-token-123";
            vi.spyOn(crypto, 'randomUUID').mockReturnValue(mockToken);

            // Create server with environment that includes OAUTH_KV
            const mockEnv = {
                OAUTH_KV: {} as any,
                HONEYCOMB_API_KEY: "test-key",
                HONEYCOMB_DATASET: "test-dataset", 
                HOST_NAME: "https://test-host.com",
                MCP_OBJECT: {} as any,
                OPENAI_DEEP_RESEARCH_MCP_OBJECT: {} as any,
                ANALYTICS: {} as any,
                ASSETS: {} as any
            };

            // Update mockProps to include hostName
            const mockPropsWithHost = {
                ...mockProps,
                hostName: "https://test-host.com"
            };

            const serverWithKV = new OpenAIDeepResearchMCPServer({
                props: mockPropsWithHost,
                env: mockEnv
            });

            await serverWithKV.init();
            const { callTool } = connect(serverWithKV);

            const result = await callTool("fetch", {
                id: "test-ds: What is the total revenue?"
            });

            expect(result.isError).toBeUndefined();
            
            // Verify token generation and storage
            expect(crypto.randomUUID).toHaveBeenCalled();
            expect(mockPutInKV).toHaveBeenCalledWith(
                mockToken,
                {
                    sessionId: "session-123",
                    generationNo: 1,
                    instanceURL: mockPropsWithHost.instanceUrl,
                    accessToken: mockPropsWithHost.accessToken
                },
                mockEnv
            );

            // Verify the content includes visualization message with correct URL
            const structuredContent = result.structuredContent as any;
            expect(structuredContent.text).toContain("**CHART VISUALIZATION AVAILABLE:**");
            expect(structuredContent.text).toContain(`https://test-host.com/data/img?uniqueId=${mockToken}`);
            expect(structuredContent.text).toContain("Data: The total revenue is $1,000,000");
            expect(structuredContent.text).toContain("What is the total revenue?");
        });

        it("should not generate token when OAUTH_KV is not available", async () => {
            // Mock the ThoughtSpot service to return answer
            const mockGetAnswerForQuestion = vi.fn().mockResolvedValue({
                data: "The total revenue is $1,000,000",
                error: null,
                session_identifier: "session-123",
                generation_number: 1
            });

            const mockGetAnswerImagePNG = vi.fn().mockResolvedValue({
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
            });

            // Mock putInKV
            const mockPutInKV = vi.fn().mockResolvedValue(undefined);
            vi.spyOn(utils, 'putInKV').mockImplementation(mockPutInKV);

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);
            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerImagePNG')
                .mockImplementation(mockGetAnswerImagePNG);

            // Mock crypto.randomUUID
            vi.spyOn(crypto, 'randomUUID').mockReturnValue("test-token-123");

            // Create server without OAUTH_KV in environment
            const mockEnvWithoutKV = {
                OAUTH_KV: undefined as any,
                HONEYCOMB_API_KEY: "test-key",
                HONEYCOMB_DATASET: "test-dataset", 
                HOST_NAME: "https://test-host.com",
                MCP_OBJECT: {} as any,
                OPENAI_DEEP_RESEARCH_MCP_OBJECT: {} as any,
                ANALYTICS: {} as any,
                ASSETS: {} as any
            };

            const serverWithoutKV = new OpenAIDeepResearchMCPServer({
                props: mockProps,
                env: mockEnvWithoutKV
            });

            await serverWithoutKV.init();
            const { callTool } = connect(serverWithoutKV);

            const result = await callTool("fetch", {
                id: "test-ds: What is the total revenue?"
            });

            expect(result.isError).toBeUndefined();
            
            // Verify token generation and storage were NOT called
            expect(crypto.randomUUID).not.toHaveBeenCalled();
            expect(mockPutInKV).not.toHaveBeenCalled();

            // Verify the content includes visualization message but with empty URL
            const structuredContent = result.structuredContent as any;
            expect(structuredContent.text).toContain("**CHART VISUALIZATION AVAILABLE:**");
            expect(structuredContent.text).toContain('There is a data visualization chart for this query available at: "".');
            expect(structuredContent.text).toContain("Data: The total revenue is $1,000,000");
        });

        it("should not generate token when answer has error", async () => {
            // Mock the ThoughtSpot service to return error
            const mockGetAnswerForQuestion = vi.fn().mockResolvedValue({
                data: null,
                error: { message: "Service error" },
                session_identifier: "session-123",
                generation_number: 1
            });

            const mockGetAnswerImagePNG = vi.fn().mockResolvedValue({
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
            });

            // Mock putInKV
            const mockPutInKV = vi.fn().mockResolvedValue(undefined);
            vi.spyOn(utils, 'putInKV').mockImplementation(mockPutInKV);

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);
            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerImagePNG')
                .mockImplementation(mockGetAnswerImagePNG);

            // Mock crypto.randomUUID
            vi.spyOn(crypto, 'randomUUID').mockReturnValue("test-token-123");

            // Create server with environment that includes OAUTH_KV
            const mockEnv = {
                OAUTH_KV: {} as any,
                HONEYCOMB_API_KEY: "test-key",
                HONEYCOMB_DATASET: "test-dataset", 
                HOST_NAME: "https://test-host.com",
                MCP_OBJECT: {} as any,
                OPENAI_DEEP_RESEARCH_MCP_OBJECT: {} as any,
                ANALYTICS: {} as any,
                ASSETS: {} as any
            };

            const serverWithKV = new OpenAIDeepResearchMCPServer({
                props: mockProps,
                env: mockEnv
            });

            await serverWithKV.init();
            const { callTool } = connect(serverWithKV);

            const result = await callTool("fetch", {
                id: "test-ds: What is the total revenue?"
            });

            expect(result.isError).toBe(true);
            
            // Verify token generation and storage were NOT called because of error
            expect(crypto.randomUUID).not.toHaveBeenCalled();
            expect(mockPutInKV).not.toHaveBeenCalled();
        });
    });

    describe("Error Handling", () => {
        it("should handle empty fetch ID", async () => {
            // Mock the ThoughtSpot service to return answer for empty ID test
            const mockGetAnswerForQuestion = vi.fn().mockResolvedValue({
                data: "The total revenue is $1,000,000",
                error: null,
                session_identifier: "session-123",
                generation_number: 1
            });

            const mockGetAnswerImagePNG = vi.fn().mockResolvedValue({
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
            });

            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerForQuestion')
                .mockImplementation(mockGetAnswerForQuestion);
            vi.spyOn(thoughtspotService.ThoughtSpotService.prototype, 'getAnswerImagePNG')
                .mockImplementation(mockGetAnswerImagePNG);

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
                text: `Data: The total revenue is $1,000,000

        **CHART VISUALIZATION AVAILABLE:**
        There is a data visualization chart for this query available at: "".

        This URL contains a PNG image showing the visual representation of the above data for the question: "". 
        Please fetch and display this image to provide a complete analysis with both the data and its visual representation. `,
                url: "https://test.thoughtspot.cloud/#/insights/conv-assist?query=&worksheet=&executeSearch=true"
            });
        });
    });
});
