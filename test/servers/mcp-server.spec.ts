import { connect } from "mcp-testing-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MixpanelTracker } from "../../src/metrics/mixpanel/mixpanel";
import { MCPServer } from "../../src/servers/mcp-server";
import { StreamingMessagesStorageWithTtl } from "../../src/streaming-message-storage-with-ttl/streaming-message-storage-with-ttl";
import * as thoughtspotClient from "../../src/thoughtspot/thoughtspot-client";
import { ThoughtSpotService } from "../../src/thoughtspot/thoughtspot-service";
import { makeRequest } from "./helpers";

// Mock the MixpanelTracker
vi.mock("../../src/metrics/mixpanel/mixpanel", () => ({
	MixpanelTracker: vi.fn().mockImplementation(() => ({
		track: vi.fn(),
	})),
}));

// Mock StreamingMessagesStorageWithTtl to avoid DurableObjectStorage dependency
vi.mock(
	"../../src/streaming-message-storage-with-ttl/streaming-message-storage-with-ttl",
	() => ({
		StreamingMessagesStorageWithTtl: vi.fn().mockImplementation(() => ({
			initializeConversation: vi.fn().mockResolvedValue(undefined),
			appendMessagesAndRestartTtl: vi.fn().mockResolvedValue(undefined),
			getNewMessagesAndUpdateBookmark: vi
				.fn()
				.mockResolvedValue({ messages: [], isDone: true }),
		})),
	}),
);

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
					enableSpotterDataSourceDiscovery: true,
				},
				userName: "test-user",
				currentOrgId: "test-org",
				privileges: [],
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

		server = new MCPServer(
			{
				props: mockProps,
			},
			new StreamingMessagesStorageWithTtl(null as any, vi.fn(), vi.fn()),
		);
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
				},
			);
		});
	});

	describe("List Tools", () => {
		it("should return all available tools", async () => {
			await server.init();
			const { listTools } = connect(server);

			const result = await listTools();

			// V2 tools (latest version): 5 tools
			expect(result.tools).toHaveLength(5);
			expect(result.tools?.map((t) => t.name)).toEqual([
				"check_connectivity",
				"create_analysis_session",
				"send_session_message",
				"get_session_updates",
				"create_dashboard",
			]);
		});

		it("should include correct tool descriptions", async () => {
			await server.init();
			const { listTools } = connect(server);

			const result = await listTools();

			const connectivityTool = result.tools?.find(
				(t) => t.name === "check_connectivity",
			);
			expect(connectivityTool?.description).toBe(
				"Ping tool to test connectivity and authentication. This can be used if other tool calls are failing to verify if the connection is working.",
			);

			const sessionTool = result.tools?.find(
				(t) => t.name === "create_analysis_session",
			);
			expect(sessionTool).toBeDefined();

			const dashboardTool = result.tools?.find(
				(t) => t.name === "create_dashboard",
			);
			expect(dashboardTool?.description).toBe(
				"Create a dashboard from a list of answers, allowing the user to revisit the results later. Use this if the user asks for a dashboard, or asks to save the results from the analysis.",
			);
		});

		it("should return 5 tools regardless of enableSpotterDataSourceDiscovery when using latest (V2)", async () => {
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
						enableSpotterDataSourceDiscovery: false,
					},
					userName: "test-user",
					currentOrgId: "test-org",
					privileges: [],
				}),
				searchMetadata: vi.fn().mockResolvedValue([]),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			await server.init();
			const { listTools } = connect(server);

			const result = await listTools();

			// V2 tools don't have a datasource discovery tool, so filtering has no effect
			expect(result.tools).toHaveLength(5);
			expect(result.tools?.map((t) => t.name)).toEqual([
				"check_connectivity",
				"create_analysis_session",
				"send_session_message",
				"get_session_updates",
				"create_dashboard",
			]);
		});
	});

	describe("Ping Tool", () => {
		it("should return error when not authenticated", async () => {
			const unauthenticatedServer = new MCPServer(
				{
					props: {
						instanceUrl: "",
						accessToken: "",
						clientName: {
							clientId: "test-client-id",
							clientName: "test-client",
							registrationDate: Date.now(),
						},
					},
				},
				new StreamingMessagesStorageWithTtl(null as any, vi.fn(), vi.fn()),
			);
			await unauthenticatedServer.init();

			const { callTool } = connect(unauthenticatedServer);
			const result = await callTool("ping", {});

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toBe(
				"ERROR: Not authenticated",
			);
		});

		it("should return success when authenticated", async () => {
			await server.init();
			const { callTool } = connect(server);

			const result = await callTool("ping", {});

			expect(result.isError).toBeUndefined();
			expect((result.content as any[])[0].text).toBe("Pong");
		});
	});

	describe("Check Connectivity Tool", () => {
		it("should return error when not authenticated", async () => {
			const unauthenticatedServer = new MCPServer(
				{
					props: {
						instanceUrl: "",
						accessToken: "",
						clientName: {
							clientId: "test-client-id",
							clientName: "test-client",
							registrationDate: Date.now(),
						},
					},
				},
				new StreamingMessagesStorageWithTtl(null as any, vi.fn(), vi.fn()),
			);
			await unauthenticatedServer.init();

			const { callTool } = connect(unauthenticatedServer);
			const result = await callTool("check_connectivity", {});

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toBe(
				"ERROR: Access token or instance URL not valid",
			);
		});

		it("should return success when authenticated", async () => {
			await server.init();
			const { callTool } = connect(server);

			const result = await callTool("check_connectivity", {});

			expect(result.isError).toBeUndefined();
			expect((result.content as any[])[0].text).toBe('{"success":true}');
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
			expect((result.structuredContent as any).questions[0].question).toBe(
				"What is the total revenue?",
			);
			expect((result.structuredContent as any).questions[1].question).toBe(
				"How many customers do we have?",
			);
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
				queryGetDecomposedQuery: vi
					.fn()
					.mockRejectedValue(new Error("Service unavailable")),
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

		it("should handle error from service with multiple datasource IDs", async () => {
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
				queryGetDecomposedQuery: vi
					.fn()
					.mockRejectedValue(new Error("Service unavailable")),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			await server.init();
			const { callTool } = connect(server);

			const result = await callTool("getRelevantQuestions", {
				query: "What are the sales?",
				datasourceIds: ["ds-123", "ds-456", "ds-789"],
			});

			// Should use the first datasourceId for the fallback
			expect(result.isError).toBeUndefined();
			const resultText = JSON.parse((result.content as any[])[0].text);
			expect(resultText.questions).toBeInstanceOf(Array);
			expect(resultText.questions[0].question).toBe("What are the sales?");
			expect(resultText.questions[0].datasourceId).toBe("ds-123");
			// Verify structuredContent is also set
			expect((result.structuredContent as any).questions).toEqual(
				resultText.questions,
			);
		});

		it("should handle error from service with empty datasourceIds array", async () => {
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
				queryGetDecomposedQuery: vi
					.fn()
					.mockRejectedValue(new Error("Network error")),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			await server.init();
			const { callTool } = connect(server);

			const result = await callTool("getRelevantQuestions", {
				query: "Show me data",
				datasourceIds: [],
			});

			// Should handle empty array gracefully (fallback to empty string for datasourceId)
			expect(result.isError).toBeUndefined();
			const resultText = JSON.parse((result.content as any[])[0].text);
			expect(resultText.questions).toBeInstanceOf(Array);
			expect(resultText.questions[0].question).toBe("Show me data");
			expect(resultText.questions[0].datasourceId).toBe("");
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
			expect((result.content as any[])[0].text).toBe(
				"No relevant questions found",
			);
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
			expect((result.structuredContent as any).questions[0].question).toBe(
				"What is the total revenue?",
			);
			expect((result.structuredContent as any).questions[1].question).toBe(
				"How many customers do we have?",
			);
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
			expect(result.content as any[]).toHaveLength(1);
			expect((result.structuredContent as any).question).toBe(
				"What is the total revenue?",
			);
			expect((result.structuredContent as any).session_identifier).toBe(
				"session-123",
			);
			expect((result.structuredContent as any).generation_number).toBe(1);
			expect((result.structuredContent as any).frame_url).toBe(
				"https://test.thoughtspot.cloud/?tsmcp=true#/embed/conv-assist-answer?sessionId=session-123&genNo=1&acSessionId=acSession-123&acGenNo=1",
			);
			expect((result.structuredContent as any).data).toBe(
				"The total revenue is $1,000,000",
			);
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
				singleAnswer: vi
					.fn()
					.mockRejectedValue(new Error("Question not found")),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			await server.init();
			const { callTool } = connect(server);

			const result = await callTool("getAnswer", {
				question: "What is the total revenue?",
				datasourceId: "ds-123",
			});

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toBe(
				"ERROR: Encountered an error while creating the answer. Please check your inputs and try again.",
			);
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
			expect((result.content as any[])[0].text).toContain(
				"Liveboard created successfully",
			);
			expect((result.content as any[])[0].text).toContain(
				"https://test.thoughtspot.cloud/#/pinboard/liveboard-123",
			);
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
				importMetadataTML: vi
					.fn()
					.mockRejectedValue(new Error("Failed to create liveboard")),
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
			expect((result.content as any[])[0].text).toBe(
				"ERROR: Encountered an error while creating the liveboard. Please check your inputs and try again.",
			);
		});

		it("should pass answers with correct shape to fetchTMLAndCreateLiveboard", async () => {
			await server.init();
			const { callTool } = connect(server);

			const mockFetchTMLAndCreateLiveboard = vi
				.spyOn(ThoughtSpotService.prototype, "fetchTMLAndCreateLiveboard")
				.mockResolvedValue({
					url: "https://test.thoughtspot.cloud/#/pinboard/liveboard-123",
					error: null,
				});

			await callTool("createLiveboard", {
				name: "Revenue Dashboard",
				answers: [
					{
						question: "What is the total revenue?",
						session_identifier: "session-123",
						generation_number: 1,
					},
					{
						question: "How many customers?",
						session_identifier: "session-456",
						generation_number: 2,
					},
				],
				noteTile: "<p>Summary</p>",
			});

			expect(mockFetchTMLAndCreateLiveboard).toHaveBeenCalledWith(
				"Revenue Dashboard",
				[
					{
						title: "What is the total revenue?",
						session_identifier: "session-123",
						generation_number: 1,
					},
					{
						title: "How many customers?",
						session_identifier: "session-456",
						generation_number: 2,
					},
				],
				"<p>Summary</p>",
			);
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
					params: { uri: "datasource:///ds-123" },
				});

				expect(result.contents).toHaveLength(1);
				expect(result.contents[0]).toEqual({
					uri: "datasource:///ds-123",
					mimeType: "text/plain",
					text: expect.stringContaining("Sales data for the current year"),
				});
				expect(result.contents[0].text).toContain(
					"The id of the datasource is ds-123",
				);
				expect(result.contents[0].text).toContain(
					"Use ThoughtSpot's getRelevantQuestions tool",
				);
			});

			it("should return resource content for second datasource", async () => {
				await server.init();

				const result = await server.readResource({
					method: "resources/read",
					params: { uri: "datasource:///ds-456" },
				});

				expect(result.contents).toHaveLength(1);
				expect(result.contents[0]).toEqual({
					uri: "datasource:///ds-456",
					mimeType: "text/plain",
					text: expect.stringContaining(
						"Customer information and demographics",
					),
				});
				expect(result.contents[0].text).toContain(
					"The id of the datasource is ds-456",
				);
				expect(result.contents[0].text).toContain(
					"Use ThoughtSpot's getRelevantQuestions tool",
				);
			});

			it("should throw 404 error for invalid datasource URI format", async () => {
				await server.init();

				await expect(
					server.readResource({
						method: "resources/read",
						params: { uri: "invalid-uri" },
					}),
				).rejects.toThrow("Datasource not found");
			});

			it("should throw 400 error for URI without datasource ID", async () => {
				await server.init();

				await expect(
					server.readResource({
						method: "resources/read",
						params: { uri: "datasource:///" },
					}),
				).rejects.toThrow("Invalid datasource uri");
			});

			it("should throw 404 error for non-existent datasource", async () => {
				await server.init();

				await expect(
					server.readResource({
						method: "resources/read",
						params: { uri: "datasource:///non-existent-id" },
					}),
				).rejects.toThrow("Datasource not found");
			});

			it("should throw 404 error for malformed URI", async () => {
				await server.init();

				await expect(
					server.readResource({
						method: "resources/read",
						params: { uri: "datasource://" },
					}),
				).rejects.toThrow("Datasource not found");
			});

			it("should throw 400 error for empty URI", async () => {
				await server.init();

				await expect(
					server.readResource({
						method: "resources/read",
						params: { uri: "" },
					}),
				).rejects.toThrow("Invalid datasource uri");
			});

			it("should use cached datasources for resource lookup", async () => {
				await server.init();

				// First call should fetch from service
				await server.readResource({
					method: "resources/read",
					params: { uri: "datasource:///ds-123" },
				});
				const mockGetClient = vi.mocked(thoughtspotClient.getThoughtSpotClient);
				const mockClientInstance = mockGetClient.mock.results[0].value;
				expect(mockClientInstance.searchMetadata).toHaveBeenCalledTimes(1);

				// Second call should use cached data
				await server.readResource({
					method: "resources/read",
					params: { uri: "datasource:///ds-456" },
				});
				expect(mockClientInstance.searchMetadata).toHaveBeenCalledTimes(1);
			});
		});
	});

	describe("getDataSourceSuggestions Tool", () => {
		it("should return data source suggestions successfully", async () => {
			// Mock getDataSourceSuggestions method
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
				getDataSourceSuggestions: vi.fn().mockResolvedValue({
					data_sources: [
						{
							confidence: 0.85,
							details: {
								description: "Sales data for the current year",
								data_source_name: "Sales Data",
								data_source_identifier: "ds-123",
							},
							reasoning:
								"This data source contains sales information relevant to your query",
						},
						{
							confidence: 0.75,
							details: {
								description: "Revenue analysis data",
								data_source_name: "Revenue Data",
								data_source_identifier: "ds-456",
							},
							reasoning: "This data source contains revenue information",
						},
					],
				}),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			await server.init();
			const { callTool } = connect(server);

			const result = await callTool("getDataSourceSuggestions", {
				query: "show me sales revenue data",
			});

			expect(result.isError).toBeUndefined();

			const suggestionsData = JSON.parse((result.content as any[])[0].text);
			expect(suggestionsData).toHaveLength(2);
			expect(suggestionsData[0]).toEqual({
				header: {
					description: "Sales data for the current year",
					displayName: "Sales Data",
					guid: "ds-123",
				},
				confidence: 0.85,
				llmReasoning:
					"This data source contains sales information relevant to your query",
			});
			expect(suggestionsData[1]).toEqual({
				header: {
					description: "Revenue analysis data",
					displayName: "Revenue Data",
					guid: "ds-456",
				},
				confidence: 0.75,
				llmReasoning: "This data source contains revenue information",
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
				getDataSourceSuggestions: vi.fn().mockResolvedValue({
					dataSources: [],
				}),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			await server.init();
			const { callTool } = connect(server);

			const result = await callTool("getDataSourceSuggestions", {
				query: "nonexistent data query",
			});

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toBe(
				"ERROR: No data source suggestions found",
			);
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
				getDataSourceSuggestions: vi.fn().mockResolvedValue({
					data_sources: [
						{
							confidence: 0.95,
							details: {
								description: "Customer analytics data",
								data_source_name: "Customer Data",
								data_source_identifier: "ds-789",
							},
							reasoning: "Perfect match for customer-related queries",
						},
					],
				}),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			await server.init();
			const { callTool } = connect(server);

			const result = await callTool("getDataSourceSuggestions", {
				query: "customer analytics",
			});

			expect(result.isError).toBeUndefined();

			const suggestionsData = JSON.parse((result.content as any[])[0].text);
			expect(suggestionsData).toHaveLength(1);
			expect(suggestionsData[0].header.guid).toBe("ds-789");
			expect(suggestionsData[0].confidence).toBe(0.95);
		});
	});

	describe("Create Analysis Session Tool", () => {
		it("should create a session and return analytical_session_id", async () => {
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
				createAgentConversationWithAutoMode: vi.fn().mockResolvedValue({
					conversation_id: "conv-abc-123",
				}),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			await server.init();
			const { callTool } = connect(server);

			const result = await callTool("create_analysis_session", {});

			expect(result.isError).toBeUndefined();
			expect((result.structuredContent as any).analytical_session_id).toBe(
				"conv-abc-123",
			);
		});

		it("should create a session with a data_source_id", async () => {
			const mockCreateAgentConversationWithAutoMode = vi
				.fn()
				.mockResolvedValue({
					conversation_id: "conv-with-ds-456",
				});

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
				createAgentConversationWithAutoMode:
					mockCreateAgentConversationWithAutoMode,
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			await server.init();
			const { callTool } = connect(server);

			const result = await callTool("create_analysis_session", {
				data_source_id: "ds-123",
			});

			expect(result.isError).toBeUndefined();
			expect((result.structuredContent as any).analytical_session_id).toBe(
				"conv-with-ds-456",
			);
			expect(mockCreateAgentConversationWithAutoMode).toHaveBeenCalledWith({
				dataSourceId: "ds-123",
			});
		});

		it("should handle error from service", async () => {
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
				createAgentConversationWithAutoMode: vi
					.fn()
					.mockRejectedValue(new Error("Failed to create conversation")),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			await server.init();

			await expect(
				server.callCreateAnalysisSession({
					method: "tools/call",
					params: { name: "create_analysis_session", arguments: {} },
				}),
			).rejects.toThrow("Failed to create conversation");
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

	describe("Send Session Message Tool", () => {
		it("should return success when message is sent successfully", async () => {
			const mockStream = new ReadableStream({
				start(c) {
					c.close();
				},
			});
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
				sendAgentConversationMessageStreaming: vi
					.fn()
					.mockResolvedValue({ body: mockStream }),
				instanceUrl: "https://test.thoughtspot.cloud",
			} as any);

			vi.spyOn(server as any, "getStorageService").mockReturnValue({
				initializeConversation: vi.fn().mockResolvedValue(undefined),
				appendMessages: vi.fn().mockResolvedValue(undefined),
			});
			await server.init();

			const { callTool } = connect(server);
			const result = await callTool("send_session_message", {
				analytical_session_id: "session-abc-123",
				message: "What is the total revenue?",
			});

			expect(result.isError).toBeUndefined();
			expect((result.structuredContent as any).success).toBe(true);
		});

		it("should return error when conversation has an ongoing message", async () => {
			vi.spyOn(server as any, "getStorageService").mockReturnValue({
				initializeConversation: vi
					.fn()
					.mockRejectedValue(
						new Error("Conversation already exists and is not marked done"),
					),
			});
			await server.init();

			const { callTool } = connect(server);
			const result = await callTool("send_session_message", {
				analytical_session_id: "session-abc-123",
				message: "Follow-up question",
			});

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toContain(
				"The analytical session has an ongoing response",
			);
		});

		it("should propagate error when streaming service throws", async () => {
			vi.spyOn(server as any, "getStorageService").mockReturnValue({
				initializeConversation: vi.fn().mockResolvedValue(undefined),
				appendMessages: vi.fn().mockResolvedValue(undefined),
			});
			await server.init();
			vi.spyOn(server as any, "getThoughtSpotService").mockReturnValue({
				sendAgentConversationMessageStreaming: vi
					.fn()
					.mockRejectedValue(new Error("Service unavailable")),
			});

			await expect(
				server.callSendSessionMessage({
					method: "tools/call",
					params: {
						name: "send_session_message",
						arguments: {
							analytical_session_id: "session-err-123",
							message: "test",
						},
					},
				}),
			).rejects.toThrow("Service unavailable");
		});
	});

	describe("Get Session Updates Tool", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("should poll and return all updates in order when conversation is marked done", async () => {
			const textUpdate = {
				type: "text" as const,
				text: "Analyzing revenue data...",
				is_thinking: true,
			};
			const answerUpdate = {
				type: "answer" as const,
				answer_id: JSON.stringify({ session_id: "s1", gen_no: 1 }),
				answer_title: "Revenue Chart",
				answer_query: "revenue by region",
				iframe_url: "https://test.thoughtspot.cloud/?tsmcp=true#/embed/test",
				is_thinking: false,
			};

			vi.spyOn(server as any, "getStorageService").mockReturnValue({
				getNewMessages: vi.fn().mockResolvedValue({
					messages: [textUpdate, answerUpdate],
					isDone: true,
				}),
			});
			await server.init();

			const { callTool } = connect(server);
			const result = await callTool("get_session_updates", {
				analytical_session_id: "session-abc-123",
			});

			expect(result.isError).toBeUndefined();
			const content = result.structuredContent as any;
			expect(content.is_done).toBe(true);
			expect(content.session_updates).toHaveLength(2);
			expect(content.session_updates[0]).toEqual(textUpdate);
			expect(content.session_updates[1]).toEqual(answerUpdate);
		});

		it("should return empty updates with is_done false after 10 seconds of no activity", async () => {
			vi.useFakeTimers();

			const mockGetNewMessages = vi
				.fn()
				.mockResolvedValue({ messages: [], isDone: false });

			vi.spyOn(server as any, "getStorageService").mockReturnValue({
				getNewMessages: mockGetNewMessages,
			});
			await server.init();

			const resultPromise = server.callGetSessionUpdates({
				method: "tools/call",
				params: {
					name: "get_session_updates",
					arguments: { analytical_session_id: "session-abc-123" },
				},
			});

			await vi.advanceTimersByTimeAsync(10500);
			const result = await resultPromise;

			expect(result.isError).toBeUndefined();
			const content = result.structuredContent as any;
			expect(content.session_updates).toEqual([]);
			expect(content.is_done).toBe(false);
			expect(mockGetNewMessages).toHaveBeenCalledTimes(20);
		});

		it("should not return early when messages arrive before the 3-second minimum wait", async () => {
			vi.useFakeTimers();

			const msg = {
				type: "text" as const,
				text: "Still thinking...",
				is_thinking: true,
			};
			const mockGetNewMessages = vi
				.fn()
				.mockResolvedValue({ messages: [msg], isDone: false });

			vi.spyOn(server as any, "getStorageService").mockReturnValue({
				getNewMessages: mockGetNewMessages,
			});
			await server.init();

			const resultPromise = server.callGetSessionUpdates({
				method: "tools/call",
				params: {
					name: "get_session_updates",
					arguments: { analytical_session_id: "session-early-123" },
				},
			});

			// Before 3 seconds (i < 6), messages present but gate not open — should still be pending
			await vi.advanceTimersByTimeAsync(2500);
			const raceResult = await Promise.race([
				resultPromise,
				Promise.resolve("pending"),
			]);
			expect(raceResult).toBe("pending");

			// Let the full 10s timeout exhaust
			await vi.advanceTimersByTimeAsync(8000);
			const result = await resultPromise;
			expect(result.isError).toBeUndefined();
			const content = result.structuredContent as any;
			expect(content.is_done).toBe(false);
			expect(content.session_updates.length).toBeGreaterThan(0);
		});

		it("should accumulate messages from multiple poll iterations before returning", async () => {
			vi.useFakeTimers();

			const msg1 = {
				type: "text" as const,
				text: "Thinking...",
				is_thinking: true,
			};
			const msg2 = { type: "text" as const, text: "Done.", is_thinking: false };
			const mockGetNewMessages = vi
				.fn()
				.mockResolvedValueOnce({ messages: [msg1], isDone: false })
				.mockResolvedValueOnce({ messages: [msg2], isDone: false })
				.mockResolvedValue({ messages: [], isDone: true });

			vi.spyOn(server as any, "getStorageService").mockReturnValue({
				getNewMessages: mockGetNewMessages,
			});
			await server.init();

			const resultPromise = server.callGetSessionUpdates({
				method: "tools/call",
				params: {
					name: "get_session_updates",
					arguments: { analytical_session_id: "session-accum-123" },
				},
			});

			// Drive enough iterations: two 500ms sleeps to reach the third poll that returns isDone:true
			await vi.advanceTimersByTimeAsync(1100);
			const result = await resultPromise;

			expect(result.isError).toBeUndefined();
			const content = result.structuredContent as any;
			expect(content.is_done).toBe(true);
			expect(content.session_updates).toEqual([msg1, msg2]);
		});

		it("should return partial results after 3 seconds when not done", async () => {
			vi.useFakeTimers();

			const msg = {
				type: "text" as const,
				text: "Partial update",
				is_thinking: false,
			};
			const mockGetNewMessages = vi
				.fn()
				.mockResolvedValue({ messages: [msg], isDone: false });

			vi.spyOn(server as any, "getStorageService").mockReturnValue({
				getNewMessages: mockGetNewMessages,
			});
			await server.init();

			const resultPromise = server.callGetSessionUpdates({
				method: "tools/call",
				params: {
					name: "get_session_updates",
					arguments: { analytical_session_id: "session-partial-123" },
				},
			});

			// Advance past 3 seconds (7 iterations × 500ms = 3500ms) to trigger i >= 6 gate
			await vi.advanceTimersByTimeAsync(3500);
			const result = await resultPromise;

			expect(result.isError).toBeUndefined();
			const content = result.structuredContent as any;
			expect(content.is_done).toBe(false);
			expect(content.session_updates.length).toBeGreaterThan(0);
			expect(content.session_updates[0]).toEqual(msg);
		});
	});

	describe("Create Dashboard Tool", () => {
		beforeEach(async () => {
			await server.init();
		});

		it("should create dashboard and return a URL link on success", async () => {
			vi.spyOn(server as any, "getThoughtSpotService").mockReturnValue({
				fetchTMLAndCreateLiveboard: vi.fn().mockResolvedValue({
					url: "https://test.thoughtspot.cloud/#/pinboard/dashboard-guid-123",
					error: null,
				}),
			});

			const { callTool } = connect(server);
			const result = await callTool("create_dashboard", {
				title: "Q1 Revenue Dashboard",
				note_tile: "<p>Q1 Revenue Analysis. Generated on 2026-05-05</p>",
				answers: [
					{
						answer_id: JSON.stringify({ session_id: "sess-1", gen_no: 1 }),
						title: "Revenue by Region",
					},
				],
			});

			expect(result.isError).toBeUndefined();
			const content = result.structuredContent as any;
			expect(content.link).toBe(
				"https://test.thoughtspot.cloud/#/pinboard/dashboard-guid-123",
			);
		});

		it("should return error when answer_id has invalid format", async () => {
			const { callTool } = connect(server);

			const result = await callTool("create_dashboard", {
				title: "Dashboard",
				note_tile: "<p>Summary</p>",
				answers: [{ answer_id: "not-valid-json", title: "Revenue" }],
			});

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toContain(
				"Invalid answer_id format",
			);
		});

		it("should return error when answers list is empty", async () => {
			vi.spyOn(server as any, "getThoughtSpotService").mockReturnValue({
				fetchTMLAndCreateLiveboard: vi.fn().mockResolvedValue({
					error: new Error("No visualizations to import"),
				}),
			});

			const { callTool } = connect(server);
			const result = await callTool("create_dashboard", {
				title: "Empty Dashboard",
				note_tile: "<p>Summary</p>",
				answers: [],
			});

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toContain(
				"Encountered an error while creating the dashboard",
			);
		});

		it("should return error when answer_id is valid JSON but missing required fields", async () => {
			const { callTool } = connect(server);

			const result = await callTool("create_dashboard", {
				title: "Dashboard",
				note_tile: "<p>Summary</p>",
				answers: [
					{ answer_id: JSON.stringify({ wrong_key: "foo" }), title: "Chart" },
				],
			});

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toContain(
				"Invalid answer_id format",
			);
		});

		it("should forward title, note_tile, and correctly transform multiple answers", async () => {
			const mockFetchTML = vi.fn().mockResolvedValue({
				url: "https://test.thoughtspot.cloud/#/pinboard/multi-123",
				error: null,
			});

			vi.spyOn(server as any, "getThoughtSpotService").mockReturnValue({
				fetchTMLAndCreateLiveboard: mockFetchTML,
			});

			const { callTool } = connect(server);
			const result = await callTool("create_dashboard", {
				title: "My Dashboard",
				note_tile: "<p>Analysis summary</p>",
				answers: [
					{
						answer_id: JSON.stringify({ session_id: "s1", gen_no: 1 }),
						title: "Chart A",
					},
					{
						answer_id: JSON.stringify({ session_id: "s2", gen_no: 2 }),
						title: "Chart B",
					},
				],
			});

			expect(result.isError).toBeUndefined();
			expect(mockFetchTML).toHaveBeenCalledWith(
				"My Dashboard",
				[
					{ title: "Chart A", session_identifier: "s1", generation_number: 1 },
					{ title: "Chart B", session_identifier: "s2", generation_number: 2 },
				],
				"<p>Analysis summary</p>",
			);
		});
	});

	describe("V2 End-to-End Scenarios", () => {
		it("should execute session message and update flow returning responses in order", async () => {
			const expectedMessages = [
				{ type: "text" as const, text: "Thinking...", is_thinking: true },
				{
					type: "text" as const,
					text: "Total revenue is $5M.",
					is_thinking: false,
				},
			];

			const storage = new Map<string, any>();
			const mockStorage = {
				initializeConversation: vi
					.fn()
					.mockImplementation(async (id: string) => {
						storage.set(id, { messages: [], isDone: false, bookmark: 0 });
					}),
				appendMessages: vi
					.fn()
					.mockImplementation(
						async (id: string, msgs: any[], isDone = false) => {
							const state = storage.get(id);
							state.messages.push(...msgs);
							state.isDone = isDone;
						},
					),
				getNewMessages: vi.fn().mockImplementation(async (id: string) => {
					const state = storage.get(id);
					if (!state) return { messages: [], isDone: false };
					const newMsgs = state.messages.slice(state.bookmark);
					state.bookmark = state.messages.length;
					return { messages: newMsgs, isDone: state.isDone };
				}),
			};

			vi.spyOn(server as any, "getStorageService").mockReturnValue(mockStorage);
			await server.init();

			// Spy on service after init() so init() uses the default mock for getSessionInfo
			vi.spyOn(server as any, "getThoughtSpotService").mockReturnValue({
				sendAgentConversationMessageStreaming: vi
					.fn()
					.mockImplementation(
						async (convId: string, _msg: string, appendFn: any) => {
							await appendFn(convId, [expectedMessages[0]]);
							await appendFn(convId, [expectedMessages[1]], true);
						},
					),
			});

			const sendResult = await server.callSendSessionMessage(
				makeRequest("send_session_message", {
					analytical_session_id: "session-e2e-123",
					message: "What is the total revenue?",
				}),
			);
			expect(sendResult.isError).toBeUndefined();
			expect((sendResult.structuredContent as any).success).toBe(true);

			const updatesResult = await server.callGetSessionUpdates(
				makeRequest("get_session_updates", {
					analytical_session_id: "session-e2e-123",
				}),
			);
			expect(updatesResult.isError).toBeUndefined();
			const content = updatesResult.structuredContent as any;
			expect(content.is_done).toBe(true);
			expect(content.session_updates).toHaveLength(2);
			expect(content.session_updates[0]).toEqual(expectedMessages[0]);
			expect(content.session_updates[1]).toEqual(expectedMessages[1]);
		});

		it("should use the same conversation id for multiple messages in a session", async () => {
			const mockSendStreaming = vi
				.fn()
				.mockImplementation(
					async (convId: string, _msg: string, appendFn: any) => {
						await appendFn(convId, [], true);
					},
				);

			vi.spyOn(server as any, "getStorageService").mockReturnValue({
				initializeConversation: vi.fn().mockResolvedValue(undefined),
				appendMessages: vi.fn().mockResolvedValue(undefined),
			});
			await server.init();
			vi.spyOn(server as any, "getThoughtSpotService").mockReturnValue({
				sendAgentConversationMessageStreaming: mockSendStreaming,
			});

			await server.callSendSessionMessage(
				makeRequest("send_session_message", {
					analytical_session_id: "shared-session-123",
					message: "What is total revenue?",
				}),
			);
			await server.callSendSessionMessage(
				makeRequest("send_session_message", {
					analytical_session_id: "shared-session-123",
					message: "Break it down by region",
				}),
			);

			expect(mockSendStreaming).toHaveBeenCalledTimes(2);
			expect(mockSendStreaming.mock.calls[0][0]).toBe("shared-session-123");
			expect(mockSendStreaming.mock.calls[1][0]).toBe("shared-session-123");
		});

		it("should pass additional context to the agent only when provided", async () => {
			const mockSendStreaming = vi
				.fn()
				.mockImplementation(
					async (convId: string, _msg: string, appendFn: any) => {
						await appendFn(convId, [], true);
					},
				);

			vi.spyOn(server as any, "getStorageService").mockReturnValue({
				initializeConversation: vi.fn().mockResolvedValue(undefined),
				appendMessages: vi.fn().mockResolvedValue(undefined),
			});
			await server.init();
			vi.spyOn(server as any, "getThoughtSpotService").mockReturnValue({
				sendAgentConversationMessageStreaming: mockSendStreaming,
			});

			await server.callSendSessionMessage(
				makeRequest("send_session_message", {
					analytical_session_id: "session-no-ctx",
					message: "What is total revenue?",
				}),
			);
			await server.callSendSessionMessage(
				makeRequest("send_session_message", {
					analytical_session_id: "session-with-ctx",
					message: "What is total revenue?",
					additional_context: "Fiscal year starts in April",
				}),
			);

			// Without context: additional_context arg is undefined
			expect(mockSendStreaming.mock.calls[0][3]).toBeUndefined();
			// With context: additional_context is forwarded to the service
			expect(mockSendStreaming.mock.calls[1][3]).toBe(
				"Fiscal year starts in April",
			);
		});
	});
});
