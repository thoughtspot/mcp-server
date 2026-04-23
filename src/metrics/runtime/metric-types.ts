export const HISTOGRAM_BUCKETS_MS = [
	25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
] as const;

export const METRIC_NAMES = {
	httpRequestsTotal: "ts_mcp_http_requests_total",
	httpRequestDurationMs: "ts_mcp_http_request_duration_ms",
	httpInflightRequests: "ts_mcp_http_inflight_requests",
	sessionsStartedTotal: "ts_mcp_sessions_started_total",
	toolCallsTotal: "ts_mcp_tool_calls_total",
	toolDurationMs: "ts_mcp_tool_duration_ms",
	resourceReadsTotal: "ts_mcp_resource_reads_total",
	oauthAuthorizeRequestsTotal: "ts_mcp_oauth_authorize_requests_total",
	oauthAuthorizeSubmitTotal: "ts_mcp_oauth_authorize_submit_total",
	oauthCallbackTotal: "ts_mcp_oauth_callback_total",
	oauthStoreTokenTotal: "ts_mcp_oauth_store_token_total",
	bearerAuthRequestsTotal: "ts_mcp_bearer_auth_requests_total",
	upstreamCallsTotal: "ts_mcp_upstream_calls_total",
	upstreamDurationMs: "ts_mcp_upstream_duration_ms",
	upstreamStreamsStartedTotal: "ts_mcp_upstream_streams_started_total",
	upstreamStreamMessagesTotal: "ts_mcp_upstream_stream_messages_total",
	analysisSessionsCreatedTotal: "ts_mcp_analysis_sessions_created_total",
	analysisMessagesSentTotal: "ts_mcp_analysis_messages_sent_total",
	analysisUpdatesPolledTotal: "ts_mcp_analysis_updates_polled_total",
	analysisPollWaitMs: "ts_mcp_analysis_poll_wait_ms",
	analysisFirstBufferedUpdateMs: "ts_mcp_analysis_first_buffered_update_ms",
	analysisFirstPollDelayMs: "ts_mcp_analysis_first_poll_delay_ms",
	analysisFirstNonEmptyResponseMs:
		"ts_mcp_analysis_first_non_empty_response_ms",
	analysisSessionsNeverPolledTotal:
		"ts_mcp_analysis_sessions_never_polled_total",
	streamStorageErrorsTotal: "ts_mcp_stream_storage_errors_total",
	dashboardsCreatedTotal: "ts_mcp_dashboards_created_total",
	dashboardTilesCount: "ts_mcp_dashboard_tiles_count",
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];
export type MetricKind = "counter" | "histogram" | "gauge";

const COUNTER_METRIC_NAMES = new Set<MetricName>([
	METRIC_NAMES.httpRequestsTotal,
	METRIC_NAMES.sessionsStartedTotal,
	METRIC_NAMES.toolCallsTotal,
	METRIC_NAMES.resourceReadsTotal,
	METRIC_NAMES.oauthAuthorizeRequestsTotal,
	METRIC_NAMES.oauthAuthorizeSubmitTotal,
	METRIC_NAMES.oauthCallbackTotal,
	METRIC_NAMES.oauthStoreTokenTotal,
	METRIC_NAMES.bearerAuthRequestsTotal,
	METRIC_NAMES.upstreamCallsTotal,
	METRIC_NAMES.upstreamStreamsStartedTotal,
	METRIC_NAMES.upstreamStreamMessagesTotal,
	METRIC_NAMES.analysisSessionsCreatedTotal,
	METRIC_NAMES.analysisMessagesSentTotal,
	METRIC_NAMES.analysisUpdatesPolledTotal,
	METRIC_NAMES.analysisSessionsNeverPolledTotal,
	METRIC_NAMES.streamStorageErrorsTotal,
	METRIC_NAMES.dashboardsCreatedTotal,
]);

