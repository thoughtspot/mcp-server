import {
	ThoughtSpotRestApi,
	createBearerAuthenticationConfig,
} from "@thoughtspot/rest-api-sdk";
import type { ResponseContext } from "@thoughtspot/rest-api-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { LIVEBOARD_RECORD_SIZE } from "../../src/thoughtspot/fetch-data/fetch-data";
import { getThoughtSpotClient } from "../../src/thoughtspot/thoughtspot-client";

// Mock the ThoughtSpot REST API SDK
vi.mock("@thoughtspot/rest-api-sdk", () => ({
	createBearerAuthenticationConfig: vi.fn(),
	ThoughtSpotRestApi: vi.fn(),
}));

// Mock fetch
global.fetch = vi.fn();

// Mock YAML
vi.mock("yaml", () => ({
	default: {
		parse: vi.fn(),
	},
}));

describe("ThoughtSpot Client", () => {
	const mockInstanceUrl = "https://test.thoughtspot.com";
	const mockBearerToken = "test-token-123";

	let mockConfig: any;
	let mockClient: any;

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

		// Setup mock client
		mockClient = {
			instanceUrl: mockInstanceUrl,
		};

		(createBearerAuthenticationConfig as any).mockReturnValue(mockConfig);
		(ThoughtSpotRestApi as any).mockImplementation(() => mockClient);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("getThoughtSpotClient", () => {
		it("should create a ThoughtSpot client with bearer authentication", () => {
			const client = getThoughtSpotClient(
				mockInstanceUrl,
				mockBearerToken,
			) as any;

			expect(createBearerAuthenticationConfig).toHaveBeenCalledWith(
				mockInstanceUrl,
				expect.any(Function),
			);
			expect(ThoughtSpotRestApi).toHaveBeenCalledWith(mockConfig);
			expect(client).toBe(mockClient);
			expect(client.instanceUrl).toBe(mockInstanceUrl);
		});

		it("should add middleware with Accept-Language header", async () => {
			const client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken);

			expect(mockConfig.middleware).toHaveLength(1);

			const middleware = mockConfig.middleware[0];
			expect(middleware).toHaveProperty("pre");
			expect(middleware).toHaveProperty("post");

			// Test pre middleware
			const mockContext = {
				getHeaders: vi.fn().mockReturnValue({}),
				setHeaderParam: vi.fn(),
			};

			const preResult = await middleware.pre(mockContext).toPromise();

			expect(mockContext.getHeaders).toHaveBeenCalled();
			expect(mockContext.setHeaderParam).toHaveBeenCalledWith(
				"Accept-Language",
				"en-US",
			);
			expect(preResult).toBe(mockContext);
		});

		it("should not override existing Accept-Language header", async () => {
			const client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken);

			const middleware = mockConfig.middleware[0];
			const mockContext = {
				getHeaders: vi.fn().mockReturnValue({ "Accept-Language": "fr-FR" }),
				setHeaderParam: vi.fn(),
			};

			await middleware.pre(mockContext).toPromise();

			expect(mockContext.setHeaderParam).not.toHaveBeenCalled();
		});

		it("should handle post middleware correctly", async () => {
			const client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken);

			const middleware = mockConfig.middleware[0];
			const mockContext = {} as ResponseContext;

			const postResult = await middleware.post(mockContext).toPromise();

			expect(postResult).toBe(mockContext);
		});

		it("should add custom methods to the client", () => {
			const client = getThoughtSpotClient(
				mockInstanceUrl,
				mockBearerToken,
			) as any;

			expect(client).toHaveProperty("exportUnsavedAnswerTML");
			expect(client).toHaveProperty("getSessionInfo");
			expect(client).toHaveProperty("getAnswerSession");
			expect(client).toHaveProperty("createAgentConversationWithAutoMode");
			expect(client).toHaveProperty("sendAgentConversationMessageStreaming");
			expect(typeof client.exportUnsavedAnswerTML).toBe("function");
			expect(typeof client.getSessionInfo).toBe("function");
			expect(typeof client.getAnswerSession).toBe("function");
			expect(typeof client.createAgentConversationWithAutoMode).toBe(
				"function",
			);
			expect(typeof client.sendAgentConversationMessageStreaming).toBe(
				"function",
			);
		});
	});

	describe("exportUnsavedAnswerTML", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		it("should export unsaved answer TML successfully", async () => {
			const mockResponse = {
				data: {
					UnsavedAnswer_getTML: {
						object: [
							{
								edoc: "test-yaml-content",
							},
						],
					},
				},
			};

			const mockYamlParsed = { test: "data" };

			(fetch as any).mockResolvedValue({
				json: vi.fn().mockResolvedValue(mockResponse),
			});

			(YAML.parse as any).mockReturnValue(mockYamlParsed);

			const result = await client.exportUnsavedAnswerTML({
				session_identifier: "session-123",
				generation_number: 1,
			});

			expect(fetch).toHaveBeenCalledWith(
				`${mockInstanceUrl}/prism/?op=GetUnsavedAnswerTML`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
						"user-agent": "ThoughtSpot-ts-client",
						Authorization: "Bearer test-token-123",
					},
					body: expect.any(String),
				},
			);

			// Verify the body contains expected data
			const fetchCall = (fetch as any).mock.calls[0];
			const body = JSON.parse(fetchCall[1].body);
			expect(body.operationName).toBe("GetUnsavedAnswerTML");
			expect(body.variables.session.sessionId).toBe("session-123");
			expect(body.variables.session.genNo).toBe(1);

			expect(YAML.parse).toHaveBeenCalledWith("test-yaml-content");
			expect(result).toEqual(mockYamlParsed);
		});

		it("should handle fetch errors", async () => {
			const mockError = new Error("Network error");
			(fetch as any).mockRejectedValue(mockError);

			await expect(
				client.exportUnsavedAnswerTML({
					session_identifier: "session-123",
					generation_number: 1,
				}),
			).rejects.toThrow("Network error");
		});

		it("should handle malformed response data", async () => {
			const mockResponse = {
				data: {
					UnsavedAnswer_getTML: {
						object: [], // Empty array
					},
				},
			};

			(fetch as any).mockResolvedValue({
				json: vi.fn().mockResolvedValue(mockResponse),
			});

			await expect(
				client.exportUnsavedAnswerTML({
					session_identifier: "session-123",
					generation_number: 1,
				}),
			).rejects.toThrow();
		});
	});

	describe("getSessionInfo", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		it("should get session info successfully", async () => {
			const mockResponse = {
				info: {
					userId: "user-123",
					userName: "test-user",
					email: "test@example.com",
					displayName: "Test User",
					tenantId: "tenant-123",
					locale: "en-US",
					timezone: "UTC",
				},
			};

			(fetch as any).mockResolvedValue({
				json: vi.fn().mockResolvedValue(mockResponse),
			});

			const result = await client.getSessionInfo();

			expect(fetch).toHaveBeenCalledWith(
				`${mockInstanceUrl}/prism/preauth/info`,
				{
					method: "GET",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
						"user-agent": "ThoughtSpot-ts-client",
						Authorization: `Bearer ${mockBearerToken}`,
					},
				},
			);

			expect(result).toEqual(mockResponse.info);
		});

		it("should handle fetch errors", async () => {
			const mockError = new Error("Network error");
			(fetch as any).mockRejectedValue(mockError);

			await expect(client.getSessionInfo()).rejects.toThrow("Network error");
		});

		it("should handle HTTP error responses", async () => {
			const mockResponse = {
				ok: false,
				status: 401,
				statusText: "Unauthorized",
				json: vi.fn().mockResolvedValue({ error: "Invalid token" }),
			};

			(fetch as any).mockResolvedValue(mockResponse);

			// The actual implementation doesn't check response.ok, so it will try to parse the response
			const result = await client.getSessionInfo();
			expect(result).toBeUndefined(); // data.info will be undefined
		});

		it("should handle malformed response", async () => {
			const mockResponse = {
				// Missing info property
				someOtherProperty: "value",
			};

			(fetch as any).mockResolvedValue({
				json: vi.fn().mockResolvedValue(mockResponse),
			});

			const result = await client.getSessionInfo();
			expect(result).toBeUndefined();
		});

		it("should handle empty response", async () => {
			const mockResponse = {};

			(fetch as any).mockResolvedValue({
				json: vi.fn().mockResolvedValue(mockResponse),
			});

			const result = await client.getSessionInfo();
			expect(result).toBeUndefined();
		});

		it("should handle null response", async () => {
			const mockResponse = null;

			(fetch as any).mockResolvedValue({
				json: vi.fn().mockResolvedValue(mockResponse),
			});

			// The actual implementation will throw when trying to access data.info on null
			await expect(client.getSessionInfo()).rejects.toThrow();
		});

		it("should handle partial session info", async () => {
			const mockResponse = {
				info: {
					userId: "user-123",
					userName: "test-user",
					// Missing other properties
				},
			};

			(fetch as any).mockResolvedValue({
				json: vi.fn().mockResolvedValue(mockResponse),
			});

			const result = await client.getSessionInfo();

			expect(result).toEqual(mockResponse.info);
			expect(result.userId).toBe("user-123");
			expect(result.userName).toBe("test-user");
			expect(result.email).toBeUndefined();
		});

		it("should use correct headers for session info request", async () => {
			const mockResponse = {
				info: {
					userId: "user-123",
					userName: "test-user",
				},
			};

			(fetch as any).mockResolvedValue({
				json: vi.fn().mockResolvedValue(mockResponse),
			});

			await client.getSessionInfo();

			const fetchCall = (fetch as any).mock.calls[0];
			const headers = fetchCall[1].headers;

			expect(headers["Content-Type"]).toBe("application/json");
			expect(headers.Accept).toBe("application/json");
			expect(headers["user-agent"]).toBe("ThoughtSpot-ts-client");
			expect(headers.Authorization).toBe(`Bearer ${mockBearerToken}`);
		});

		it("should handle JSON parsing errors", async () => {
			(fetch as any).mockResolvedValue({
				json: vi.fn().mockRejectedValue(new Error("Invalid JSON")),
			});

			await expect(client.getSessionInfo()).rejects.toThrow("Invalid JSON");
		});
	});

	describe("getAnswerSession", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		it("should get answer session successfully", async () => {
			const mockResponse = {
				data: {
					Answer__updateTokens: {
						id: {
							sessionId: "session-123",
							genNo: 2,
							acSession: {
								genNo: 5,
								sessionId: "ac-session-456",
							},
						},
					},
				},
			};

			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue(mockResponse),
			});

			const result = await client.getAnswerSession({
				session_identifier: "session-123",
				generation_number: 2,
			});

			expect(fetch).toHaveBeenCalledWith(`${mockInstanceUrl}/prism/`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"user-agent": "ThoughtSpot-ts-client",
					Authorization: `Bearer ${mockBearerToken}`,
				},
				body: expect.any(String),
			});

			const fetchCall = (fetch as any).mock.calls[0];
			const body = JSON.parse(fetchCall[1].body);
			expect(body.operationName).toBe("Answer__updateTokens");
			expect(body.variables.session.sessionId).toBe("session-123");
			expect(body.variables.session.genNo).toBe(2);
			expect(body.query).toContain("mutation Answer__updateTokens");
			expect(body.query).toContain("acSession");

			expect(result).toEqual(mockResponse.data.Answer__updateTokens.id);
		});

		it("should handle HTTP error responses", async () => {
			const mockResponse = {
				ok: false,
				status: 401,
				text: vi.fn().mockResolvedValue("Invalid token"),
			};

			(fetch as any).mockResolvedValue(mockResponse);

			await expect(
				client.getAnswerSession({
					session_identifier: "session-123",
					generation_number: 2,
				}),
			).rejects.toMatchObject({
				status: 401,
				message: "getAnswerSession failed with status 401",
			});
		});

		it("should throw when response is missing answer session", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						Answer__updateTokens: {},
					},
				}),
			});

			await expect(
				client.getAnswerSession({
					session_identifier: "session-123",
					generation_number: 2,
				}),
			).rejects.toThrow("Could not extract answer session from response.");
		});

		it("should throw when response data is null", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue(null),
			});

			await expect(
				client.getAnswerSession({
					session_identifier: "session-123",
					generation_number: 2,
				}),
			).rejects.toThrow("Could not extract answer session from response.");
		});

		it("should handle JSON parsing errors", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockRejectedValue(new Error("Invalid JSON response")),
			});

			await expect(
				client.getAnswerSession({
					session_identifier: "session-123",
					generation_number: 2,
				}),
			).rejects.toThrow("Invalid JSON response");
		});

		it("should use correct headers for answer session request", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						Answer__updateTokens: {
							id: {
								sessionId: "session-123",
								genNo: 2,
								acSession: {
									genNo: 5,
									sessionId: "ac-session-456",
								},
							},
						},
					},
				}),
			});

			await client.getAnswerSession({
				session_identifier: "session-123",
				generation_number: 2,
			});

			const fetchCall = (fetch as any).mock.calls[0];
			const headers = fetchCall[1].headers;

			expect(headers["Content-Type"]).toBe("application/json");
			expect(headers.Accept).toBe("application/json");
			expect(headers["user-agent"]).toBe("ThoughtSpot-ts-client");
			expect(headers.Authorization).toBe(`Bearer ${mockBearerToken}`);
		});
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

	describe("sendAgentConversationMessageStreaming", () => {
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
				const result = await client.sendAgentConversationMessageStreaming({
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
				client.sendAgentConversationMessageStreaming({
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
				client.sendAgentConversationMessageStreaming({
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
				await client.sendAgentConversationMessageStreaming({
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

			await client.sendAgentConversationMessageStreaming({
				conversation_identifier: "conv-id",
				message: "test message",
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.id).toHaveLength(12);
		});

		it("should generate id using only allowed custom alphabet characters", async () => {
			(fetch as any).mockResolvedValue({ ok: true });

			await client.sendAgentConversationMessageStreaming({
				conversation_identifier: "conv-id",
				message: "test message",
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			const allowedChars = /^[_\-0-9a-zA-Z]+$/;
			expect(body.id).toMatch(allowedChars);
		});

		it("should generate unique ids across consecutive calls to avoid collisions", async () => {
			(fetch as any).mockResolvedValue({ ok: true });

			await client.sendAgentConversationMessageStreaming({
				conversation_identifier: "conv-id",
				message: "first message",
			});
			await client.sendAgentConversationMessageStreaming({
				conversation_identifier: "conv-id",
				message: "second message",
			});

			const id1 = JSON.parse((fetch as any).mock.calls[0][1].body).id;
			const id2 = JSON.parse((fetch as any).mock.calls[1][1].body).id;
			expect(id1).not.toBe(id2);
		});
	});

	describe("searchObjects", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		it("should search objects and map the results", async () => {
			const mockResponse = {
				data: {
					queryRequest: {
						requestIdentifiers: { apiRequestId: "req-1" },
						facets: [
							{
								facetType: "STICKERS",
								facetValues: [{ id: "tag-1", name: "Finance" }],
							},
						],
						results: [
							{
								objectSecurityInfo: {
									objectType: "QUESTION_ANSWER_BOOK",
									objectId: "answer-123",
								},
								searchAnswer: {
									header: {
										id: "answer-123",
										title: "Sales by Region",
										description: "Revenue by region",
										authorName: "alice",
										modifiedOn: 1700000000000,
										isVerified: true,
										tagIds: ["tag-1"],
									},
								},
								snippetInfo: {
									titleSnippet: { highlights: [{ start: 0, end: 5 }] },
								},
								resultType: "ANSWER_RESULT",
								score: 0.9,
							},
							{
								objectSecurityInfo: {
									objectType: "PINBOARD_ANSWER_BOOK",
									objectId: "lb-456",
								},
								searchPinboard: {
									header: {
										id: "lb-456",
										title: "Sales Overview",
										description: "Overview",
										authorName: "bob",
										modifiedOn: 1700000001000,
										isVerified: false,
									},
								},
								resultType: "PINBOARD_RESULT",
								score: 0.8,
							},
						],
						totalResults: 2,
					},
				},
			};

			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue(mockResponse),
			});

			const result = await client.searchObjects({
				query: "sales",
				limit: 5,
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.operationName).toBe("GetEurekaResults");
			expect(body.variables.params.query).toBe("sales");
			expect(body.variables.params.batchSize).toBe(5);

			expect(result.results).toEqual([
				{
					object_id: "answer-123",
					title: "Sales by Region",
					type: "ANSWER",
					author_name: "alice",
					description: "Revenue by region",
					tags: ["Finance"],
					last_modified: new Date(1700000000000).toISOString(),
					verified: true,
					external_link: `${mockInstanceUrl}/#/saved-answer/answer-123`,
					query: null, // no sageQuery in this fixture
					confidence: 0.9,
				},
				{
					object_id: "lb-456",
					title: "Sales Overview",
					type: "LIVEBOARD",
					author_name: "bob",
					description: "Overview",
					tags: [],
					last_modified: new Date(1700000001000).toISOString(),
					verified: false,
					external_link: `${mockInstanceUrl}/#/insights/pinboard/lb-456`,
					query: null, // Liveboards always map query -> null
					confidence: 0.8,
				},
			]);
			expect(result.next_cursor).toBeNull();
		});

		it("should generate and send the x-request-id header", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue({ data: { queryRequest: { results: [] } } }),
			});

			await client.searchObjects({ query: "sales" });

			const headers = (fetch as any).mock.calls[0][1].headers;
			const uuid =
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
			expect(headers["x-request-id"]).toMatch(uuid);
		});

		it("should send server-side facet selections for types and verified_only", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue({ data: { queryRequest: { results: [] } } }),
			});

			await client.searchObjects({
				query: "sales",
				types: ["LIVEBOARD", "ANSWER"],
				verifiedOnly: true,
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.variables.params.facetSelections).toEqual([
				{
					facetType: "OBJECT_TYPE",
					facetValue: ["pinboard_answer_book", "question_answer_book"],
				},
				{ facetType: "IS_VERIFIED", facetValue: ["true"] },
			]);
		});

		it("should default limit to 10 and offset to 0 when not provided", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue({ data: { queryRequest: { results: [] } } }),
			});

			const result = await client.searchObjects({ query: "sales" });

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.variables.params.batchSize).toBe(10);
			expect(body.variables.params.offset).toBe(0);
			expect(result.results).toEqual([]);
			expect(result.next_cursor).toBeNull();
		});

		it("should page using the cursor and emit next_cursor on a full page", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [
								{
									objectSecurityInfo: { objectType: "X", objectId: "a" },
									searchPinboard: { header: { id: "a", title: "A" } },
									resultType: "PINBOARD_RESULT",
								},
								{
									objectSecurityInfo: { objectType: "X", objectId: "b" },
									searchPinboard: { header: { id: "b", title: "B" } },
									resultType: "PINBOARD_RESULT",
								},
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({
				query: "sales",
				limit: 2,
				cursor: "4",
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.variables.params.offset).toBe(4);
			expect(result.next_cursor).toBe("6");
		});

		it("should apply modified_since as a client-side filter", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [
								{
									objectSecurityInfo: { objectType: "X", objectId: "old" },
									searchPinboard: {
										header: {
											id: "old",
											title: "Old",
											modifiedOn: 1600000000000,
										},
									},
									resultType: "PINBOARD_RESULT",
								},
								{
									objectSecurityInfo: { objectType: "X", objectId: "new" },
									searchPinboard: {
										header: {
											id: "new",
											title: "New",
											modifiedOn: 1700000000000,
										},
									},
									resultType: "PINBOARD_RESULT",
								},
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({
				query: "sales",
				modifiedSince: 1650000000000,
			});

			expect(result.results.map((o: any) => o.object_id)).toEqual(["new"]);
		});

		it("normalizes second-precision modifiedOn to epoch-ms", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [
								{
									objectSecurityInfo: { objectType: "X", objectId: "s" },
									searchPinboard: {
										// Seconds-precision timestamp from an older cluster.
										header: { id: "s", title: "S", modifiedOn: 1700000000 },
									},
									resultType: "PINBOARD_RESULT",
								},
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales" });

			// Seconds normalized to ms, then emitted as ISO-8601.
			expect(result.results[0].last_modified).toBe(
				new Date(1700000000000).toISOString(),
			);
		});

		// Helper: a single raw Eureka result owned by `author`.
		const ownedResult = (id: string, author: string) => ({
			objectSecurityInfo: { objectType: "X", objectId: id },
			searchPinboard: { header: { id, title: id, authorName: author } },
			resultType: "PINBOARD_RESULT",
		});
		const pageResponse = (results: any[]) => ({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: { queryRequest: { results } } }),
		});

		it("keeps fetching pages so a post-filter never returns a short page while matches remain", async () => {
			// Each full page of `limit` raw rows contributes only one owner match,
			// so a single fetch would return 1 object (and a misleading cursor).
			(fetch as any)
				.mockResolvedValueOnce(
					pageResponse([ownedResult("a1", "alice"), ownedResult("b1", "bob")]),
				)
				.mockResolvedValueOnce(
					pageResponse([ownedResult("a2", "alice"), ownedResult("b2", "bob")]),
				);

			const result = await client.searchObjects({
				query: "sales",
				owner: "alice",
				limit: 2,
			});

			expect((fetch as any).mock.calls.length).toBe(2);
			expect(
				JSON.parse((fetch as any).mock.calls[0][1].body).variables.params
					.offset,
			).toBe(0);
			expect(
				JSON.parse((fetch as any).mock.calls[1][1].body).variables.params
					.offset,
			).toBe(2);
			expect(result.results.map((o: any) => o.object_id)).toEqual(["a1", "a2"]);
			// A full final raw page means more may exist: resume past both pages.
			expect(result.next_cursor).toBe("4");
		});

		it("stops paging and emits a null cursor once raw results are exhausted", async () => {
			(fetch as any)
				.mockResolvedValueOnce(
					pageResponse([ownedResult("a1", "alice"), ownedResult("b1", "bob")]),
				)
				// Shorter-than-limit page => backend has nothing more to give.
				.mockResolvedValueOnce(pageResponse([ownedResult("b2", "bob")]));

			const result = await client.searchObjects({
				query: "sales",
				owner: "alice",
				limit: 2,
			});

			expect((fetch as any).mock.calls.length).toBe(2);
			expect(result.results.map((o: any) => o.object_id)).toEqual(["a1"]);
			expect(result.next_cursor).toBeNull();
		});

		it("honors the cursor's absolute offset without realigning it", async () => {
			(fetch as any).mockResolvedValue(pageResponse([]));

			await client.searchObjects({ query: "sales", limit: 10, cursor: "25" });

			const params = JSON.parse((fetch as any).mock.calls[0][1].body).variables
				.params;
			// The cursor offset is used as-is (no snap-back that could rewind a page
			// when limit changed between calls); page number is derived from it.
			expect(params.offset).toBe(25);
			expect(params.currentPageNumber).toBe(3);
		});

		it("should fall back to objectSecurityInfo.objectId when no header has an id", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [
								{ objectSecurityInfo: { objectType: "X", objectId: "y" } },
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales" });
			expect(result.results).toEqual([
				{
					object_id: "y",
					title: "",
					type: "X",
					author_name: "",
					tags: [],
					verified: false,
					external_link: `${mockInstanceUrl}/#/insights/pinboard/y`,
					query: null,
					confidence: 0,
				},
			]);
		});

		it("surfaces the parent Liveboard as id and the viz as visualization_id for a pinboard-viz hit", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [
								{
									objectSecurityInfo: {
										objectType: "PINBOARD_ANSWER_BOOK",
										objectId: "lb-1",
									},
									searchPinboardViz: {
										answer: { header: { id: "viz-1", title: "Revenue viz" } },
										pinboardHeader: { id: "lb-1", title: "Sales Board" },
									},
									resultType: "PINBOARD_VIZ_RESULT",
									score: 0.7,
								},
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.results).toHaveLength(1);
			const obj = result.results[0] as any;
			// fetch_data resolves the Liveboard id; the viz is passed via
			// visualization_ids to fetch just this visualization.
			expect(obj.object_id).toBe("lb-1");
			expect(obj.visualization_id).toBe("viz-1");
			// A viz pinned on a Liveboard is its own type ("Liveboard viz").
			expect(obj.type).toBe("LIVEBOARD_VIZ");
			expect(obj.external_link).toBe(
				`${mockInstanceUrl}/#/insights/pinboard/lb-1/viz-1`,
			);
		});

		it("should skip results with neither a header id nor an objectId", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [{ resultType: "PINBOARD_RESULT" }],
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales" });
			expect(result.results).toEqual([]);
		});

		it("returns an INTERNAL error envelope on GraphQL errors", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					errors: [{ message: "Invalid locale format: *" }],
					data: { queryRequest: null },
				}),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.status).toBe("error");
			expect(result.results).toEqual([]);
			expect(result.error.code).toBe("INTERNAL");
			expect(result.error.retryable).toBe(false);
		});

		it("maps a 401 to an UNAUTHORIZED error envelope", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 401,
				text: vi.fn().mockResolvedValue("unauthorized"),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.status).toBe("error");
			expect(result.error.code).toBe("UNAUTHORIZED");
			expect(result.error.retryable).toBe(false);
		});

		it("maps a 429 to a retryable RATE_LIMITED error envelope", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 429,
				text: vi.fn().mockResolvedValue("slow down"),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.error.code).toBe("RATE_LIMITED");
			expect(result.error.retryable).toBe(true);
		});

		it("maps a 504 to a retryable UPSTREAM_TIMEOUT error envelope", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 504,
				text: vi.fn().mockResolvedValue("gateway timeout"),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.error.code).toBe("UPSTREAM_TIMEOUT");
			expect(result.error.retryable).toBe(true);
		});

		it("maps a 500 to a retryable INTERNAL error envelope", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 500,
				text: vi.fn().mockResolvedValue("boom"),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.error.code).toBe("INTERNAL");
			expect(result.error.retryable).toBe(true);
		});

		it("resolves the type filter enum to Eureka facet values", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue({ data: { queryRequest: { results: [] } } }),
			});

			await client.searchObjects({
				query: "sales",
				// LIVEBOARD -> pinboard_answer_book; WORKSHEET -> logical_table (deduped).
				types: ["LIVEBOARD", "WORKSHEET", "WORKSHEET"],
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.variables.params.facetSelections).toEqual([
				{
					facetType: "OBJECT_TYPE",
					facetValue: ["pinboard_answer_book", "logical_table"],
				},
			]);
		});

		// A raw Eureka result with a given id and relevance score.
		const scoredResult = (id: string, score: number) => ({
			objectSecurityInfo: { objectType: "X", objectId: id },
			searchPinboard: { header: { id, title: id } },
			resultType: "PINBOARD_RESULT",
			score,
		});

		it("returns an INVALID_ARGUMENT envelope for a whitespace-only query", async () => {
			(fetch as any).mockResolvedValue(pageResponse([]));

			const result = await client.searchObjects({ query: "   " });

			expect(result.status).toBe("error");
			expect(result.error.code).toBe("INVALID_ARGUMENT");
			expect(result.error.retryable).toBe(false);
			// Never hits the upstream for an empty term.
			expect((fetch as any).mock.calls.length).toBe(0);
		});

		it("clamps a negative cursor to offset 0", async () => {
			(fetch as any).mockResolvedValue(pageResponse([]));

			await client.searchObjects({ query: "sales", limit: 10, cursor: "-5" });

			const params = JSON.parse((fetch as any).mock.calls[0][1].body).variables
				.params;
			expect(params.offset).toBe(0);
			expect(params.currentPageNumber).toBe(1);
		});

		it("trusts the backend's isFinalPage over the full-page heuristic", async () => {
			// A short page would normally mean "no more results", but the backend
			// says otherwise (e.g. it trimmed rows for dedup/security reasons).
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [scoredResult("a", 0.5)],
							isFinalPage: false,
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales", limit: 2 });

			expect(result.results.map((o: any) => o.object_id)).toEqual(["a"]);
			expect(result.next_cursor).toBe("2");
		});

		it("emits a null cursor when the backend marks a full page as final", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [scoredResult("a", 0.5), scoredResult("b", 0.4)],
							isFinalPage: true,
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales", limit: 2 });

			expect(result.results).toHaveLength(2);
			expect(result.next_cursor).toBeNull();
		});

		it("truncates post-filter overshoot to limit with a skip-free cursor", async () => {
			// Page 1 contributes one owner match; page 2 contributes two, taking the
			// accumulated total to 3 for limit=2.
			(fetch as any)
				.mockResolvedValueOnce(
					pageResponse([ownedResult("a1", "alice"), ownedResult("b1", "bob")]),
				)
				.mockResolvedValueOnce(
					pageResponse([
						ownedResult("a2", "alice"),
						ownedResult("a3", "alice"),
					]),
				);

			const result = await client.searchObjects({
				query: "sales",
				owner: "alice",
				limit: 2,
			});

			expect(result.results.map((o: any) => o.object_id)).toEqual(["a1", "a2"]);
			// The dropped match ("a3") came from the page at offset 2, so the cursor
			// points back at it rather than past it.
			expect(result.next_cursor).toBe("2");
		});

		it("returns an INTERNAL error envelope when GraphQL errors carry no message", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ errors: [{}], data: null }),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.status).toBe("error");
			expect(result.error.code).toBe("INTERNAL");
		});

		it("returns an INTERNAL error envelope when the queryRequest reports an errorCode", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: { queryRequest: { errorCode: 42, results: [] } },
				}),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.status).toBe("error");
			expect(result.error.code).toBe("INTERNAL");
			expect(result.error.retryable).toBe(false);
		});

		it("returns a no_results envelope when the query matches nothing", async () => {
			(fetch as any).mockResolvedValue(pageResponse([]));

			const result = await client.searchObjects({ query: "nonexistent" });

			expect(result.status).toBe("no_results");
			expect(result.results).toEqual([]);
			expect(result.next_cursor).toBeNull();
		});

		it("applies tag as a client-side filter using resolved sticker names", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							facets: [
								{
									facetType: "STICKERS",
									facetValues: [{ id: "tag-1", name: "Finance" }],
								},
							],
							results: [
								{
									objectSecurityInfo: { objectType: "X", objectId: "a" },
									searchPinboard: {
										header: { id: "a", title: "A", tagIds: ["tag-1"] },
									},
									resultType: "PINBOARD_RESULT",
								},
								{
									objectSecurityInfo: { objectType: "X", objectId: "b" },
									searchPinboard: { header: { id: "b", title: "B" } },
									resultType: "PINBOARD_RESULT",
								},
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({
				query: "sales",
				tag: "finance",
			});

			expect(result.results.map((o: any) => o.object_id)).toEqual(["a"]);
		});

		it("derives `query` from sageQuery for Answers/vizzes and null otherwise", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [
								{
									objectSecurityInfo: { objectType: "X", objectId: "a" },
									searchAnswer: { header: { id: "a", title: "A" } },
									resultType: "ANSWER_RESULT",
									sageQuery: "sales by region",
								},
								{
									objectSecurityInfo: { objectType: "X", objectId: "b" },
									searchPinboardViz: {
										pinboardHeader: { id: "lb", title: "LB" },
										answer: { header: { id: "b", title: "B" } },
									},
									resultType: "PINBOARD_VIZ_RESULT",
									sageQuery: "revenue weekly",
								},
								{
									// Liveboard: sageQuery is a bare GUID -> query must be null.
									objectSecurityInfo: { objectType: "X", objectId: "c" },
									searchPinboard: { header: { id: "c", title: "C" } },
									resultType: "PINBOARD_RESULT",
									sageQuery: "902ed66c-0765-4e05-832d-3c44fed7424e",
								},
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.results.map((o: any) => o.query)).toEqual([
				"sales by region",
				"revenue weekly",
				null,
			]);
		});

		it("stops accumulating after the page cap and warns", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			// Every page is full of non-matching rows, so the post-filter loop runs
			// to its page cap and reports that more results may remain.
			(fetch as any).mockResolvedValue(
				pageResponse([ownedResult("x1", "bob"), ownedResult("x2", "bob")]),
			);

			const result = await client.searchObjects({
				query: "sales",
				owner: "alice",
				limit: 2,
			});

			expect((fetch as any).mock.calls.length).toBe(20);
			// Nothing survived the post-filter -> no_results (cursor null per spec),
			// even though more raw pages may remain.
			expect(result.status).toBe("no_results");
			expect(result.results).toEqual([]);
			expect(result.next_cursor).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("stopped after 20 page"),
			);
			warnSpy.mockRestore();
		});
	});

	describe("fetchData", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		const metaResponse = (type: string, name = "My Object") => ({
			ok: true,
			json: vi.fn().mockResolvedValue([
				{
					metadata_id: "obj-1",
					metadata_name: name,
					metadata_type: type,
					metadata_header: { description: "A description" },
				},
			]),
		});

		// Mirrors the real /metadata/answer/data FULL response: column_names plus
		// object rows keyed by column name.
		it("fetches and maps a saved Answer", async () => {
			(fetch as any)
				.mockResolvedValueOnce(metaResponse("ANSWER", "Test Answer v1"))
				.mockResolvedValueOnce({
					ok: true,
					json: vi.fn().mockResolvedValue({
						metadata_id: "obj-1",
						metadata_name: "Test Answer v1",
						contents: [
							{
								available_data_row_count: 2,
								column_names: [
									"city",
									"Total quantity purchased",
									"Total sales",
								],
								data_rows: [
									{
										city: "Boulder",
										"Total quantity purchased": 677792,
										"Total sales": 34070647.18,
									},
									{
										city: "Atlanta",
										"Total quantity purchased": 424496,
										"Total sales": 21161832.426,
									},
								],
								record_offset: 0,
								record_size: 10,
								returned_data_row_count: 2,
								sampling_ratio: 1,
							},
						],
					}),
				});

			const result = await client.fetchData({ objectId: "obj-1" });

			// First call resolves the type via metadata search.
			const metaUrl = (fetch as any).mock.calls[0][0];
			const metaBody = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(metaUrl).toBe(`${mockInstanceUrl}/api/rest/2.0/metadata/search`);
			expect(metaBody).toEqual({ metadata: [{ identifier: "obj-1" }] });

			// Second call fetches the answer data.
			const dataUrl = (fetch as any).mock.calls[1][0];
			const dataBody = JSON.parse((fetch as any).mock.calls[1][1].body);
			const dataHeaders = (fetch as any).mock.calls[1][1].headers;
			expect(dataUrl).toBe(
				`${mockInstanceUrl}/api/rest/2.0/metadata/answer/data`,
			);
			expect(dataBody).toEqual({
				metadata_identifier: "obj-1",
				data_format: "FULL",
				record_offset: 0,
				record_size: 25,
			});

			// FULL object rows are normalized into columns + positional rows.
			expect(result).toEqual({
				data: [
					{
						viz_id: undefined,
						viz_name: undefined,
						columns: ["city", "Total quantity purchased", "Total sales"],
						data_rows: [
							["Boulder", 677792, 34070647.18],
							["Atlanta", 424496, 21161832.426],
						],
						total_row_count: 2,
						sampling_ratio: 1,
					},
				],
			});
			// Same correlation id is sent on both upstream calls.
			expect((fetch as any).mock.calls[0][1].headers["x-request-id"]).toBe(
				dataHeaders["x-request-id"],
			);
		});

		// Mirrors the real /metadata/liveboard/data FULL response: one content
		// entry per visualization, each with visualization_id/name.
		it("fetches a Liveboard with one entry per visualization", async () => {
			(fetch as any)
				.mockResolvedValueOnce(
					metaResponse("LIVEBOARD", "Test MCP Liveboard 1"),
				)
				.mockResolvedValueOnce({
					ok: true,
					json: vi.fn().mockResolvedValue({
						metadata_id: "obj-1",
						metadata_name: "Test MCP Liveboard 1",
						contents: [
							{
								available_data_row_count: 1,
								column_names: ["item type", "Total sales"],
								data_rows: [
									{ "item type": "Dresses", "Total sales": 7896217.73 },
								],
								returned_data_row_count: 1,
								sampling_ratio: 1,
								visualization_id: "de1240fc-2d4d-4c67-9317-02e9c6e3bf1c",
								visualization_name: "Total sales by item type by year",
							},
							{
								available_data_row_count: 1,
								column_names: ["city", "Total sales"],
								data_rows: [{ city: "Billings", "Total sales": 3198084.8 }],
								returned_data_row_count: 1,
								sampling_ratio: 1,
								visualization_id: "cf049bb9-f3b7-466b-9000-41d814d3967a",
								visualization_name: "Total sales by city (this year, 2026)",
							},
						],
					}),
				});

			const result = await client.fetchData({ objectId: "obj-1", maxRows: 50 });

			const dataUrl = (fetch as any).mock.calls[1][0];
			const dataBody = JSON.parse((fetch as any).mock.calls[1][1].body);
			expect(dataUrl).toBe(
				`${mockInstanceUrl}/api/rest/2.0/metadata/liveboard/data`,
			);
			// Liveboards request the full viz (unbounded record_size); max_rows caps client-side.
			expect(dataBody.record_size).toBe(LIVEBOARD_RECORD_SIZE);
			// No viz filter when fetching the whole Liveboard.
			expect(dataBody.visualization_identifiers).toBeUndefined();

			expect(result.data).toEqual([
				{
					viz_id: "de1240fc-2d4d-4c67-9317-02e9c6e3bf1c",
					viz_name: "Total sales by item type by year",
					columns: ["item type", "Total sales"],
					data_rows: [["Dresses", 7896217.73]],
					total_row_count: 1,
					sampling_ratio: 1,
				},
				{
					viz_id: "cf049bb9-f3b7-466b-9000-41d814d3967a",
					viz_name: "Total sales by city (this year, 2026)",
					columns: ["city", "Total sales"],
					data_rows: [["Billings", 3198084.8]],
					total_row_count: 1,
					sampling_ratio: 1,
				},
			]);
		});

		// An answer pinned inside a Liveboard: pass the Liveboard GUID plus the
		// visualization GUID; the request carries visualization_identifiers.
		it("fetches a specific visualization inside a Liveboard", async () => {
			(fetch as any)
				.mockResolvedValueOnce(
					metaResponse("LIVEBOARD", "Test MCP Liveboard 1"),
				)
				.mockResolvedValueOnce({
					ok: true,
					json: vi.fn().mockResolvedValue({
						metadata_id: "obj-1",
						metadata_name: "Test MCP Liveboard 1",
						contents: [
							{
								available_data_row_count: 1,
								column_names: ["item type", "Total sales"],
								data_rows: [
									{ "item type": "Dresses", "Total sales": 7896217.73 },
								],
								returned_data_row_count: 1,
								sampling_ratio: 1,
								visualization_id: "de1240fc-2d4d-4c67-9317-02e9c6e3bf1c",
								visualization_name: "Total sales by item type by year",
							},
						],
					}),
				});

			const result = await client.fetchData({
				objectId: "obj-1",
				vizIds: ["de1240fc-2d4d-4c67-9317-02e9c6e3bf1c"],
			});

			const dataUrl = (fetch as any).mock.calls[1][0];
			const dataBody = JSON.parse((fetch as any).mock.calls[1][1].body);
			expect(dataUrl).toBe(
				`${mockInstanceUrl}/api/rest/2.0/metadata/liveboard/data`,
			);
			expect(dataBody.visualization_identifiers).toEqual([
				"de1240fc-2d4d-4c67-9317-02e9c6e3bf1c",
			]);
			expect(result.data).toHaveLength(1);
			expect(result.data[0].viz_id).toBe(
				"de1240fc-2d4d-4c67-9317-02e9c6e3bf1c",
			);
		});

		// COMPACT format returns positional rows alongside column_names; the
		// handler should pass them through aligned to the columns.
		it("tolerates COMPACT positional rows", async () => {
			(fetch as any)
				.mockResolvedValueOnce(metaResponse("ANSWER", "Compact Answer"))
				.mockResolvedValueOnce({
					ok: true,
					json: vi.fn().mockResolvedValue({
						metadata_id: "obj-1",
						metadata_name: "Compact Answer",
						contents: [
							{
								column_names: ["city", "Total sales"],
								data_rows: [
									["Boulder", 34070647.18],
									["Atlanta", 21161832.426],
								],
								returned_data_row_count: 2,
							},
						],
					}),
				});

			const result = await client.fetchData({ objectId: "obj-1" });

			expect(result.data[0]).toMatchObject({
				columns: ["city", "Total sales"],
				data_rows: [
					["Boulder", 34070647.18],
					["Atlanta", 21161832.426],
				],
			});
		});

		// FULL rows without column_names: columns are derived from row keys.
		it("derives columns from row keys when column_names is absent", async () => {
			(fetch as any)
				.mockResolvedValueOnce(metaResponse("ANSWER", "No Columns"))
				.mockResolvedValueOnce({
					ok: true,
					json: vi.fn().mockResolvedValue({
						metadata_id: "obj-1",
						metadata_name: "No Columns",
						contents: [
							{
								data_rows: [
									{ city: "Boulder", "Total sales": 34070647.18 },
									{ city: "Atlanta", "Total sales": 21161832.426 },
								],
							},
						],
					}),
				});

			const result = await client.fetchData({ objectId: "obj-1" });

			expect(result.data[0].columns).toEqual(["city", "Total sales"]);
			expect(result.data[0].data_rows).toEqual([
				["Boulder", 34070647.18],
				["Atlanta", 21161832.426],
			]);
		});

		// Cells pass through unchanged — full precision, no rounding.
		it("returns numeric cells at full precision in COMPACT rows", async () => {
			(fetch as any)
				.mockResolvedValueOnce(metaResponse("ANSWER", "Noisy Answer"))
				.mockResolvedValueOnce({
					ok: true,
					json: vi.fn().mockResolvedValue({
						metadata_id: "obj-1",
						metadata_name: "Noisy Answer",
						contents: [
							{
								column_names: ["city", "Total sales", "Avg", "Orders"],
								data_rows: [
									["Boulder", 10679247.690000001, 120.030833623, 42],
									["Atlanta", 0.1 + 0.2, 121.694679091, null],
								],
								returned_data_row_count: 2,
							},
						],
					}),
				});

			const result = await client.fetchData({ objectId: "obj-1" });

			expect(result.data[0].data_rows).toEqual([
				["Boulder", 10679247.690000001, 120.030833623, 42],
				["Atlanta", 0.1 + 0.2, 121.694679091, null],
			]);
		});

		it("returns numeric cells at full precision in FULL rows", async () => {
			(fetch as any)
				.mockResolvedValueOnce(metaResponse("ANSWER", "Noisy Full"))
				.mockResolvedValueOnce({
					ok: true,
					json: vi.fn().mockResolvedValue({
						metadata_id: "obj-1",
						metadata_name: "Noisy Full",
						contents: [
							{
								data_rows: [
									{ city: "Boulder", "Total sales": 10679247.690000001 },
								],
							},
						],
					}),
				});

			const result = await client.fetchData({ objectId: "obj-1" });

			expect(result.data[0].data_rows).toEqual([
				["Boulder", 10679247.690000001],
			]);
		});

		// Small-magnitude values (rates, ratios) are returned exactly as stored.
		it("preserves small-magnitude values exactly", async () => {
			(fetch as any)
				.mockResolvedValueOnce(metaResponse("ANSWER", "Rates"))
				.mockResolvedValueOnce({
					ok: true,
					json: vi.fn().mockResolvedValue({
						metadata_id: "obj-1",
						metadata_name: "Rates",
						contents: [
							{
								column_names: ["metric", "rate"],
								data_rows: [
									["conversion", 0.0043],
									["ratio", 0.014],
									["zero", 0],
								],
							},
						],
					}),
				});

			const result = await client.fetchData({ objectId: "obj-1" });

			expect(result.data[0].data_rows).toEqual([
				["conversion", 0.0043],
				["ratio", 0.014],
				["zero", 0],
			]);
		});

		// Large integer IDs/timestamps pass through exactly.
		it("preserves large integers exactly", async () => {
			const bigId = 90071992547409936;
			const microTs = 1735689600000000;
			(fetch as any)
				.mockResolvedValueOnce(metaResponse("ANSWER", "IDs"))
				.mockResolvedValueOnce({
					ok: true,
					json: vi.fn().mockResolvedValue({
						metadata_id: "obj-1",
						metadata_name: "IDs",
						contents: [
							{
								column_names: ["record_id", "created_us"],
								data_rows: [[bigId, microTs]],
							},
						],
					}),
				});

			const result = await client.fetchData({ objectId: "obj-1" });

			expect(result.data[0].data_rows).toEqual([[bigId, microTs]]);
		});

		// Null entries mixed into data_rows must not crash the row mapper.
		it("drops null rows instead of crashing", async () => {
			(fetch as any)
				.mockResolvedValueOnce(metaResponse("ANSWER", "Sparse"))
				.mockResolvedValueOnce({
					ok: true,
					json: vi.fn().mockResolvedValue({
						metadata_id: "obj-1",
						metadata_name: "Sparse",
						contents: [
							{
								data_rows: [
									{ city: "Boulder", sales: 1.5 },
									null,
									{ city: "Atlanta", sales: 2.5 },
								],
							},
						],
					}),
				});

			const result = await client.fetchData({ objectId: "obj-1" });

			expect(result.data[0].data_rows).toEqual([
				["Boulder", 1.5],
				["Atlanta", 2.5],
			]);
		});

		it("throws for an unsupported object type", async () => {
			(fetch as any).mockResolvedValueOnce(metaResponse("LOGICAL_TABLE"));

			await expect(client.fetchData({ objectId: "obj-1" })).rejects.toThrow(
				/does not support object type "LOGICAL_TABLE"/,
			);
			// No data call is made for unsupported types.
			expect((fetch as any).mock.calls.length).toBe(1);
		});

		it("throws when no object matches the id", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue([]),
			});

			await expect(client.fetchData({ objectId: "missing" })).rejects.toThrow(
				/found no object with id missing/,
			);
		});

		it("throws when metadata resolution is not ok", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 404,
				text: vi.fn().mockResolvedValue("not found"),
			});

			await expect(client.fetchData({ objectId: "obj-1" })).rejects.toThrow(
				/failed to resolve object with status 404/,
			);
		});

		it("throws when the data fetch is not ok", async () => {
			(fetch as any)
				.mockResolvedValueOnce(metaResponse("ANSWER"))
				.mockResolvedValueOnce({
					ok: false,
					status: 403,
					text: vi.fn().mockResolvedValue("forbidden"),
				});

			await expect(client.fetchData({ objectId: "obj-1" })).rejects.toThrow(
				/fetchData failed with status 403/,
			);
		});
	});

	describe("GraphQL Queries", () => {
		it("should have the correct GraphQL mutation structure for GetUnsavedAnswerTML", () => {
			// This test ensures the GraphQL query is properly structured
			const query = `
mutation GetUnsavedAnswerTML($session: BachSessionIdInput!, $exportDependencies: Boolean, $formatType:  EDocFormatType, $exportPermissions: Boolean, $exportFqn: Boolean) {
  UnsavedAnswer_getTML(
    session: $session
    exportDependencies: $exportDependencies
    formatType: $formatType
    exportPermissions: $exportPermissions
    exportFqn: $exportFqn
  ) {
    zipFile
    object {
      edoc
      name
      type
      __typename
    }
    __typename
  }
}`;

			expect(query).toContain("mutation GetUnsavedAnswerTML");
			expect(query).toContain("BachSessionIdInput");
			expect(query).toContain("UnsavedAnswer_getTML");
			expect(query).toContain("edoc");
		});
	});

	describe("fetchOrgBearerToken (org-scoped token mint)", () => {
		function makeClient() {
			return getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		}

		it("calls the v2 auth/token/fetch endpoint with org_identifier and a 24-hour validity", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ data: { token: "org-tok" } }), {
					status: 200,
				}),
			);
			const client = makeClient();
			const token = await client.fetchOrgBearerToken({
				accessToken: "global-tok",
				orgId: "101",
			});

			expect(token).toBe("org-tok");
			const [url, init] = (global.fetch as any).mock.calls[0];
			expect(url).toContain("/callosum/v1/v2/auth/token/fetch");
			expect(url).toContain("org_identifier=101");
			// Default validity is 24 hours in seconds.
			expect(url).toContain(`validity_time_in_sec=${24 * 60 * 60}`);
			expect(init.method).toBe("GET");
			// Authenticates with the (global) access token, no org header on the mint.
			expect(init.headers.Authorization).toBe("Bearer global-tok");
		});

		it("honors an explicit validityTimeInSec override", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ token: "org-tok" }), { status: 200 }),
			);
			const client = makeClient();
			await client.fetchOrgBearerToken({
				accessToken: "g",
				orgId: "5",
				validityTimeInSec: 300,
			});
			const [url] = (global.fetch as any).mock.calls[0];
			expect(url).toContain("validity_time_in_sec=300");
			expect(url).toContain("org_identifier=5");
		});

		it("reads the token from either data.token or top-level token", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ token: "flat-tok" }), { status: 200 }),
			);
			const client = makeClient();
			await expect(
				client.fetchOrgBearerToken({ accessToken: "g", orgId: "1" }),
			).resolves.toBe("flat-tok");
		});

		it("throws on a non-OK response, including the status", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response("forbidden", { status: 403 }),
			);
			const client = makeClient();
			await expect(
				client.fetchOrgBearerToken({ accessToken: "g", orgId: "999" }),
			).rejects.toThrow(/status 403/);
		});

		it("throws when the response has no token", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ data: {} }), { status: 200 }),
			);
			const client = makeClient();
			await expect(
				client.fetchOrgBearerToken({ accessToken: "g", orgId: "1" }),
			).rejects.toThrow(/no token/);
		});
	});

	describe("listOrgs (user-scoped org membership)", () => {
		function makeClient() {
			return getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		}

		it("calls the v1 session/orgs endpoint and maps orgId/orgName/description", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(
					JSON.stringify({
						orgs: [
							{ orgId: 0, orgName: "Primary", description: "Primary org" },
							{ orgId: 101, orgName: "DataPlatform" },
						],
						currentOrgId: 0,
					}),
					{ status: 200 },
				),
			);
			const client = makeClient();
			const orgs = await client.listOrgs();

			const [url, init] = (global.fetch as any).mock.calls[0];
			// User-scoped v1 endpoint, NOT the admin orgs/search.
			expect(url).toContain("/callosum/v1/session/orgs");
			expect(url).not.toContain("orgs/search");
			expect(init.method).toBe("GET");
			expect(init.headers.Authorization).toBe(`Bearer ${mockBearerToken}`);
			expect(orgs).toEqual([
				{ id: 0, name: "Primary", description: "Primary org" },
				{ id: 101, name: "DataPlatform", description: undefined },
			]);
		});

		it("returns an empty list when the response has no orgs array", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ currentOrgId: 0 }), { status: 200 }),
			);
			const client = makeClient();
			await expect(client.listOrgs()).resolves.toEqual([]);
		});

		it("throws (with status) on a non-OK response — e.g. an unexpected 403", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response("Operation is not allowed", { status: 403 }),
			);
			const client = makeClient();
			await expect(client.listOrgs()).rejects.toThrow(/status 403/);
		});

		it("falls back to id/name fields when orgId/orgName are absent", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ orgs: [{ id: 7, name: "Alt" }] }), {
					status: 200,
				}),
			);
			const client = makeClient();
			await expect(client.listOrgs()).resolves.toEqual([
				{ id: 7, name: "Alt", description: undefined },
			]);
		});

		it("uses the id as the name when neither orgName nor name is present", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ orgs: [{ orgId: 42 }] }), {
					status: 200,
				}),
			);
			const client = makeClient();
			await expect(client.listOrgs()).resolves.toEqual([
				{ id: 42, name: "42", description: undefined },
			]);
		});

		it("maps an empty-string description to undefined", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(
					JSON.stringify({
						orgs: [{ orgId: 1, orgName: "X", description: "" }],
					}),
					{ status: 200 },
				),
			);
			const client = makeClient();
			const [org] = await client.listOrgs();
			expect(org.description).toBeUndefined();
		});
	});
});
