import {
	type MetricKind,
	type MetricLabelInput,
	type MetricName,
	getMetricKind,
	normalizeMetricLabels,
} from "./metric-types";
import type {
	MetricEventIdentity,
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
	setEventIdentity(identity?: MetricEventIdentity): void;
	flush(): Promise<void>;
	snapshot(): readonly MetricObservation[];
}

const NOOP_FLUSH_PROMISE: Promise<void> = Promise.resolve();
const NOOP_METRIC_OBSERVATIONS: readonly MetricObservation[] = [];

export const NOOP_METRICS_RECORDER: MetricsRecorder = {
	count(_name, _value, _labels): void {},
	histogram(_name, _value, _labels): void {},
	gauge(_name, _value, _labels): void {},
	setEventIdentity(_identity): void {},
	flush(): Promise<void> {
		return NOOP_FLUSH_PROMISE;
	},
	snapshot(): readonly MetricObservation[] {
		return NOOP_METRIC_OBSERVATIONS;
	},
};

export class RequestMetricsRecorder implements MetricsRecorder {
	private readonly observations: MetricObservation[] = [];
	private eventIdentity?: MetricEventIdentity;
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

	setEventIdentity(identity?: MetricEventIdentity): void {
		if (!identity) {
			return;
		}

		const nextIdentity: MetricEventIdentity = {
			...this.eventIdentity,
		};
		if (identity.tenantId) {
			nextIdentity.tenantId = identity.tenantId;
		}
		if (identity.userId) {
			nextIdentity.userId = identity.userId;
		}
		this.eventIdentity = nextIdentity;
	}

	snapshot(): readonly MetricObservation[] {
		return [...this.observations];
	}

	flush(): Promise<void> {
		if (!this.flushPromise) {
			this.flushPromise = this.flushInternal();
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
		this.flushed = true;
		const observations = this.snapshot();

		try {
			if (observations.length === 0) {
				return;
			}

			await this.options.sink.flush({
				observations,
				resourceAttributes: { ...this.options.resourceAttributes },
				eventIdentity: this.eventIdentity
					? { ...this.eventIdentity }
					: undefined,
			});
		} catch (error) {
			console.error("[metrics] Flush failed", error);
		}
	}
}

export type MetricsWaitUntil = (promise: Promise<any>) => void;

export function scheduleMetricsFlush(
	recorder: MetricsRecorder,
	waitUntil?: MetricsWaitUntil,
): void {
	let flushPromise: Promise<void>;
	try {
		flushPromise = recorder.flush().catch((error) => {
			console.error("[metrics] Failed to execute metrics flush", error);
		});
	} catch (error) {
		console.error("[metrics] Failed to execute metrics flush", error);
		return;
	}

	if (!waitUntil) {
		void flushPromise;
		return;
	}

	try {
		waitUntil(flushPromise);
	} catch (error) {
		console.error("[metrics] Failed to schedule metrics flush", error);
	}
}
