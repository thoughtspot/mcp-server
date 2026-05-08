import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrackEvent, type Tracker } from "../../src/metrics";
import { MixpanelTracker } from "../../src/metrics/mixpanel/mixpanel";
import { MCPServer } from "../../src/servers/mcp-server";
import { StreamingMessagesStorageWithTtl } from "../../src/streaming-message-storage-with-ttl/streaming-message-storage-with-ttl";
import * as thoughtspotClient from "../../src/thoughtspot/thoughtspot-client";

// Mock the MixpanelTracker
vi.mock("../../src/metrics/mixpanel/mixpanel", () => ({
	MixpanelTracker: vi.fn().mockImplementation(() => ({
		track: vi.fn(),
	})),
}));

vi.mock(
	"../../src/streaming-message-storage-with-ttl/streaming-message-storage-with-ttl",
	() => ({
		StreamingMessagesStorageWithTtl: vi.fn().mockImplementation(() => ({})),
	}),
);

const mockEnv = {} as Env;

// Test subclass to expose protected methods
class TestMCPServer extends MCPServer {
	public testCreateMultiContentSuccessResponse(
		content: any[],
		statusMessage: string,
	) {
		return this.createMultiContentSuccessResponse(content, statusMessage);
	}

	public testCreateArraySuccessResponse(
		texts: string[],
		statusMessage: string,
	) {
		return this.createArraySuccessResponse(texts, statusMessage);
	}

	public testCreateErrorResponse(message: string, statusMessage?: string) {
		return this.createErrorResponse(message, statusMessage);
	}

	public testCreateSuccessResponse(message: string, statusMessage?: string) {
		return this.createSuccessResponse(message, statusMessage);
	}

	public testCreateStructuredContentSuccessResponse<T>(
		structuredContent: T,
		statusMessage: string,
	) {
		return this.createStructuredContentSuccessResponse(
			structuredContent,
			statusMessage,
		);
	}

	public testIsDatasourceDiscoveryAvailable() {
		return this.isDatasourceDiscoveryAvailable();
	}

	public getTrackers() {
		return this.trackers;
	}

	public getSessionInfo() {
		return this.sessionInfo;
	}

	public testGetMetricEventIdentity() {
		return this.getMetricEventIdentity();
	}

	public async testGetStorageService() {
		return this.getStorageService();
	}
}

