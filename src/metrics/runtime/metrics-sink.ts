import type { MetricKind, MetricLabels, MetricName } from "./metric-types";

export type MetricObservation = {
	kind: MetricKind;
	name: MetricName;
	value: number;
	labels: MetricLabels;
	timestampMs: number;
};

export type MetricResourceAttributes = Partial<
	Record<
		| "service.name"
		| "service.namespace"
		| "service.version"
		| "deployment.environment"
		| "cloud.provider"
		| "cloud.platform",
		string
	>
>;

export type MetricEventIdentity = {
	tenantId?: string;
	userId?: string;
};

// Sink-specific context for dimensions that should not become generic metric labels.
// `api_version`, `api_version_mode`, and `api_release_date` stay in `MetricObservation.labels`
// because both Grafana and Analytics Engine should receive them as low-cardinality dimensions.
// `apiRequestedVersion` and `analyticalSessionId` live here instead because they are
// Analytics-Engine-only debug/context fields and should not widen Grafana label cardinality.
export type MetricAnalyticsContext = {
	apiRequestedVersion?: string;
	analyticalSessionId?: string;
};

export type MetricsFlushPayload = {
	observations: readonly MetricObservation[];
	resourceAttributes: MetricResourceAttributes;
	eventIdentity?: MetricEventIdentity;
	analyticsContext?: MetricAnalyticsContext;
};

export interface MetricsSink {
	flush(payload: MetricsFlushPayload): Promise<void>;
}
