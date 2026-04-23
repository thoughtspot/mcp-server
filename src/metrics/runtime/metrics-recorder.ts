import {
	getMetricKind,
	normalizeMetricLabels,
	type MetricKind,
	type MetricLabelInput,
	type MetricName,
} from "./metric-types";
import type {
	MetricObservation,
	MetricResourceAttributes,
	MetricsSink,
} from "./metrics-sink";

type MetricsRecorderOptions = {
	sink: MetricsSink;
	resourceAttributes?: MetricResourceAttributes;
	now?: () => number;
};

export interface MetricsRecorder {
	count(name: MetricName, value?: number, labels?: MetricLabelInput): void;
	histogram(name: MetricName, value: number, labels?: MetricLabelInput): void;
	gauge(name: MetricName, value: number, labels?: MetricLabelInput): void;
	flush(ctx?: Pick<ExecutionContext, "waitUntil">): Promise<void>;
	snapshot(): readonly MetricObservation[];
}

export class RequestMetricsRecorder implements MetricsRecorder {
	private readonly observations: MetricObservation[] = [];
	private flushPromise?: Promise<void>;
	private flushed = false;

	constructor(private readonly options: MetricsRecorderOptions) {}

	count(name: MetricName, value = 1, labels?: MetricLabelInput): void {
		this.record("counter", name, value, labels);
	}

	histogram(name: MetricName, value: number, labels?: MetricLabelInput): void {
		this.record("histogram", name, value, labels);
	}

	gauge(name: MetricName, value: number, labels?: MetricLabelInput): void {
		this.record("gauge", name, value, labels);
	}

	snapshot(): readonly MetricObservation[] {
		return [...this.observations];
	}

	async flush(ctx?: Pick<ExecutionContext, "waitUntil">): Promise<void> {
		if (!this.flushPromise) {
			this.flushPromise = this.flushInternal();
		}

		if (ctx) {
			ctx.waitUntil(this.flushPromise);
		}

		return this.flushPromise;
	}

	private record(
		expectedKind: MetricKind,
		name: MetricName,
		value: number,
		labels?: MetricLabelInput,
	): void {
		if (this.flushed) {
			console.warn(`[metrics] Ignoring metric recorded after flush: ${name}`);
			return;
		}
		if (!Number.isFinite(value)) {
			console.warn(`[metrics] Ignoring non-finite metric value for ${name}`);
			return;
		}

		const actualKind = getMetricKind(name);
		if (actualKind !== expectedKind) {
			console.warn(
				`[metrics] Ignoring ${expectedKind} write for ${name}; metric is defined as ${actualKind}`,
			);
			return;
		}

		this.observations.push({
			kind: actualKind,
			name,
			value,
			labels: normalizeMetricLabels(labels),
			timestampMs: this.options.now?.() ?? Date.now(),
		});
	}

	private async flushInternal(): Promise<void> {
		try {
			if (this.observations.length === 0) {
				return;
			}

			await this.options.sink.flush({
				observations: this.snapshot(),
				resourceAttributes: { ...this.options.resourceAttributes },
			});
		} catch (error) {
			console.error("[metrics] Flush failed", error);
		} finally {
			this.flushed = true;
		}
	}
}
