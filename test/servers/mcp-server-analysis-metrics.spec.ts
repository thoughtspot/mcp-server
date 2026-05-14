import { beforeEach, describe, expect, it, vi } from "vitest";
import { METRIC_NAMES } from "../../src/metrics/runtime/metric-types";
import { createRequestMetricsRecorder } from "../../src/metrics/runtime/request-metrics";
import { MCPServer } from "../../src/servers/mcp-server";

function metricDataPoints(
	analyticsDataset: { writeDataPoint: ReturnType<typeof vi.fn> },
	metricName: string,
) {
	return analyticsDataset.writeDataPoint.mock.calls
		.map(([dataPoint]) => dataPoint)
		.filter((dataPoint) => dataPoint.blobs?.[2] === metricName);
}

function createServerAndRecorder() {
	const analyticsDataset = {
		writeDataPoint: vi.fn(),
	};
	const server = new MCPServer(
		{
			props: {
				instanceUrl: "https://test.thoughtspot.cloud",
				accessToken: "test-access-token",
				apiVersion: "latest",
				apiRequestedVersion: "latest",
				apiVersionMode: "explicit_latest",
			},
			env: {
				METRICS_SINK_MODE: "analytics_engine",
				ANALYTICS: analyticsDataset,
			} as any,
		} as any,
		{} as any,
	);
	(server as any).sessionInfo = {
		clusterId: "cluster-123",
		currentOrgId: "org-123",
		userGUID: "user-123",
	};

	const recorder = createRequestMetricsRecorder({
		METRICS_SINK_MODE: "analytics_engine",
		ANALYTICS: analyticsDataset,
	});
	recorder.setAnalyticsContext({
		apiRequestedVersion: "latest",
	});
	recorder.setEventIdentity({
		tenantId: "cluster-123",
		userId: "user-123",
	});

	return { analyticsDataset, server, recorder };
}

describe("MCPServer analysis metrics", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("records analysis session creation metrics with the resolved session id", async () => {
		const { analyticsDataset, recorder, server } = createServerAndRecorder();
		vi.spyOn(server as any, "getThoughtSpotService").mockReturnValue({
			createAgentConversation: vi.fn().mockResolvedValue({
				conversation_id: "conv-123",
			}),
		});

		await server.callCreateAnalysisSession(
			{
				method: "tools/call",
				params: { name: "create_analysis_session", arguments: {} },
			} as any,
			recorder,
		);
		await recorder.flush();

		expect(
			metricDataPoints(
				analyticsDataset,
				METRIC_NAMES.analysisSessionsCreatedTotal,
			),
		).toEqual([
			expect.objectContaining({
				indexes: ["cluster-123"],
				blobs: expect.arrayContaining([
					METRIC_NAMES.analysisSessionsCreatedTotal,
					"conv-123",
				]),
			}),
		]);
	});

	it("records send-session metrics and initializes storage with timing context", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);

		const { analyticsDataset, recorder, server } = createServerAndRecorder();
		const storageService = {
			initializeConversation: vi.fn().mockResolvedValue(undefined),
			appendMessages: vi.fn().mockResolvedValue(undefined),
		};
		vi.spyOn(server as any, "getStorageService").mockReturnValue(
			storageService,
		);
		vi.spyOn(server as any, "getThoughtSpotService").mockReturnValue({
			sendAgentConversationMessageStreaming: vi
				.fn()
				.mockResolvedValue(undefined),
		});

		await server.callSendSessionMessage(
			{
				method: "tools/call",
				params: {
					name: "send_session_message",
					arguments: {
						analytical_session_id: "conv-123",
						message: "Show me revenue",
					},
				},
			} as any,
			recorder,
		);
		await recorder.flush();

		expect(storageService.initializeConversation).toHaveBeenCalledWith(
			"conv-123",
			expect.objectContaining({
				responseStartedAtMs: 1_000,
				apiRequestedVersion: "latest",
				analyticalSessionId: "conv-123",
				tenantId: "cluster-123",
				userId: "user-123",
			}),
		);
		expect(
			metricDataPoints(
				analyticsDataset,
				METRIC_NAMES.analysisMessagesSentTotal,
			),
		).toEqual([
			expect.objectContaining({
				indexes: ["cluster-123"],
				blobs: expect.arrayContaining([
					METRIC_NAMES.analysisMessagesSentTotal,
					"conv-123",
				]),
			}),
		]);

		vi.useRealTimers();
	});

	it("records polling counters and poll wait while marking first non-empty delivery", async () => {
		const { analyticsDataset, recorder, server } = createServerAndRecorder();
		const storageService = {
			getNewMessages: vi.fn().mockResolvedValue({
				messages: [{ type: "text", text: "hello", is_thinking: false }],
				isDone: true,
			}),
		};
		vi.spyOn(server as any, "getStorageService").mockReturnValue(
			storageService,
		);

		const result = await server.callGetSessionUpdates(
			{
				method: "tools/call",
				params: {
					name: "get_session_updates",
					arguments: {
						analytical_session_id: "conv-123",
					},
				},
			} as any,
			recorder,
		);
		await recorder.flush();

		expect(result.structuredContent).toEqual({
			session_updates: [{ type: "text", text: "hello", is_thinking: false }],
			is_done: true,
		});
		expect(
			metricDataPoints(
				analyticsDataset,
				METRIC_NAMES.analysisUpdatesPolledTotal,
			),
		).toEqual([
			expect.objectContaining({
				indexes: ["cluster-123"],
				blobs: expect.arrayContaining([
					METRIC_NAMES.analysisUpdatesPolledTotal,
					"conv-123",
				]),
			}),
		]);
		expect(
			metricDataPoints(analyticsDataset, METRIC_NAMES.analysisPollWaitMs),
		).toHaveLength(1);
	});
});
