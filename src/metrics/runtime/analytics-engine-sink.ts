import {
	METRIC_NAMES,
	type MetricLabels,
	type MetricName,
} from "./metric-types";
import type {
	MetricObservation,
	MetricResourceAttributes,
	MetricsFlushPayload,
	MetricsSink,
} from "./metrics-sink";

export type AnalyticsEngineDataPointLike = {
	indexes?: ((ArrayBuffer | string) | null)[];
	blobs?: ((ArrayBuffer | string) | null)[];
	doubles?: number[];
};

export type AnalyticsEngineDatasetLike = {
	writeDataPoint(event?: AnalyticsEngineDataPointLike): void;
};

export const ANALYTICS_ENGINE_SCHEMA_VERSION = "mcp_metrics_v1";

export const ANALYTICS_ENGINE_INDEX_FIELDS = [
	"schema_version",
	"event_family",
	"metric_name",
	"tenant_id",
	"user_id",
] as const;

export const ANALYTICS_ENGINE_BLOB_FIELDS = [
	"metric_kind",
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
	"is_thinking",
	"is_done",
	"operation",
	"deployment_environment",
	"service_name",
	"service_namespace",
	"service_version",
] as const;

export const ANALYTICS_ENGINE_DOUBLE_FIELDS = [
	"metric_value",
	"timestamp_ms",
] as const;

type AnalyticsEngineIdentity = {
	tenantId?: string;
	userId?: string;
};

type AnalyticsEngineMetricFamily =
	| "analysis"
	| "auth"
	| "dashboard"
	| "http"
	| "resource"
	| "stream_storage"
	| "tool"
	| "upstream";

function nullableString(value: string | undefined): string | null {
	return value && value.length > 0 ? value : null;
}

function getLabel(
	labels: MetricLabels,
	key: keyof MetricLabels,
): string | null {
	return nullableString(labels[key]);
}

function getResourceAttribute(
	resourceAttributes: MetricResourceAttributes,
	key: keyof MetricResourceAttributes,
): string | null {
	return nullableString(resourceAttributes[key]);
}

export function getAnalyticsEngineMetricFamily(
	name: MetricName,
): AnalyticsEngineMetricFamily {
	switch (name) {
		case METRIC_NAMES.httpRequestsTotal:
		case METRIC_NAMES.httpRequestDurationMs:
		case METRIC_NAMES.httpInflightRequests:
			return "http";
		case METRIC_NAMES.toolCallsTotal:
		case METRIC_NAMES.toolDurationMs:
			return "tool";
		case METRIC_NAMES.resourceReadsTotal:
			return "resource";
		case METRIC_NAMES.sessionsStartedTotal:
		case METRIC_NAMES.oauthAuthorizeRequestsTotal:
		case METRIC_NAMES.oauthAuthorizeSubmitTotal:
		case METRIC_NAMES.oauthCallbackTotal:
		case METRIC_NAMES.oauthStoreTokenTotal:
		case METRIC_NAMES.bearerAuthRequestsTotal:
			return "auth";
		case METRIC_NAMES.upstreamCallsTotal:
		case METRIC_NAMES.upstreamDurationMs:
		case METRIC_NAMES.upstreamStreamsStartedTotal:
		case METRIC_NAMES.upstreamStreamMessagesTotal:
			return "upstream";
		case METRIC_NAMES.analysisSessionsCreatedTotal:
		case METRIC_NAMES.analysisMessagesSentTotal:
		case METRIC_NAMES.analysisUpdatesPolledTotal:
		case METRIC_NAMES.analysisPollWaitMs:
		case METRIC_NAMES.analysisFirstBufferedUpdateMs:
		case METRIC_NAMES.analysisFirstPollDelayMs:
		case METRIC_NAMES.analysisFirstNonEmptyResponseMs:
		case METRIC_NAMES.analysisSessionsNeverPolledTotal:
			return "analysis";
		case METRIC_NAMES.streamStorageErrorsTotal:
			return "stream_storage";
		case METRIC_NAMES.dashboardsCreatedTotal:
		case METRIC_NAMES.dashboardTilesCount:
			return "dashboard";
		default: {
			const _exhaustiveCheck: never = name;
			throw new Error(
				`Unhandled Analytics Engine metric family: ${_exhaustiveCheck}`,
			);
		}
	}
}

export function toAnalyticsEngineDataPoint(
	observation: MetricObservation,
	resourceAttributes: MetricResourceAttributes,
	identity: AnalyticsEngineIdentity = {},
): AnalyticsEngineDataPointLike {
	return {
		indexes: [
			ANALYTICS_ENGINE_SCHEMA_VERSION,
			getAnalyticsEngineMetricFamily(observation.name),
			observation.name,
			nullableString(identity.tenantId),
			nullableString(identity.userId),
		],
		blobs: [
			observation.kind,
			getLabel(observation.labels, "route_group"),
			getLabel(observation.labels, "transport"),
			getLabel(observation.labels, "auth_mode"),
			getLabel(observation.labels, "api_surface"),
			getLabel(observation.labels, "api_version"),
			getLabel(observation.labels, "outcome"),
			getLabel(observation.labels, "status_class"),
			getLabel(observation.labels, "tool_name"),
			getLabel(observation.labels, "upstream_operation"),
			getLabel(observation.labels, "message_type"),
			getLabel(observation.labels, "is_thinking"),
			getLabel(observation.labels, "is_done"),
			getLabel(observation.labels, "operation"),
			getResourceAttribute(resourceAttributes, "deployment.environment"),
			getResourceAttribute(resourceAttributes, "service.name"),
			getResourceAttribute(resourceAttributes, "service.namespace"),
			getResourceAttribute(resourceAttributes, "service.version"),
		],
		doubles: [observation.value, observation.timestampMs],
	};
}

export class AnalyticsEngineMetricsSink implements MetricsSink {
	constructor(private readonly dataset: AnalyticsEngineDatasetLike) {}

	async flush(payload: MetricsFlushPayload): Promise<void> {
		for (const observation of payload.observations) {
			try {
				this.dataset.writeDataPoint(
					toAnalyticsEngineDataPoint(
						observation,
						payload.resourceAttributes,
						payload.eventIdentity,
					),
				);
			} catch (error) {
				console.warn(
					`[metrics] Failed to write Analytics Engine data point for ${observation.name}`,
					error,
				);
			}
		}
	}
}

export function createAnalyticsEngineMetricsSink(
	dataset: unknown,
): AnalyticsEngineMetricsSink | undefined {
	if (
		typeof dataset === "object" &&
		dataset !== null &&
		"writeDataPoint" in dataset &&
		typeof dataset.writeDataPoint === "function"
	) {
		return new AnalyticsEngineMetricsSink(
			dataset as AnalyticsEngineDatasetLike,
		);
	}

	return undefined;
}
