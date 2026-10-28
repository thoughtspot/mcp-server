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

describe("spotter-3-client", () => {
	const mockInstanceUrl = "https://test.thoughtspot.com";
	const mockBearerToken = "test-token-123";

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

	describe("createAgentConversationWithAutoMode", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		it("should create an agent conversation without a data source successfully", async () => {
			const mockConversation = { conversation_id: "conv-123" };

			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue(mockConversation),
			});

			const result = await client.createAgentConversationWithAutoMode({
				isSpotterDataSourceDiscoveryEnabled: true,
				isSpotterChatHistoryEnabled: false,
			});

			expect(fetch).toHaveBeenCalledWith(
				`${mockInstanceUrl}/conversation/v2/`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
						"user-agent": "ThoughtSpot-ts-client",
						Authorization: `Bearer ${mockBearerToken}`,
					},
					body: expect.any(String),
				},
			);

			const fetchCall = (fetch as any).mock.calls[0];
			const body = JSON.parse(fetchCall[1].body);
			expect(body.context).toEqual({ type: "empty" });
			expect(body.conv_settings.enable_search_datasets).toBe(true);
			expect(body.conv_settings.enable_auto_select_dataset).toBe(true);

			expect(result).toEqual(mockConversation);
			expect(result.conversation_id).toBe("conv-123");
		});

		it("should create an agent conversation with a data source successfully", async () => {
			const mockConversation = { conversation_id: "conv-456" };
			const dataSourceId = "worksheet-guid-789";

			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue(mockConversation),
			});

			const result = await client.createAgentConversationWithAutoMode({
				isSpotterDataSourceDiscoveryEnabled: true,
				isSpotterChatHistoryEnabled: false,
				dataSourceId,
			});

			const fetchCall = (fetch as any).mock.calls[0];
			const body = JSON.parse(fetchCall[1].body);
			expect(body.context).toEqual({
				type: "worksheet",
				worksheet_context: { worksheet_id: dataSourceId },
			});
			expect(body.conv_settings.enable_search_datasets).toBe(false);
			expect(body.conv_settings.enable_auto_select_dataset).toBe(false);

			expect(result).toEqual(mockConversation);
			expect(result.conversation_id).toBe("conv-456");
		});

		it("should include correct conv_settings in the request body", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ conversation_id: "conv-789" }),
			});

			await client.createAgentConversationWithAutoMode({
				isSpotterDataSourceDiscoveryEnabled: true,
				isSpotterChatHistoryEnabled: false,
			});

			const fetchCall = (fetch as any).mock.calls[0];
			const body = JSON.parse(fetchCall[1].body);
			expect(body.conv_settings).toEqual({
				enable_nls: true,
				enable_why: true,
				enable_spotql: false,
				save_chat_enabled: false,
				enable_tool_permissions: false,
				enable_search_datasets: true,
				enable_auto_select_dataset: true,
				tags: ["mcp-server"],
			});
		});

		it("should handle HTTP error responses", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 401,
				text: vi.fn().mockResolvedValue("Unauthorized"),
			});

			await expect(
				client.createAgentConversationWithAutoMode({}),
			).rejects.toMatchObject({
				status: 401,
				message: "createAgentConversationWithAutoMode failed with status 401",
			});
		});

		it("should handle network errors", async () => {
			(fetch as any).mockRejectedValue(new Error("Network error"));

			await expect(
				client.createAgentConversationWithAutoMode({}),
			).rejects.toThrow("Network error");
		});

		it("should use correct headers", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ conversation_id: "conv-123" }),
			});

			await client.createAgentConversationWithAutoMode({});

			const fetchCall = (fetch as any).mock.calls[0];
			const headers = fetchCall[1].headers;
			expect(headers["Content-Type"]).toBe("application/json");
			expect(headers.Accept).toBe("application/json");
			expect(headers["user-agent"]).toBe("ThoughtSpot-ts-client");
			expect(headers.Authorization).toBe(`Bearer ${mockBearerToken}`);
		});
	});

	describe("streamAgentConversationMessage", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		it("should send conversation message streaming successfully", async () => {
			const mockResponse = {
				ok: true,
			};

			(fetch as any).mockResolvedValue(mockResponse);
			const originalMathRandom = Math.random;
			const mockMathRandom = vi.fn().mockReturnValue(0.123456789);
			const mathObject = Math as typeof Math & { random: typeof Math.random };
			mathObject.random = mockMathRandom;

			try {
				const result = await client.streamAgentConversationMessage({
					conversation_identifier: "foo",
					message: "bar",
				});

				expect(fetch).toHaveBeenCalledWith(
					`${mockInstanceUrl}/conversation/v2/foo/query`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "text/event-stream",
							"user-agent": "ThoughtSpot-ts-client",
							Authorization: `Bearer ${mockBearerToken}`,
						},
						body: expect.any(String),
					},
				);

				const fetchCall = (fetch as any).mock.calls[0];
				const body = JSON.parse(fetchCall[1].body);
				expect(body.mode).toBe("spotter");
				expect(body.id).toEqual(expect.any(String));
				expect(body.messages).toEqual([
					{
						type: "text",
						id: expect.any(String),
						value: "bar",
					},
				]);

				expect(result).toEqual(mockResponse);
			} finally {
				mathObject.random = originalMathRandom;
			}
		});

		it("should handle fetch errors", async () => {
			const mockError = new Error("Network error");
			(fetch as any).mockRejectedValue(mockError);

			await expect(
				client.streamAgentConversationMessage({
					conversation_identifier: "foo",
					message: "bar",
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
				client.streamAgentConversationMessage({
					conversation_identifier: "foo",
					message: "bar",
				}),
			).rejects.toMatchObject({
				status: 401,
				message: "sendAgentConversationMessageStreaming failed with status 401",
			});
		});

		it("should use correct headers for send agent conversation message streaming request", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
			});
			const originalMathRandom = Math.random;
			const mathObject = Math as typeof Math & { random: typeof Math.random };
			mathObject.random = vi.fn().mockReturnValue(0.123456789);

			try {
				await client.streamAgentConversationMessage({
					conversation_identifier: "foo",
					message: "bar",
				});

				const fetchCall = (fetch as any).mock.calls[0];
				const headers = fetchCall[1].headers;

				expect(headers["Content-Type"]).toBe("application/json");
				expect(headers.Accept).toBe("text/event-stream");
				expect(headers["user-agent"]).toBe("ThoughtSpot-ts-client");
				expect(headers.Authorization).toBe(`Bearer ${mockBearerToken}`);
			} finally {
				mathObject.random = originalMathRandom;
			}
		});

		it("should generate id with exactly 12 characters using custom alphabet", async () => {
			(fetch as any).mockResolvedValue({ ok: true });

			await client.streamAgentConversationMessage({
				conversation_identifier: "conv-id",
				message: "test message",
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.id).toHaveLength(12);
		});

		it("should generate id using only allowed custom alphabet characters", async () => {
			(fetch as any).mockResolvedValue({ ok: true });

			await client.streamAgentConversationMessage({
				conversation_identifier: "conv-id",
				message: "test message",
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			const allowedChars = /^[_\-0-9a-zA-Z]+$/;
			expect(body.id).toMatch(allowedChars);
		});

		it("should generate unique ids across consecutive calls to avoid collisions", async () => {
			(fetch as any).mockResolvedValue({ ok: true });

			await client.streamAgentConversationMessage({
				conversation_identifier: "conv-id",
				message: "first message",
			});
			await client.streamAgentConversationMessage({
				conversation_identifier: "conv-id",
				message: "second message",
			});

			const id1 = JSON.parse((fetch as any).mock.calls[0][1].body).id;
			const id2 = JSON.parse((fetch as any).mock.calls[1][1].body).id;
			expect(id1).not.toBe(id2);
		});
	});
});
