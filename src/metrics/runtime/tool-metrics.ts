import { ZodError } from "zod";
import { McpServerError } from "../../utils";
import {
	type ApiVersionMode,
	METRIC_NAMES,
	type MetricLabelInput,
	type MetricOutcome,
} from "./metric-types";
import type { MetricsRecorder } from "./metrics-recorder";

export const UPSTREAM_OPERATION_NAMES = {
	getSessionInfo: "get_session_info",
	getDataSourceSuggestions: "get_data_source_suggestions",
	queryGetDecomposedQuery: "query_get_decomposed_query",
	singleAnswer: "single_answer",
	exportAnswerReport: "export_answer_report",
	getAnswerSession: "get_answer_session",
	exportUnsavedAnswerTml: "export_unsaved_answer_tml",
	createAgentConversation: "create_agent_conversation",
	sendAgentConversationMessageStreaming:
		"send_agent_conversation_message_streaming",
	importMetadataTml: "import_metadata_tml",
	searchMetadata: "search_metadata",
	getAuditLogs: "get_audit_logs",
} as const;

export type UpstreamOperation =
	(typeof UPSTREAM_OPERATION_NAMES)[keyof typeof UPSTREAM_OPERATION_NAMES];

export type ToolMetricApiSurface = "mcp";
export type UpstreamStreamMessageType =
	| "text"
	| "text_chunk"
	| "answer"
	| "error";

function buildToolMetricLabels(
	toolName: string,
	apiSurface: ToolMetricApiSurface,
	outcome: MetricOutcome,
	apiVersion?: string,
	apiVersionMode?: ApiVersionMode,
	apiReleaseDate?: string,
): MetricLabelInput {
	const labels: MetricLabelInput = {
		tool_name: toolName,
		api_surface: apiSurface,
		outcome,
	};

	if (apiVersion) {
		labels.api_version = apiVersion;
	}
	if (apiVersionMode) {
		labels.api_version_mode = apiVersionMode;
	}
	if (apiReleaseDate) {
		labels.api_release_date = apiReleaseDate;
	}

	return labels;
}

export function getToolMetricOutcomeFromResult(result: unknown): MetricOutcome {
	if (
		typeof result === "object" &&
		result !== null &&
		"isError" in result &&
		result.isError === true
	) {
		return "error";
	}

	return "success";
}

export function getToolMetricOutcomeFromError(error: unknown): MetricOutcome {
	if (error instanceof ZodError) {
		return "validation_error";
	}

	if (error instanceof McpServerError) {
		if (error.statusCode >= 400 && error.statusCode < 500) {
			return "client_error";
		}
		return "error";
	}

	return "error";
}

export function recordToolInvocationMetrics(
	recorder: MetricsRecorder,
	toolName: string,
	apiSurface: ToolMetricApiSurface,
	outcome: MetricOutcome,
	durationMs: number,
	apiVersion?: string,
	apiVersionMode?: ApiVersionMode,
	apiReleaseDate?: string,
): void {
	const labels = buildToolMetricLabels(
		toolName,
		apiSurface,
		outcome,
		apiVersion,
		apiVersionMode,
		apiReleaseDate,
	);

	recorder.count(METRIC_NAMES.toolCallsTotal, 1, labels);
	recorder.histogram(METRIC_NAMES.toolDurationMs, durationMs, labels);
}

export function recordUpstreamCallMetrics(
	recorder: MetricsRecorder | undefined,
	operation: UpstreamOperation,
	outcome: MetricOutcome,
	durationMs: number,
): void {
	if (!recorder) {
		return;
	}

	const labels: MetricLabelInput = {
		upstream_operation: operation,
		outcome,
	};

	recorder.count(METRIC_NAMES.upstreamCallsTotal, 1, labels);
	recorder.histogram(METRIC_NAMES.upstreamDurationMs, durationMs, labels);
}

export function recordUpstreamStreamStartedMetric(
	recorder: MetricsRecorder | undefined,
	operation: UpstreamOperation,
	outcome: MetricOutcome,
): void {
	if (!recorder) {
		return;
	}

	recorder.count(METRIC_NAMES.upstreamStreamsStartedTotal, 1, {
		upstream_operation: operation,
		outcome,
	});
}

export function recordUpstreamStreamMessageMetric(
	recorder: MetricsRecorder | undefined,
	operation: UpstreamOperation,
	messageType: UpstreamStreamMessageType,
	isThinking: boolean,
): void {
	if (!recorder) {
		return;
	}

	recorder.count(METRIC_NAMES.upstreamStreamMessagesTotal, 1, {
		upstream_operation: operation,
		message_type: messageType,
		is_thinking: isThinking,
	});
}
