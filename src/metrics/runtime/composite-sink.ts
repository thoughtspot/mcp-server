import type { MetricsFlushPayload, MetricsSink } from "./metrics-sink";

export class CompositeMetricsSink implements MetricsSink {
	constructor(private readonly sinks: readonly MetricsSink[]) {}

	async flush(payload: MetricsFlushPayload): Promise<void> {
		const results = await Promise.allSettled(
			this.sinks.map((sink) => sink.flush(payload)),
		);

		for (const [index, result] of results.entries()) {
			if (result.status === "rejected") {
				console.error(
					`[metrics] Sink at index ${index} failed during flush`,
					result.reason,
				);
			}
		}
	}
}
