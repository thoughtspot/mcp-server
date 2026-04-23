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

export type MetricsFlushPayload = {
	observations: readonly MetricObservation[];
	resourceAttributes: MetricResourceAttributes;
};

export interface MetricsSink {
	flush(payload: MetricsFlushPayload): Promise<void>;
}
