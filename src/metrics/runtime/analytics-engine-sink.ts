import {
	METRIC_NAMES,
	type MetricLabels,
	type MetricName,
} from "./metric-types";
import type {
	MetricAnalyticsContext,
	MetricEventIdentity,
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

export const ANALYTICS_ENGINE_SCHEMA_VERSION = "mcp_metrics_v2";
const ANALYTICS_ENGINE_FALLBACK_INDEX = "shared";

// Cloudflare Analytics Engine allows one sampling index and up to 20 blobs. This
// schema is intentionally AE-specific instead of mirroring every approved metric
// label, so we can keep tenant/user + version + tool/upstream context together
// without exceeding those limits.
export const ANALYTICS_ENGINE_INDEX_FIELDS = ["tenant_id"] as const;

export const ANALYTICS_ENGINE_IDENTITY_BLOB_FIELDS = [
	["tenant_id", "tenantId"],
	["user_id", "userId"],
] as const satisfies readonly (readonly [string, keyof MetricEventIdentity])[];

export const ANALYTICS_ENGINE_LABEL_FIELDS = [
	"route_group",
	"auth_mode",
	"api_version",
	"api_version_mode",
	"api_release_date",
	"outcome",
	"status_class",
	"tool_name",
	"upstream_operation",
	"message_type",
	"is_done",
] as const;

export const ANALYTICS_ENGINE_CONTEXT_FIELDS = [
	["api_requested_version", "apiRequestedVersion"],
	["analytical_session_id", "analyticalSessionId"],
] as const satisfies readonly (readonly [
	string,
	keyof MetricAnalyticsContext,
])[];

export const ANALYTICS_ENGINE_RESOURCE_ATTRIBUTE_FIELDS = [
	["service_version", "service.version"],
] as const satisfies readonly (readonly [
	string,
	keyof MetricResourceAttributes,
])[];

export const ANALYTICS_ENGINE_BLOB_FIELDS = [
	"schema_version",
	"event_family",
	"metric_name",
	"metric_kind",
	...ANALYTICS_ENGINE_IDENTITY_BLOB_FIELDS.map(([field]) => field),
	...ANALYTICS_ENGINE_LABEL_FIELDS,
	...ANALYTICS_ENGINE_CONTEXT_FIELDS.map(([field]) => field),
	...ANALYTICS_ENGINE_RESOURCE_ATTRIBUTE_FIELDS.map(([field]) => field),
] as const;

export const ANALYTICS_ENGINE_DOUBLE_FIELDS = [
	"metric_value",
	"timestamp_ms",
] as const;

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

function getEventIdentityField(
	identity: MetricEventIdentity,
	key: keyof MetricEventIdentity,
): string | null {
	return nullableString(identity[key]);
}

function getAnalyticsContextField(
	analyticsContext: MetricAnalyticsContext,
	key: keyof MetricAnalyticsContext,
): string | null {
	return nullableString(analyticsContext[key]);
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
	analyticsContext: MetricAnalyticsContext = {},
	identity: MetricEventIdentity = {},
): AnalyticsEngineDataPointLike {
	return {
		indexes: [
			nullableString(identity.tenantId) ?? ANALYTICS_ENGINE_FALLBACK_INDEX,
		],
		blobs: [
			ANALYTICS_ENGINE_SCHEMA_VERSION,
			getAnalyticsEngineMetricFamily(observation.name),
			observation.name,
			observation.kind,
			...ANALYTICS_ENGINE_IDENTITY_BLOB_FIELDS.map(([, key]) =>
				getEventIdentityField(identity, key),
			),
			...ANALYTICS_ENGINE_LABEL_FIELDS.map((key) =>
				getLabel(observation.labels, key),
			),
			...ANALYTICS_ENGINE_CONTEXT_FIELDS.map(([, key]) =>
				getAnalyticsContextField(analyticsContext, key),
			),
			...ANALYTICS_ENGINE_RESOURCE_ATTRIBUTE_FIELDS.map(([, key]) =>
				getResourceAttribute(resourceAttributes, key),
			),
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
						payload.analyticsContext,
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

function isAnalyticsEngineDatasetLike(
	dataset: unknown,
): dataset is AnalyticsEngineDatasetLike {
	return (
		typeof dataset === "object" &&
		dataset !== null &&
		"writeDataPoint" in dataset &&
		typeof dataset.writeDataPoint === "function"
	);
}

export function createAnalyticsEngineMetricsSink(
	dataset: unknown,
): AnalyticsEngineMetricsSink | undefined {
	if (isAnalyticsEngineDatasetLike(dataset)) {
		return new AnalyticsEngineMetricsSink(dataset);
	}

	return undefined;
}
