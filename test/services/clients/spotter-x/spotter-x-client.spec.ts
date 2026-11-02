import { createBearerAuthenticationConfig } from "@thoughtspot/rest-api-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getThoughtSpotClient } from "../../../../src/services/clients/thoughtspot-client";

// Mock the ThoughtSpot REST API SDK
vi.mock("@thoughtspot/rest-api-sdk", () => ({
	createBearerAuthenticationConfig: vi.fn(),
	ThoughtSpotRestApi: vi.fn(),
}));

// Mock fetch
global.fetch = vi.fn();

describe("spotter-x-client", () => {
	const mockInstanceUrl = "https://test.thoughtspot.com";
	const mockBearerToken = "test-token-123";
	const identity = {
		tenantId: "tenant-1",
		orgId: "42",
		userId: "user-guid-1",
	};
	const expectedFuid = "tenant-1.42.user-guid-1";

	let mockConfig: any;

	beforeEach(() => {
		vi.clearAllMocks();

		// Re-assign fetch as a fresh vi.fn() so mockResolvedValue/mockRejectedValue
		// are always available (vi.restoreAllMocks in afterEach would otherwise strip
		// the mock methods from the plain vi.fn() assigned at module load time).
		global.fetch = vi.fn();

		// Setup mock config
		mockConfig = {
			middleware: [],
		};

		(createBearerAuthenticationConfig as any).mockReturnValue(mockConfig);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("createSpotterXConversation", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		it("should create a conversation without a data source successfully", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ session: { id: "session-123" } }),
			});

			const result = await client.createSpotterXConversation({
				isSpotterDataSourceDiscoveryEnabled: true,
				isSpotterChatHistoryEnabled: true,
				...identity,
			});

			expect(fetch).toHaveBeenCalledWith(
				`${mockInstanceUrl}/agents/v1/agents/spotterx/sessions`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
						"user-agent": "ThoughtSpot-ts-client",
						Authorization: `Bearer ${mockBearerToken}`,
						"x-request-id": expect.any(String),
						"x-thoughtspot-fuid": expectedFuid,
					},
					body: expect.any(String),
				},
			);

			const fetchCall = (fetch as any).mock.calls[0];
			const body = JSON.parse(fetchCall[1].body);
			expect(body.context).toBeUndefined();
			expect(body.settings_override.map.enable_dataset_search).toBe(true);

			expect(result).toEqual({ conversation_id: "session-123" });
		});

		it("should create a conversation with a data source successfully", async () => {
			const dataSourceId = "worksheet-guid-789";

			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ session: { id: "session-456" } }),
			});

			const result = await client.createSpotterXConversation({
				isSpotterDataSourceDiscoveryEnabled: true,
				isSpotterChatHistoryEnabled: true,
				dataSourceId,
				...identity,
			});

			const fetchCall = (fetch as any).mock.calls[0];
			const body = JSON.parse(fetchCall[1].body);
			expect(body.context).toEqual({ dataset_ids: [dataSourceId] });
			expect(body.settings_override.map.enable_dataset_search).toBe(false);

			expect(result).toEqual({ conversation_id: "session-456" });
		});

		it("should include correct identity and settings in the request body", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ session: { id: "session-789" } }),
			});

			await client.createSpotterXConversation({
				isSpotterDataSourceDiscoveryEnabled: false,
				isSpotterChatHistoryEnabled: false,
				...identity,
			});

			const fetchCall = (fetch as any).mock.calls[0];
			const body = JSON.parse(fetchCall[1].body);
			expect(body).toEqual({
				user_id: "user-guid-1",
				tenant_id: "tenant-1",
				org_id: "42",
				saved: false,
				settings_override: {
					map: {
						connector_tool_approvals: false,
						enable_spotql: false,
						enable_dataset_search: false,
					},
				},
			});
		});

		it("should fall back to a top-level id in the response", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ id: "session-top-level" }),
			});

			const result = await client.createSpotterXConversation(identity);

			expect(result).toEqual({ conversation_id: "session-top-level" });
		});

		it("should throw when the response has no session id", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ session: {} }),
			});

			await expect(client.createSpotterXConversation(identity)).rejects.toThrow(
				"Could not extract session id from response.",
			);
		});

		it("should handle HTTP error responses", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 401,
				text: vi.fn().mockResolvedValue("Unauthorized"),
			});

			await expect(
				client.createSpotterXConversation(identity),
			).rejects.toMatchObject({
				status: 401,
				message: "createSpotterXConversation failed with status 401",
			});
		});

		it("should handle network errors", async () => {
			(fetch as any).mockRejectedValue(new Error("Network error"));

			await expect(client.createSpotterXConversation(identity)).rejects.toThrow(
				"Network error",
			);
		});

		it("should use correct headers", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ session: { id: "session-123" } }),
			});

			// An org on the client must not add the org header; the org travels in the fuid
			const orgClient = getThoughtSpotClient(
				mockInstanceUrl,
				mockBearerToken,
				"99",
			) as any;
			await orgClient.createSpotterXConversation(identity);

			const fetchCall = (fetch as any).mock.calls[0];
			const headers = fetchCall[1].headers;
			expect(headers["Content-Type"]).toBe("application/json");
			expect(headers.Accept).toBe("application/json");
			expect(headers["user-agent"]).toBe("ThoughtSpot-ts-client");
			expect(headers.Authorization).toBe(`Bearer ${mockBearerToken}`);
			expect(headers["x-thoughtspot-fuid"]).toBe(expectedFuid);
			expect(headers).not.toHaveProperty("x-thoughtspot-orgs");
		});
	});

	describe("sendSpotterXMessageStreaming", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		it("should send conversation message streaming successfully", async () => {
			const mockResponse = {
				ok: true,
			};

			(fetch as any).mockResolvedValue(mockResponse);

			const result = await client.sendSpotterXMessageStreaming({
				conversationId: "foo",
				message: "bar",
				...identity,
			});

			expect(fetch).toHaveBeenCalledWith(
				`${mockInstanceUrl}/agents/v1/agents/spotterx/sessions/foo/query?alt=sse`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "text/event-stream",
						"user-agent": "ThoughtSpot-ts-client",
						Authorization: `Bearer ${mockBearerToken}`,
						"x-request-id": expect.any(String),
						"x-thoughtspot-fuid": expectedFuid,
					},
					body: expect.any(String),
				},
			);

			const fetchCall = (fetch as any).mock.calls[0];
			const body = JSON.parse(fetchCall[1].body);
			expect(body).toEqual({
				input: { parts: [{ text_part: { text: "bar" } }] },
				enabled_connectors: [],
				extra_headers: {
					map: {
						"x-ba-ts-host": mockInstanceUrl,
					},
				},
			});

			expect(result).toEqual(mockResponse);
		});

		it("should encode the conversation identifier in the URL", async () => {
			(fetch as any).mockResolvedValue({ ok: true });

			await client.sendSpotterXMessageStreaming({
				conversationId: "a/b?c",
				message: "bar",
				...identity,
			});

			const fetchCall = (fetch as any).mock.calls[0];
			expect(fetchCall[0]).toBe(
				`${mockInstanceUrl}/agents/v1/agents/spotterx/sessions/a%2Fb%3Fc/query?alt=sse`,
			);
		});

		it("should handle fetch errors", async () => {
			const mockError = new Error("Network error");
			(fetch as any).mockRejectedValue(mockError);

			await expect(
				client.sendSpotterXMessageStreaming({
					conversationId: "foo",
					message: "bar",
					...identity,
				}),
			).rejects.toThrow("Network error");
		});

		it("should handle HTTP error responses", async () => {
			const mockResponse = {
				ok: false,
				status: 401,
				statusText: "Unauthorized",
				text: vi.fn().mockResolvedValue("Invalid token"),
			};

			(fetch as any).mockResolvedValue(mockResponse);

			await expect(
				client.sendSpotterXMessageStreaming({
					conversationId: "foo",
					message: "bar",
					...identity,
				}),
			).rejects.toMatchObject({
				status: 401,
				message: "sendSpotterXMessageStreaming failed with status 401",
			});
		});

		it("should use correct headers for send message streaming request", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
			});

			// An org on the client must not add the org header; the org travels in the fuid
			const orgClient = getThoughtSpotClient(
				mockInstanceUrl,
				mockBearerToken,
				"99",
			) as any;
			await orgClient.sendSpotterXMessageStreaming({
				conversationId: "foo",
				message: "bar",
				...identity,
			});

			const fetchCall = (fetch as any).mock.calls[0];
			const headers = fetchCall[1].headers;

			expect(headers["Content-Type"]).toBe("application/json");
			expect(headers.Accept).toBe("text/event-stream");
			expect(headers["user-agent"]).toBe("ThoughtSpot-ts-client");
			expect(headers.Authorization).toBe(`Bearer ${mockBearerToken}`);
			expect(headers["x-thoughtspot-fuid"]).toBe(expectedFuid);
			expect(headers).not.toHaveProperty("x-thoughtspot-orgs");
		});

		it("should generate unique request ids across consecutive calls", async () => {
			(fetch as any).mockResolvedValue({ ok: true });

			await client.sendSpotterXMessageStreaming({
				conversationId: "conv-id",
				message: "first message",
				...identity,
			});
			await client.sendSpotterXMessageStreaming({
				conversationId: "conv-id",
				message: "second message",
				...identity,
			});

			const id1 = (fetch as any).mock.calls[0][1].headers["x-request-id"];
			const id2 = (fetch as any).mock.calls[1][1].headers["x-request-id"];
			expect(id1).not.toBe(id2);
		});
	});
});
