import type { MetricsFlushPayload, MetricsSink } from "./metrics-sink";

export class NoopMetricsSink implements MetricsSink {
	async flush(_payload: MetricsFlushPayload): Promise<void> {}
}
