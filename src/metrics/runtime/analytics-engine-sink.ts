import {
	APPROVED_METRIC_LABEL_KEYS,
	METRIC_NAMES,
	type MetricLabels,
	type MetricName,
} from "./metric-types";
import type {
	MetricAnalyticsContext,
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

export const ANALYTICS_ENGINE_INDEX_FIELDS = [
	"schema_version",
	"event_family",
	"metric_name",
	"tenant_id",
	"user_id",
] as const;

export const ANALYTICS_ENGINE_LABEL_FIELDS = APPROVED_METRIC_LABEL_KEYS;

export const ANALYTICS_ENGINE_CONTEXT_FIELDS = [
	["api_requested_version", "apiRequestedVersion"],
] as const satisfies readonly (readonly [
	string,
	keyof MetricAnalyticsContext,
])[];

export const ANALYTICS_ENGINE_RESOURCE_ATTRIBUTE_FIELDS = [
	["deployment_environment", "deployment.environment"],
	["service_name", "service.name"],
	["service_namespace", "service.namespace"],
	["service_version", "service.version"],
] as const satisfies readonly (readonly [
	string,
	keyof MetricResourceAttributes,
])[];

export const ANALYTICS_ENGINE_BLOB_FIELDS = [
	"metric_kind",
	...ANALYTICS_ENGINE_LABEL_FIELDS,
	...ANALYTICS_ENGINE_CONTEXT_FIELDS.map(([field]) => field),
	...ANALYTICS_ENGINE_RESOURCE_ATTRIBUTE_FIELDS.map(([field]) => field),
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
