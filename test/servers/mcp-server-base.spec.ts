import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPServer } from "../../src/servers/mcp-server";
import * as thoughtspotClient from "../../src/thoughtspot/thoughtspot-client";
import { MixpanelTracker } from "../../src/metrics/mixpanel/mixpanel";

// Mock the MixpanelTracker
vi.mock("../../src/metrics/mixpanel/mixpanel", () => ({
    MixpanelTracker: vi.fn().mockImplementation(() => ({
        track: vi.fn(),
    })),
}));

// Test subclass to expose protected methods
class TestMCPServer extends MCPServer {
    public testCreateMultiContentSuccessResponse(content: any[], statusMessage: string) {
        return this.createMultiContentSuccessResponse(content, statusMessage);
    }

    public testCreateArraySuccessResponse(texts: string[], statusMessage: string) {
        return this.createArraySuccessResponse(texts, statusMessage);
    }

    public testCreateErrorResponse(message: string, statusMessage?: string) {
        return this.createErrorResponse(message, statusMessage);
    }

    public testCreateSuccessResponse(message: string, statusMessage?: string) {
        return this.createSuccessResponse(message, statusMessage);
    }

    public testCreateStructuredContentSuccessResponse<T>(structuredContent: T, statusMessage: string) {
        return this.createStructuredContentSuccessResponse(structuredContent, statusMessage);
    }

    public testIsDatasourceDiscoveryAvailable() {
        return this.isDatasourceDiscoveryAvailable();
    }
}

describe("MCP Server Base", () => {
    let server: TestMCPServer;
    let mockProps: any;

    beforeEach(() => {
        vi.clearAllMocks();

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
                    enableSpotterDataSourceDiscovery: true,
                },
                userName: "test-user",
                currentOrgId: "test-org",
                privileges: [],
            }),
            searchMetadata: vi.fn().mockResolvedValue([]),
            instanceUrl: "https://test.thoughtspot.cloud",
        } as any);

        mockProps = {
            instanceUrl: "https://test.thoughtspot.cloud",
            accessToken: "test-token",
            clientName: {
                clientId: "test-client-id",
                clientName: "test-client",
                registrationDate: Date.now(),
            },
        };

        server = new TestMCPServer({ props: mockProps });
    });

    describe("Response Helper Methods", () => {
        beforeEach(async () => {
            await server.init();
        });

        it("should create multi-content success response", () => {
            const content = [
                { type: "text" as const, text: "First message" },
                { type: "text" as const, text: "Second message" },
                { type: "text" as const, text: "Third message" },
            ];

            const result = server.testCreateMultiContentSuccessResponse(content, "Multiple messages");

            expect(result.isError).toBeUndefined();
            expect(result.content).toHaveLength(3);
            expect(result.content[0].text).toBe("First message");
            expect(result.content[1].text).toBe("Second message");
            expect(result.content[2].text).toBe("Third message");
        });

        it("should create multi-content success response with empty array", () => {
            const result = server.testCreateMultiContentSuccessResponse([], "No messages");

            expect(result.isError).toBeUndefined();
            expect(result.content).toHaveLength(0);
        });

        it("should create array success response from string array", () => {
            const texts = ["Item 1", "Item 2", "Item 3"];

            const result = server.testCreateArraySuccessResponse(texts, "Array response");

            expect(result.isError).toBeUndefined();
            expect(result.content).toHaveLength(3);
            expect(result.content[0]).toEqual({ type: "text", text: "Item 1" });
            expect(result.content[1]).toEqual({ type: "text", text: "Item 2" });
            expect(result.content[2]).toEqual({ type: "text", text: "Item 3" });
        });

        it("should create array success response with empty array", () => {
            const result = server.testCreateArraySuccessResponse([], "Empty array");

            expect(result.isError).toBeUndefined();
            expect(result.content).toHaveLength(0);
        });

        it("should create array success response with single item", () => {
            const texts = ["Single item"];

            const result = server.testCreateArraySuccessResponse(texts, "Single item response");

            expect(result.isError).toBeUndefined();
            expect(result.content).toHaveLength(1);
            expect(result.content[0]).toEqual({ type: "text", text: "Single item" });
        });

        it("should create error response with message", () => {
            const result = server.testCreateErrorResponse("Something went wrong");

            expect(result.isError).toBe(true);
            expect(result.content).toHaveLength(1);
            expect(result.content[0].text).toBe("ERROR: Something went wrong");
        });

        it("should create error response with custom status message", () => {
            const result = server.testCreateErrorResponse("Error occurred", "Custom status");

            expect(result.isError).toBe(true);
            expect(result.content).toHaveLength(1);
            expect(result.content[0].text).toBe("ERROR: Error occurred");
        });

        it("should create success response with message", () => {
            const result = server.testCreateSuccessResponse("Operation successful");

            expect(result.isError).toBeUndefined();
            expect(result.content).toHaveLength(1);
            expect(result.content[0].text).toBe("Operation successful");
        });

        it("should create structured content success response", () => {
            const structuredContent = {
                items: ["a", "b", "c"],
                count: 3,
            };

            const result = server.testCreateStructuredContentSuccessResponse(
                structuredContent,
                "Structured response"
            );

            expect(result.isError).toBeUndefined();
            expect(result.content).toHaveLength(1);
            expect(result.content[0].text).toBe(JSON.stringify(structuredContent));
            expect(result.structuredContent).toEqual(structuredContent);
        });
    });

    describe("Datasource Discovery Check", () => {
        it("should return true when enableSpotterDataSourceDiscovery is enabled", async () => {
            await server.init();
            const result = server.testIsDatasourceDiscoveryAvailable();
            expect(result).toBe(true);
        });

        it("should return false when enableSpotterDataSourceDiscovery is disabled", async () => {
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
                        enableSpotterDataSourceDiscovery: false,
                    },
                    userName: "test-user",
                    currentOrgId: "test-org",
                    privileges: [],
                }),
                searchMetadata: vi.fn().mockResolvedValue([]),
                instanceUrl: "https://test.thoughtspot.cloud",
            } as any);

            const testServer = new TestMCPServer({ props: mockProps });
            await testServer.init();
            const result = testServer.testIsDatasourceDiscoveryAvailable();
            expect(result).toBe(false);
        });

        it("should return false when enableSpotterDataSourceDiscovery is undefined", async () => {
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
                        enableSpotterDataSourceDiscovery: undefined,
                    },
                    userName: "test-user",
                    currentOrgId: "test-org",
                    privileges: [],
                }),
                searchMetadata: vi.fn().mockResolvedValue([]),
                instanceUrl: "https://test.thoughtspot.cloud",
            } as any);

            const testServer = new TestMCPServer({ props: mockProps });
            await testServer.init();
            const result = testServer.testIsDatasourceDiscoveryAvailable();
            expect(result).toBe(false);
        });
    });

    describe("Server Initialization", () => {
        it("should initialize with custom server name and version", () => {
            const customServer = new TestMCPServer(
                { props: mockProps },
                "CustomServer",
                "2.0.0"
            );

            expect(customServer).toBeDefined();
        });

        it("should initialize with default server name and version", () => {
            expect(server).toBeDefined();
        });
    });
});

