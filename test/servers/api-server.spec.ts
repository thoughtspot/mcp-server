import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiServer } from "../../src/servers/api-server";
import { ThoughtSpotService } from "../../src/thoughtspot/thoughtspot-service";
import * as thoughtspotClient from "../../src/thoughtspot/thoughtspot-client";

// Mock the ThoughtSpot service and client
vi.mock("../../src/thoughtspot/thoughtspot-service");
vi.mock("../../src/thoughtspot/thoughtspot-client");

describe("API Server", () => {
    let mockClient: any;
    let mockProps: any;
    let mockServiceInstance: any;

    beforeEach(() => {
        // Reset all mocks
        vi.clearAllMocks();

        // Mock the ThoughtSpot client
        mockClient = {
            instanceUrl: "https://test.thoughtspot.cloud",
        };
        vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue(mockClient);

        // Mock ThoughtSpotService instance methods
        mockServiceInstance = {
            getRelevantQuestions: vi.fn(),
            getAnswerForQuestion: vi.fn(),
            fetchTMLAndCreateLiveboard: vi.fn(),
            getDataSources: vi.fn(),
        };

        // Mock the ThoughtSpotService constructor
        vi.mocked(ThoughtSpotService).mockImplementation(() => mockServiceInstance);

        // Mock props
        mockProps = {
            instanceUrl: "https://test.thoughtspot.cloud",
            accessToken: "test-access-token",
        };
    });

    // Helper function to create a mock execution context
    const createMockExecutionContext = (props: any) => ({
        props,
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
    });

    describe("POST /api/tools/relevant-questions", () => {
        it("should return relevant questions successfully", async () => {
            const mockQuestions = {
                questions: [
                    { question: "What is the total revenue?", datasourceId: "ds-123" },
                    { question: "How many customers?", datasourceId: "ds-456" },
                ],
                error: null,
            };

            mockServiceInstance.getRelevantQuestions.mockResolvedValue(mockQuestions);

            const requestBody = {
                query: "Show me revenue data",
                datasourceIds: ["ds-123", "ds-456"],
                additionalContext: "Previous analysis",
            };

            const request = new Request("http://localhost/api/tools/relevant-questions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data).toEqual(mockQuestions);
            expect(thoughtspotClient.getThoughtSpotClient).toHaveBeenCalledWith(
                mockProps.instanceUrl,
                mockProps.accessToken
            );
            expect(mockServiceInstance.getRelevantQuestions).toHaveBeenCalledWith(
                requestBody.query,
                requestBody.datasourceIds,
                requestBody.additionalContext
            );
        });

        it("should handle missing additionalContext", async () => {
            const mockQuestions = {
                questions: [{ question: "What is the total revenue?", datasourceId: "ds-123" }],
                error: null,
            };

            mockServiceInstance.getRelevantQuestions.mockResolvedValue(mockQuestions);

            const requestBody = {
                query: "Show me revenue data",
                datasourceIds: ["ds-123"],
            };

            const request = new Request("http://localhost/api/tools/relevant-questions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data).toEqual(mockQuestions);
            expect(mockServiceInstance.getRelevantQuestions).toHaveBeenCalledWith(
                requestBody.query,
                requestBody.datasourceIds,
                ""
            );
        });
    });

    describe("POST /api/tools/get-answer", () => {
        it("should return answer successfully", async () => {
            const mockAnswer = {
                question: "What is the total revenue?",
                data: "The total revenue is $1,000,000",
                session_identifier: "session-123",
                generation_number: 1,
                tml: null,
                error: null,
                message_type: "TSAnswer",
            } as any;

            mockServiceInstance.getAnswerForQuestion.mockResolvedValue(mockAnswer);

            const requestBody = {
                question: "What is the total revenue?",
                datasourceId: "ds-123",
            };

            const request = new Request("http://localhost/api/tools/get-answer", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data).toEqual(mockAnswer);
            expect(thoughtspotClient.getThoughtSpotClient).toHaveBeenCalledWith(
                mockProps.instanceUrl,
                mockProps.accessToken
            );
            expect(mockServiceInstance.getAnswerForQuestion).toHaveBeenCalledWith(
                requestBody.question,
                requestBody.datasourceId,
                false
            );
        });
    });

    describe("POST /api/tools/create-liveboard", () => {
        it("should create liveboard successfully", async () => {
            const mockLiveboardUrl = "https://test.thoughtspot.cloud/#/pinboard/liveboard-123";

            mockServiceInstance.fetchTMLAndCreateLiveboard.mockResolvedValue({ url: mockLiveboardUrl });

            const requestBody = {
                name: "Revenue Dashboard",
                answers: [
                    {
                        question: "What is the total revenue?",
                        session_identifier: "session-123",
                        generation_number: 1,
                    },
                ],
            };

            const request = new Request("http://localhost/api/tools/create-liveboard", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

            expect(response.status).toBe(200);
            const data = await response.text();
            expect(data).toBe(mockLiveboardUrl);
            expect(thoughtspotClient.getThoughtSpotClient).toHaveBeenCalledWith(
                mockProps.instanceUrl,
                mockProps.accessToken
            );
            expect(mockServiceInstance.fetchTMLAndCreateLiveboard).toHaveBeenCalledWith(
                requestBody.name,
                requestBody.answers
            );
        });

        it("should handle service errors", async () => {
            const mockError = new Error("Failed to create liveboard");

            mockServiceInstance.fetchTMLAndCreateLiveboard.mockRejectedValue(mockError);

            const requestBody = {
                name: "Revenue Dashboard",
                answers: [
                    {
                        question: "What is the total revenue?",
                        session_identifier: "session-123",
                        generation_number: 1,
                    },
                ],
            };

            const request = new Request("http://localhost/api/tools/create-liveboard", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

            // The endpoint should return a 500 error when the service throws
            expect(response.status).toBe(500);
        });
    });

    describe("GET /api/resources/datasources", () => {
        it("should return datasources successfully", async () => {
            const mockDatasources = [
                {
                    name: "Sales Data",
                    id: "ds-123",
                    description: "Sales data for analysis",
                },
                {
                    name: "Customer Data",
                    id: "ds-456",
                    description: "Customer information",
                },
            ];

            mockServiceInstance.getDataSources.mockResolvedValue(mockDatasources);

            const request = new Request("http://localhost/api/resources/datasources", {
                method: "GET",
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data).toEqual(mockDatasources);
            expect(thoughtspotClient.getThoughtSpotClient).toHaveBeenCalledWith(
                mockProps.instanceUrl,
                mockProps.accessToken
            );
            expect(mockServiceInstance.getDataSources).toHaveBeenCalledWith();
        });

        it("should handle service errors", async () => {
            const mockError = new Error("Failed to fetch datasources");

            mockServiceInstance.getDataSources.mockRejectedValue(mockError);

            const request = new Request("http://localhost/api/resources/datasources", {
                method: "GET",
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

            // The endpoint should return a 500 error when the service throws
            expect(response.status).toBe(500);
        });
    });

    describe("POST /api/rest/2.0/*", () => {
        it("should proxy POST requests to ThoughtSpot API", async () => {
            const mockFetchResponse = {
                status: 200,
                json: () => Promise.resolve({ success: true }),
            };

            global.fetch = vi.fn().mockResolvedValue(mockFetchResponse);

            const requestBody = { test: "data" };

            const request = new Request("http://localhost/api/rest/2.0/test-endpoint", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

            expect(response.status).toBe(200);
            expect(global.fetch).toHaveBeenCalledWith(
                `${mockProps.instanceUrl}/api/rest/2.0/test-endpoint`,
                {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${mockProps.accessToken}`,
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "User-Agent": "ThoughtSpot-ts-client",
                    },
                    body: JSON.stringify(requestBody),
                }
            );
        });

        it("should handle fetch errors", async () => {
            global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

            const requestBody = { test: "data" };

            const request = new Request("http://localhost/api/rest/2.0/test-endpoint", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

            // The endpoint should return a 500 error when fetch throws
            expect(response.status).toBe(500);
        });
    });

    describe("GET /api/rest/2.0/*", () => {
        it("should proxy GET requests to ThoughtSpot API", async () => {
            const mockFetchResponse = {
                status: 200,
                json: () => Promise.resolve({ success: true }),
            };

            global.fetch = vi.fn().mockResolvedValue(mockFetchResponse);

            const request = new Request("http://localhost/api/rest/2.0/test-endpoint", {
                method: "GET",
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

            expect(response.status).toBe(200);
            expect(global.fetch).toHaveBeenCalledWith(
                `${mockProps.instanceUrl}/api/rest/2.0/test-endpoint`,
                {
                    method: "GET",
                    headers: {
                        "Authorization": `Bearer ${mockProps.accessToken}`,
                        "Accept": "application/json",
                        "User-Agent": "ThoughtSpot-ts-client",
                    },
                }
            );
        });

        it("should handle fetch errors", async () => {
            global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

            const request = new Request("http://localhost/api/rest/2.0/test-endpoint", {
                method: "GET",
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

            // The endpoint should return a 500 error when fetch throws
            expect(response.status).toBe(500);
        });
    });

    describe("Error handling", () => {
        it("should handle malformed JSON in request body", async () => {
            const request = new Request("http://localhost/api/tools/relevant-questions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "invalid json",
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

            // The API server returns 400 for JSON parsing errors
            expect(response.status).toBe(400);
        });

        it("should handle missing required fields", async () => {
            const requestBody = {
                // Missing required fields
            };

            const request = new Request("http://localhost/api/tools/relevant-questions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });

            const response = await apiServer.fetch(request, {
                props: mockProps,
            }, createMockExecutionContext(mockProps));

<<<<<<< HEAD
            // The endpoint should handle missing fields gracefully
            expect(response.status).toBe(200);
=======
            // The endpoint should return an error when required fields are missing
            expect(response.status).toBe(400);
>>>>>>> 33eca26 (address comments -  export tool schemas from respective servers)
        });
    });
}); 