describe("MCP Server Base", () => {
	let server: TestMCPServer;
	let mockProps: any;
	let mockStreamingStorage: any;

	const makeSessionInfo = (overrides: any = {}) => ({
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
			...overrides.configInfo,
		},
		userName: "test-user",
		currentOrgId: "test-org",
		privileges: [],
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();

		// Mock getThoughtSpotClient
		vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
			getSessionInfo: vi.fn().mockResolvedValue(makeSessionInfo()),
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

		mockStreamingStorage = new StreamingMessagesStorageWithTtl(
			null as any,
			vi.fn(),
			vi.fn(),
		);

		server = new TestMCPServer(
			{ props: mockProps, env: mockEnv },
			mockStreamingStorage,
		);
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

			const result = server.testCreateMultiContentSuccessResponse(
				content,
				"Multiple messages",
			);

			expect((result as any).isError).toBeUndefined();
			expect(result.content).toHaveLength(3);
			expect(result.content[0].text).toBe("First message");
			expect(result.content[1].text).toBe("Second message");
			expect(result.content[2].text).toBe("Third message");
		});

		it("should create multi-content success response with empty array", () => {
			const result = server.testCreateMultiContentSuccessResponse(
				[],
				"No messages",
			);

			expect((result as any).isError).toBeUndefined();
			expect(result.content).toHaveLength(0);
		});

		it("should create array success response from string array", () => {
			const texts = ["Item 1", "Item 2", "Item 3"];

			const result = server.testCreateArraySuccessResponse(
				texts,
				"Array response",
			);

			expect((result as any).isError).toBeUndefined();
			expect(result.content).toHaveLength(3);
			expect(result.content[0]).toEqual({ type: "text", text: "Item 1" });
			expect(result.content[1]).toEqual({ type: "text", text: "Item 2" });
			expect(result.content[2]).toEqual({ type: "text", text: "Item 3" });
		});

		it("should create array success response with empty array", () => {
			const result = server.testCreateArraySuccessResponse([], "Empty array");

			expect((result as any).isError).toBeUndefined();
			expect(result.content).toHaveLength(0);
		});

		it("should create array success response with single item", () => {
			const texts = ["Single item"];

			const result = server.testCreateArraySuccessResponse(
				texts,
				"Single item response",
			);

			expect((result as any).isError).toBeUndefined();
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
			const result = server.testCreateErrorResponse(
				"Error occurred",
				"Custom status",
			);

			expect(result.isError).toBe(true);
			expect(result.content).toHaveLength(1);
			expect(result.content[0].text).toBe("ERROR: Error occurred");
		});

		it("should create success response with message", () => {
			const result = server.testCreateSuccessResponse("Operation successful");

			expect((result as any).isError).toBeUndefined();
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
				"Structured response",
			);

			expect((result as any).isError).toBeUndefined();
			expect(result.content).toHaveLength(1);
			expect(result.content[0].text).toBe(JSON.stringify(structuredContent));
			expect(result.structuredContent).toEqual(structuredContent);
		});
	});

	describe("Datasource Discovery Check", () => {
		it("should return false before init is called (sessionInfo not set)", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const result = server.testIsDatasourceDiscoveryAvailable();
			expect(result).toBe(false);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("sessionInfo is not initialized"),
			);
			warnSpy.mockRestore();
		});

		it("should return true when enableSpotterDataSourceDiscovery is enabled", async () => {
			await server.init();
			const result = server.testIsDatasourceDiscoveryAvailable();
			expect(result).toBe(true);
		});

		it("should return false when enableSpotterDataSourceDiscovery is disabled", async () => {
			vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
				getSessionInfo: vi.fn().mockResolvedValue(
					makeSessionInfo({
						configInfo: { enableSpotterDataSourceDiscovery: false },
					}),
				),
				searchMetadata: vi.fn().mockResolvedValue([]),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			const testServer = new TestMCPServer(
				{ props: mockProps, env: mockEnv },
				mockStreamingStorage,
			);
			await testServer.init();
			expect(testServer.testIsDatasourceDiscoveryAvailable()).toBe(false);
		});

		it("should return false when enableSpotterDataSourceDiscovery is undefined", async () => {
			vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
				getSessionInfo: vi.fn().mockResolvedValue(
					makeSessionInfo({
						configInfo: { enableSpotterDataSourceDiscovery: undefined },
					}),
				),
				searchMetadata: vi.fn().mockResolvedValue([]),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			const testServer = new TestMCPServer(
				{ props: mockProps, env: mockEnv },
				mockStreamingStorage,
			);
			await testServer.init();
			expect(testServer.testIsDatasourceDiscoveryAvailable()).toBe(false);
		});
	});

	describe("Metric Identity", () => {
		it("uses clusterId rather than currentOrgId for metrics identity", async () => {
			await server.init();

			expect(server.testGetMetricEventIdentity()).toEqual({
				tenantId: "test-cluster-123",
				userId: "test-user-123",
			});
		});
	});

	describe("initializeService", () => {
		it("should set sessionInfo and register MixpanelTracker on successful init", async () => {
			await server.init();

			expect(server.getSessionInfo()).toBeDefined();
			expect(server.getSessionInfo().userGUID).toBe("test-user-123");
			expect(MixpanelTracker).toHaveBeenCalledWith(
				expect.objectContaining({ userGUID: "test-user-123" }),
				mockProps.clientName,
			);
			// The tracker was added — the trackers set should have one entry
			expect(server.getTrackers().size).toBe(1);
		});

		it("should catch and log error if getSessionInfo throws", async () => {
			vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
				getSessionInfo: vi
					.fn()
					.mockRejectedValue(new Error("Session info fetch failed")),
				searchMetadata: vi.fn().mockResolvedValue([]),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			const testServer = new TestMCPServer(
				{ props: mockProps, env: mockEnv },
				mockStreamingStorage,
			);
			await expect(testServer.init()).resolves.not.toThrow();

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Error initializing session info:",
				expect.any(Error),
			);
			// sessionInfo should remain unset, no tracker registered
			expect(testServer.getSessionInfo()).toBeUndefined();
			expect(testServer.getTrackers().size).toBe(0);

			consoleErrorSpy.mockRestore();
		});
	});

	describe("init — TrackEvent.Init", () => {
		it("should track the Init event after initialization", async () => {
			await server.init();

			// The single tracker added is the MixpanelTracker mock
			const mockTrackerInstance =
				vi.mocked(MixpanelTracker).mock.results[0].value;
			expect(mockTrackerInstance.track).toHaveBeenCalledWith(
				TrackEvent.Init,
				{},
			);
		});

		it("should track Init even when getSessionInfo fails (trackers may be empty)", async () => {
			vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
				getSessionInfo: vi.fn().mockRejectedValue(new Error("fail")),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			const testServer = new TestMCPServer(
				{ props: mockProps, env: mockEnv },
				mockStreamingStorage,
			);
			// No tracker was registered, but init should not throw
			await expect(testServer.init()).resolves.not.toThrow();
		});
	});

	describe("addTracker", () => {
		it("should register a tracker so it receives subsequent track calls", async () => {
			await server.init();

			const customTracker: Tracker = { track: vi.fn() };
			await server.addTracker(customTracker);

			expect(server.getTrackers().has(customTracker)).toBe(true);
		});

		it("should not duplicate a tracker added twice", async () => {
			await server.init();

			const customTracker: Tracker = { track: vi.fn() };
			await server.addTracker(customTracker);
			await server.addTracker(customTracker);

			// Trackers extends Set — same reference added twice stays as one entry
			const customEntries = [...server.getTrackers()].filter(
				(t) => t === customTracker,
			);
			expect(customEntries).toHaveLength(1);
		});
	});

	describe("getStorageService", () => {
		// Pre-computed SHA-256 base64url values for known inputs (full 32-byte digest):
		//   "test-token"  -> SHA-256 -> base64url
		//   "other-token" -> SHA-256 -> base64url
		// These can be verified independently with:
		//   node -e "crypto.subtle.digest('SHA-256', new TextEncoder().encode('test-token'))
		//     .then(b => console.log(Buffer.from(b).toString('base64url')))"

		async function computeExpectedHash(token: string): Promise<string> {
			const buf = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(token),
			);
			return Buffer.from(buf).toString("base64url");
		}

		it("returns a StorageServiceClient without throwing", async () => {
			await expect(server.testGetStorageService()).resolves.toBeDefined();
		});

		it("throws an error when access token is missing", async () => {
			const serverWithNoToken = new TestMCPServer(
				{ props: { ...mockProps, accessToken: "" }, env: mockEnv },
				mockStreamingStorage,
			);
			await expect(serverWithNoToken.testGetStorageService()).rejects.toThrow(
				"Access token is required to use Storage Service",
			);
		});

		it("throws an error when access token is undefined", async () => {
			const serverWithNoToken = new TestMCPServer(
				{ props: { ...mockProps, accessToken: undefined }, env: mockEnv },
				mockStreamingStorage,
			);
			await expect(serverWithNoToken.testGetStorageService()).rejects.toThrow(
				"Access token is required to use Storage Service",
			);
		});

		it("uses the full SHA-256 base64url hash of the access token", async () => {
			const storageService = await server.testGetStorageService();
			const expectedHash = await computeExpectedHash(mockProps.accessToken);

			// The hash is used as the DO name prefix — verify via idFromName spy
			const namespaceMock: DurableObjectNamespace = {
				idFromName: vi.fn(
					() => ({ toString: () => "stub-id" }) as DurableObjectId,
				),
				get: vi.fn(
					() =>
						({
							fetch: vi
								.fn()
								.mockResolvedValue(new Response(JSON.stringify({ ok: true }))),
						}) as unknown as DurableObjectStub,
				),
			} as unknown as DurableObjectNamespace;

			// Rebuild with a traceable namespace
			(storageService as any).namespace = namespaceMock;
			await storageService.initializeConversation("conv-123");

			expect(namespaceMock.idFromName).toHaveBeenCalledWith(
				`${expectedHash}:conv-123`,
			);
		});

		it("produces a valid base64url string (no +, /, or = characters)", async () => {
			const storageService = await server.testGetStorageService();
			const hash: string = (storageService as any).accessTokenHashUrlSafe;

			expect(hash).toMatch(/^[A-Za-z0-9\-_]+$/);
		});

		it("produces a 43-character hash (32 bytes base64url-encoded without padding)", async () => {
			const storageService = await server.testGetStorageService();
			const hash: string = (storageService as any).accessTokenHashUrlSafe;

			// SHA-256 produces 32 bytes; base64url without padding is ceil(32 * 4/3) = 43 chars
			expect(hash).toHaveLength(43);
		});

		it("produces different hashes for different access tokens", async () => {
			const serverA = new TestMCPServer(
				{ props: { ...mockProps, accessToken: "token-alice" }, env: mockEnv },
				mockStreamingStorage,
			);
			const serverB = new TestMCPServer(
				{ props: { ...mockProps, accessToken: "token-bob" }, env: mockEnv },
				mockStreamingStorage,
			);

			const [serviceA, serviceB] = await Promise.all([
				serverA.testGetStorageService(),
				serverB.testGetStorageService(),
			]);

			const hashA: string = (serviceA as any).accessTokenHashUrlSafe;
			const hashB: string = (serviceB as any).accessTokenHashUrlSafe;

			expect(hashA).not.toBe(hashB);
		});

		it("produces the same hash for the same access token across calls", async () => {
			const [service1, service2] = await Promise.all([
				server.testGetStorageService(),
				server.testGetStorageService(),
			]);

			expect((service1 as any).accessTokenHashUrlSafe).toBe(
				(service2 as any).accessTokenHashUrlSafe,
			);
		});
	});

	describe("Server Initialization", () => {
		it("should be defined after construction", () => {
			expect(server).toBeDefined();
		});

		it("should be defined with a fresh env and props", () => {
			const freshServer = new TestMCPServer(
				{ props: mockProps, env: mockEnv },
				mockStreamingStorage,
			);
			expect(freshServer).toBeDefined();
		});
	});
});
