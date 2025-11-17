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

        // Remove service mocks - using real service with mocked client

        // Mock getThoughtSpotClient
        vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
            getSessionInfo: vi.fn().mockResolvedValue({
                clusterId: "test-cluster-123",
                clusterName: "test-cluster",
                releaseVersion: "10.13.0.cl-110",
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
                enableSpotterDataSourceDiscovery: true,
            }),
            searchMetadata: vi.fn().mockResolvedValue([
                {
                    metadata_header: {
                        id: "ds-123",
                        name: "Sales Data",
                        description: "Sales data for the current year",
                        type: "WORKSHEET",
                        aiAnswerGenerationDisabled: false,
                    },
                },
                {
                    metadata_header: {
                        id: "ds-456",
                        name: "Customer Data",
                        description: "Customer information and demographics",
                        type: "WORKSHEET",
                        aiAnswerGenerationDisabled: false,
                    },
                },
            ]),
            queryGetDecomposedQuery: vi.fn().mockResolvedValue({
                decomposedQueryResponse: {
                    decomposedQueries: [
                        {
                            query: "What is the total revenue?",
                            worksheetId: "ds-123",
                        },
                        {
                            query: "How many customers do we have?",
                            worksheetId: "ds-456",
                        },
                    ],
                },
            }),
            singleAnswer: vi.fn().mockResolvedValue({
                session_identifier: "session-123",
                generation_number: 1,
            }),
            exportAnswerReport: vi.fn().mockResolvedValue({
                text: vi.fn().mockResolvedValue("The total revenue is $1,000,000"),
            }),
            exportUnsavedAnswerTML: vi.fn().mockResolvedValue({
                answer: {
                    name: "Test Answer",
                },
            }),
            getAnswerSession: vi.fn().mockResolvedValue({
                sessionId: "session-123",
                genNo: 1,
                acSession: {
                    sessionId: "acSession-123",
                    genNo: 1,
                },
            }),
            importMetadataTML: vi.fn().mockResolvedValue([
                {
                    response: {
                        header: {
                            id_guid: "liveboard-123",
                        },
                    },
                },
            ]),
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
                    releaseVersion: "10.13.0.cl-110",
                    userGUID: "test-user-123",
                    mixpanelToken: "test-dev-token",
                    userName: "test-user",
                    currentOrgId: "test-org",
                    privileges: [],
                    enableSpotterDataSourceDiscovery: true,
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

            expect(result.tools).toHaveLength(5);
            expect(result.tools?.map(t => t.name)).toEqual([
                "ping",
                "getRelevantQuestions",
                "getAnswer",
                "createLiveboard",
                "getDataSourceSuggestions"
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

        it("should return 4 tools when enableSpotterDataSourceDiscovery is false", async () => {
            // Mock getThoughtSpotClient with enableSpotterDataSourceDiscovery set to false
            vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
                getSessionInfo: vi.fn().mockResolvedValue({
                    clusterId: "test-cluster-123",
                    clusterName: "test-cluster",
                    releaseVersion: "10.13.0.cl-110",
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
                    enableSpotterDataSourceDiscovery: false,
                }),
                searchMetadata: vi.fn().mockResolvedValue([]),
                instanceUrl: "https://test.thoughtspot.cloud",
            } as any);

            // Create a new server instance to pick up the new mock
            const testServer = new MCPServer({ props: mockProps });
            await testServer.init();
            const { listTools } = connect(testServer);

            const result = await listTools();

            expect(result.tools).toHaveLength(4);
            expect(result.tools?.map(t => t.name)).toEqual([
                "ping",
                "getRelevantQuestions",
                "getAnswer",
                "createLiveboard"
            ]);

            // Verify that getDataSourceSuggestions is not included
            const dataSourceTool = result.tools?.find(t => t.name === "getDataSourceSuggestions");
            expect(dataSourceTool).toBeUndefined();
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
        // Using real service with mocked client, no service method mocks needed

        it("should return relevant questions for a query", async () => {
            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("getRelevantQuestions", {
                query: "Show me revenue data",
                datasourceIds: ["ds-123", "ds-456"],
            });

            expect(result.isError).toBeUndefined();
            expect((result.structuredContent as any).questions).toHaveLength(2);
            expect((result.structuredContent as any).questions[0].question).toBe("What is the total revenue?");
            expect((result.structuredContent as any).questions[1].question).toBe("How many customers do we have?");
        });

        it("should handle error from service", async () => {
            // Mock client to return error
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
                    enableSpotterDataSourceDiscovery: true,
                }),
                queryGetDecomposedQuery: vi.fn().mockRejectedValue(new Error("Service unavailable")),
                instanceUrl: "https://test.thoughtspot.cloud",
            } as any);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("getRelevantQuestions", {
                query: "Show me revenue data",
                datasourceIds: ["ds-123"],
            });

            // When error occurs, the code returns the query as fallback (graceful degradation)
            expect(result.isError).toBeUndefined();
            const resultText = JSON.parse((result.content as any[])[0].text);
            expect(resultText.questions).toBeInstanceOf(Array);
            expect(resultText.questions[0].question).toBe("Show me revenue data");
            expect(resultText.questions[0].datasourceId).toBe("ds-123");
        });

        it("should handle empty questions response", async () => {
            // Mock client to return empty questions
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
                    enableSpotterDataSourceDiscovery: true,
                }),
                queryGetDecomposedQuery: vi.fn().mockResolvedValue({
                    decomposedQueryResponse: {
                        decomposedQueries: [],
                    },
                }),
                instanceUrl: "https://test.thoughtspot.cloud",
            } as any);

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
            expect((result.structuredContent as any).questions).toHaveLength(2);
            expect((result.structuredContent as any).questions[0].question).toBe("What is the total revenue?");
            expect((result.structuredContent as any).questions[1].question).toBe("How many customers do we have?");
        });
    });

    describe("Get Answer Tool", () => {
        // Using real service with mocked client, no service method mocks needed

        it("should return answer for a question", async () => {
            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("getAnswer", {
                question: "What is the total revenue?",
                datasourceId: "ds-123",
            });

            expect(result.isError).toBeUndefined();
            expect((result.content as any[])).toHaveLength(1);
            expect((result.structuredContent as any).question).toBe("What is the total revenue?");
            expect((result.structuredContent as any).session_identifier).toBe("session-123");
            expect((result.structuredContent as any).generation_number).toBe(1);
            expect((result.structuredContent as any).frame_url).toBe("https://test.thoughtspot.cloud/#/embed/conv-assist-answer?sessionId=session-123&genNo=1&acSessionId=acSession-123&acGenNo=1");
            expect((result.structuredContent as any).data).toBe("The total revenue is $1,000,000");
        });

        it("should handle error from service", async () => {
            // Mock client to return error
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
                    enableSpotterDataSourceDiscovery: true,
                }),
                singleAnswer: vi.fn().mockRejectedValue(new Error("Question not found")),
                instanceUrl: "https://test.thoughtspot.cloud",
            } as any);

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
        // Using real service with mocked client, no service method mocks needed

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
                noteTile: `<h2 class="theme-module__editor-h2" dir="ltr" style="text-align: center;">
                    <span style="white-space: pre-wrap;">Revenue Analysis Dashboard</span>
                </h2>
                <p class="theme-module__editor-paragraph" dir="ltr">
                    <span style="white-space: pre-wrap;">
                        This liveboard shows the total revenue for the current period. Generated on ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}
                    </span>
                </p>
                <div class="pinboard-note-tile-module__noteTileBg editor-module__bgNode"></div>`,
            });

            expect(result.isError).toBeUndefined();
            expect((result.content as any[])[0].text).toContain("Liveboard created successfully");
            expect((result.content as any[])[0].text).toContain("https://test.thoughtspot.cloud/#/pinboard/liveboard-123");
        });

        it("should handle error from service", async () => {
            // Mock client to return error
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
                    enableSpotterDataSourceDiscovery: true,
                }),
                exportUnsavedAnswerTML: vi.fn().mockResolvedValue({
                    answer: {
                        name: "Test Answer",
                    },
                }),
                importMetadataTML: vi.fn().mockRejectedValue(new Error("Failed to create liveboard")),
                instanceUrl: "https://test.thoughtspot.cloud",
            } as any);

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
                noteTile: `<h2 class="theme-module__editor-h2" dir="ltr" style="text-align: center;">
                    <span style="white-space: pre-wrap;">Revenue Analysis Dashboard</span>
                </h2>
                <p class="theme-module__editor-paragraph" dir="ltr">
                    <span style="white-space: pre-wrap;">
                        This liveboard shows the total revenue for the current period. Generated on ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}
                    </span>
                </p>
                <div class="pinboard-note-tile-module__noteTileBg editor-module__bgNode"></div>`,
            });

            expect(result.isError).toBe(true);
            expect((result.content as any[])[0].text).toBe("ERROR: Failed to create liveboard");
        });
    });

    describe("List Resources", () => {
        // Using real service with mocked client, no service method mocks needed

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

        describe("Read Resource", () => {
            it("should return resource content for valid datasource URI", async () => {
                await server.init();

                const result = await server.readResource({
                    method: "resources/read",
                    params: { uri: "datasource:///ds-123" }
                });

                expect(result.contents).toHaveLength(1);
                expect(result.contents[0]).toEqual({
                    uri: "datasource:///ds-123",
                    mimeType: "text/plain",
                    text: expect.stringContaining("Sales data for the current year"),
                });
                expect(result.contents[0].text).toContain("The id of the datasource is ds-123");
                expect(result.contents[0].text).toContain("Use ThoughtSpot's getRelevantQuestions tool");
            });

            it("should return resource content for second datasource", async () => {
                await server.init();

                const result = await server.readResource({
                    method: "resources/read",
                    params: { uri: "datasource:///ds-456" }
                });

                expect(result.contents).toHaveLength(1);
                expect(result.contents[0]).toEqual({
                    uri: "datasource:///ds-456",
                    mimeType: "text/plain",
                    text: expect.stringContaining("Customer information and demographics"),
                });
                expect(result.contents[0].text).toContain("The id of the datasource is ds-456");
                expect(result.contents[0].text).toContain("Use ThoughtSpot's getRelevantQuestions tool");
            });

            it("should throw 404 error for invalid datasource URI format", async () => {
                await server.init();

                await expect(server.readResource({
                    method: "resources/read",
                    params: { uri: "invalid-uri" }
                })).rejects.toThrow("Datasource not found");
            });

            it("should throw 400 error for URI without datasource ID", async () => {
                await server.init();

                await expect(server.readResource({
                    method: "resources/read",
                    params: { uri: "datasource:///" }
                })).rejects.toThrow("Invalid datasource uri");
            });

            it("should throw 404 error for non-existent datasource", async () => {
                await server.init();

                await expect(server.readResource({
                    method: "resources/read",
                    params: { uri: "datasource:///non-existent-id" }
                })).rejects.toThrow("Datasource not found");
            });

            it("should throw 404 error for malformed URI", async () => {
                await server.init();

                await expect(server.readResource({
                    method: "resources/read",
                    params: { uri: "datasource://" }
                })).rejects.toThrow("Datasource not found");
            });

            it("should throw 400 error for empty URI", async () => {
                await server.init();

                await expect(server.readResource({
                    method: "resources/read",
                    params: { uri: "" }
                })).rejects.toThrow("Invalid datasource uri");
            });

            it("should use cached datasources for resource lookup", async () => {
                await server.init();

                // First call should fetch from service
                await server.readResource({
                    method: "resources/read",
                    params: { uri: "datasource:///ds-123" }
                });
                const mockGetClient = vi.mocked(thoughtspotClient.getThoughtSpotClient);
                const mockClientInstance = mockGetClient.mock.results[0].value;
                expect(mockClientInstance.searchMetadata).toHaveBeenCalledTimes(1);

                // Second call should use cached data
                await server.readResource({
                    method: "resources/read",
                    params: { uri: "datasource:///ds-456" }
                });
                expect(mockClientInstance.searchMetadata).toHaveBeenCalledTimes(1);
            });
        });
    });

    describe("getDataSourceSuggestions Tool", () => {
        it("should return data source suggestions successfully", async () => {
            // Mock queryGetDataSourceSuggestions method
            vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
                getSessionInfo: vi.fn().mockResolvedValue({
                    clusterId: "test-cluster-123",
                    clusterName: "test-cluster",
                    releaseVersion: "10.13.0",
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
                    enableSpotterDataSourceDiscovery: true,
                }),
                queryGetDataSourceSuggestions: vi.fn().mockResolvedValue({
                    dataSources: [
                        {
                            confidence: 0.85,
                            header: {
                                description: "Sales data for the current year",
                                displayName: "Sales Data",
                                guid: "ds-123"
                            },
                            llmReasoning: "This data source contains sales information relevant to your query"
                        },
                        {
                            confidence: 0.75,
                            header: {
                                description: "Revenue analysis data",
                                displayName: "Revenue Data",
                                guid: "ds-456"
                            },
                            llmReasoning: "This data source contains revenue information"
                        }
                    ]
                }),
                instanceUrl: "https://test.thoughtspot.cloud",
            } as any);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("getDataSourceSuggestions", {
                query: "show me sales revenue data"
            });

            expect(result.isError).toBeUndefined();

            const suggestionsData = JSON.parse((result.content as any[])[0].text);
            expect(suggestionsData).toHaveLength(2);
            expect(suggestionsData[0]).toEqual({
                header: {
                    description: "Sales data for the current year",
                    displayName: "Sales Data",
                    guid: "ds-123"
                },
                confidence: 0.85,
                llmReasoning: "This data source contains sales information relevant to your query"
            });
            expect(suggestionsData[1]).toEqual({
                header: {
                    description: "Revenue analysis data",
                    displayName: "Revenue Data",
                    guid: "ds-456"
                },
                confidence: 0.75,
                llmReasoning: "This data source contains revenue information"
            });
        });

        it("should handle empty data source suggestions", async () => {
            // Mock empty response
            vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
                getSessionInfo: vi.fn().mockResolvedValue({
                    clusterId: "test-cluster-123",
                    clusterName: "test-cluster",
                    releaseVersion: "10.13.0",
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
                    enableSpotterDataSourceDiscovery: true,
                }),
                queryGetDataSourceSuggestions: vi.fn().mockResolvedValue({
                    dataSources: []
                }),
                instanceUrl: "https://test.thoughtspot.cloud",
            } as any);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("getDataSourceSuggestions", {
                query: "nonexistent data query"
            });

            expect(result.isError).toBe(true);
            expect((result.content as any[])[0].text).toBe("ERROR: No data source suggestions found");
        });

        it("should handle single data source suggestion", async () => {
            // Mock single suggestion response
            vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
                getSessionInfo: vi.fn().mockResolvedValue({
                    clusterId: "test-cluster-123",
                    clusterName: "test-cluster",
                    releaseVersion: "10.13.0",
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
                    enableSpotterDataSourceDiscovery: true,
                }),
                queryGetDataSourceSuggestions: vi.fn().mockResolvedValue({
                    dataSources: [
                        {
                            confidence: 0.95,
                            header: {
                                description: "Customer analytics data",
                                displayName: "Customer Data",
                                guid: "ds-789"
                            },
                            llmReasoning: "Perfect match for customer-related queries"
                        }
                    ]
                }),
                instanceUrl: "https://test.thoughtspot.cloud",
            } as any);

            await server.init();
            const { callTool } = connect(server);

            const result = await callTool("getDataSourceSuggestions", {
                query: "customer analytics"
            });

            expect(result.isError).toBeUndefined();

            const suggestionsData = JSON.parse((result.content as any[])[0].text);
            expect(suggestionsData).toHaveLength(1);
            expect(suggestionsData[0].header.guid).toBe("ds-789");
            expect(suggestionsData[0].confidence).toBe(0.95);
        });


    });

    describe("Caching", () => {
        it("should cache datasources after first call", async () => {
            await server.init();
            const { listResources } = connect(server);

            // First call should fetch from service
            await listResources();
            const mockGetClient = vi.mocked(thoughtspotClient.getThoughtSpotClient);
            const mockClientInstance = mockGetClient.mock.results[0].value;
            expect(mockClientInstance.searchMetadata).toHaveBeenCalledTimes(1);

            // Second call should use cached data
            await listResources();
            expect(mockClientInstance.searchMetadata).toHaveBeenCalledTimes(1);
        });
    });
}); 