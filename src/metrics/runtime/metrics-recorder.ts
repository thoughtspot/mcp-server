import {
	type MetricKind,
	type MetricLabelInput,
	type MetricName,
	getMetricKind,
	normalizeMetricLabels,
} from "./metric-types";
import type {
	MetricAnalyticsContext,
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
	setAnalyticsContext(context?: MetricAnalyticsContext): void;
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
	setAnalyticsContext(_context): void {},
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
	private analyticsContext?: MetricAnalyticsContext;
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

	setAnalyticsContext(context?: MetricAnalyticsContext): void {
		if (!context) {
			return;
		}

		const nextContext: MetricAnalyticsContext = {
			...this.analyticsContext,
		};
		if (context.apiRequestedVersion) {
			nextContext.apiRequestedVersion = context.apiRequestedVersion;
		}
		this.analyticsContext = nextContext;
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
				analyticsContext: this.analyticsContext
					? { ...this.analyticsContext }
					: undefined,
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
	const flushPromise = recorder.flush().catch((error) => {
		console.error("[metrics] Failed to execute metrics flush", error);
	});

	if (!waitUntil) {
		// Non-Worker runtimes and tests may not provide waitUntil. Start the guarded
		// flush anyway and intentionally detach from it.
		void flushPromise;
		return;
	}

	try {
		waitUntil(flushPromise);
	} catch (error) {
		console.error("[metrics] Failed to schedule metrics flush", error);
	}
}
