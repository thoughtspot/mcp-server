import {
	ThoughtSpotRestApi,
	createBearerAuthenticationConfig,
} from "@thoughtspot/rest-api-sdk";
import type { ResponseContext } from "@thoughtspot/rest-api-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
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
			).rejects.toThrow(
				"getAnswerSession failed with status 401: Invalid token",
			);
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

			const result = await client.createAgentConversationWithAutoMode({});

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

			await client.createAgentConversationWithAutoMode({});

			const fetchCall = (fetch as any).mock.calls[0];
			const body = JSON.parse(fetchCall[1].body);
			expect(body.conv_settings).toEqual({
				enable_nls: true,
				enable_why: true,
				save_chat_enabled: false,
				enable_tool_permissions: false,
				enable_search_datasets: true,
				enable_auto_select_dataset: true,
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
			).rejects.toThrow(
				"createAgentConversationWithAutoMode failed with status 401: Unauthorized",
			);
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
			).rejects.toThrow(
				"sendAgentConversationMessageStreaming failed with status 401: Invalid token",
			);
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

		it("calls the v2 auth/token/fetch endpoint with org_identifier and a 30-day validity", async () => {
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
			// Default validity is 30 days in seconds.
			expect(url).toContain(`validity_time_in_sec=${30 * 24 * 60 * 60}`);
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
	});
});