const HISTOGRAM_METRIC_NAMES = new Set<MetricName>([
	METRIC_NAMES.httpRequestDurationMs,
	METRIC_NAMES.toolDurationMs,
	METRIC_NAMES.upstreamDurationMs,
	METRIC_NAMES.analysisPollWaitMs,
	METRIC_NAMES.analysisFirstBufferedUpdateMs,
	METRIC_NAMES.analysisFirstPollDelayMs,
	METRIC_NAMES.analysisFirstNonEmptyResponseMs,
	METRIC_NAMES.dashboardTilesCount,
]);

const GAUGE_METRIC_NAMES = new Set<MetricName>([
	METRIC_NAMES.httpInflightRequests,
]);

export function getMetricKind(name: MetricName): MetricKind {
	if (COUNTER_METRIC_NAMES.has(name)) {
		return "counter";
	}
	if (HISTOGRAM_METRIC_NAMES.has(name)) {
		return "histogram";
	}
	if (GAUGE_METRIC_NAMES.has(name)) {
		return "gauge";
	}
	throw new Error(`Unknown metric kind for metric: ${name}`);
}

export const APPROVED_METRIC_LABEL_KEYS = [
	"route_group",
	"transport",
	"auth_mode",
	"api_surface",
	"api_version",
	"outcome",
	"status_class",
	"tool_name",
	"upstream_operation",
	"message_type",
	"is_done",
	"operation",
] as const;

export const FORBIDDEN_METRIC_LABEL_KEYS = [
	"instanceUrl",
	"userGUID",
	"userName",
	"clientId",
	"datasourceId",
	"conversationId",
	"question",
	"query",
	"redirectUrl",
	"frameUrl",
	"authorization",
	"x-ts-host",
] as const;

const APPROVED_METRIC_LABEL_KEYS_SET = new Set<string>(
	APPROVED_METRIC_LABEL_KEYS,
);
const FORBIDDEN_METRIC_LABEL_KEYS_SET = new Set<string>(
	FORBIDDEN_METRIC_LABEL_KEYS,
);

export type MetricLabelKey = (typeof APPROVED_METRIC_LABEL_KEYS)[number];
export type MetricLabelValue = string | number | boolean;
export type MetricLabels = Partial<Record<MetricLabelKey, string>>;
export type MetricLabelInput = Partial<Record<MetricLabelKey, MetricLabelValue>> &
	Record<string, MetricLabelValue | null | undefined>;

export type MetricOutcome =
	| "success"
	| "error"
	| "client_error"
	| "upstream_error"
	| "validation_error";

export type RouteGroup =
	| "root"
	| "authorize"
	| "callback"
	| "store_token"
	| "mcp"
	| "sse"
	| "openai_mcp"
	| "openai_sse"
	| "api"
	| "bearer_mcp"
	| "bearer_sse"
	| "token_mcp"
	| "token_sse"
	| "unknown";

export type Transport = "mcp" | "sse" | "http" | "unknown";
export type AuthMode = "oauth" | "bearer" | "token" | "none" | "unknown";
export type ApiSurface = "mcp" | "openai_mcp" | "api" | "oauth" | "static" | "unknown";
export type StatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "unknown";

function warnOnInvalidMetricLabel(key: string, reason: string) {
	console.warn(`[metrics] Dropping label "${key}": ${reason}`);
}

export function normalizeMetricLabels(
	labels?: MetricLabelInput,
): MetricLabels {
	if (!labels) {
		return {};
	}

	const normalized: MetricLabels = {};
	for (const key of Object.keys(labels).sort()) {
		const rawValue = labels[key];
		if (rawValue === undefined || rawValue === null || rawValue === "") {
			continue;
		}
		if (FORBIDDEN_METRIC_LABEL_KEYS_SET.has(key)) {
			warnOnInvalidMetricLabel(key, "forbidden by cardinality guardrail");
			continue;
		}
		if (!APPROVED_METRIC_LABEL_KEYS_SET.has(key)) {
			warnOnInvalidMetricLabel(key, "not in approved label set");
			continue;
		}
		normalized[key as MetricLabelKey] = String(rawValue);
	}

	return normalized;
}
