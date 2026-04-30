import {
	type MetricsRecorder,
	NOOP_METRICS_RECORDER,
	RequestMetricsRecorder,
} from "./metrics-recorder";
import {
	type ConfiguredMetricsSinks,
	type MetricsEnvLike,
	createConfiguredMetricsSink,
	resolveMetricsRuntimeConfig,
} from "./runtime-config";

const METRICS_RECORDER_SYMBOL = Symbol.for(
	"thoughtspot.mcp.metrics.requestRecorder",
);

type MetricsExecutionContext = ExecutionContext & {
	[METRICS_RECORDER_SYMBOL]?: MetricsRecorder;
};

export function setMetricsRecorderOnExecutionContext(
	ctx: ExecutionContext,
	recorder: MetricsRecorder,
): MetricsRecorder {
	(ctx as MetricsExecutionContext)[METRICS_RECORDER_SYMBOL] = recorder;
	return recorder;
}

export function getMetricsRecorderFromExecutionContext(
	ctx: ExecutionContext,
): MetricsRecorder | undefined {
	return (ctx as MetricsExecutionContext)[METRICS_RECORDER_SYMBOL];
}

export function clearMetricsRecorderFromExecutionContext(
	ctx: ExecutionContext,
): void {
	delete (ctx as MetricsExecutionContext)[METRICS_RECORDER_SYMBOL];
}

export function createRequestMetricsRecorder(
	env?: MetricsEnvLike,
	sinks: ConfiguredMetricsSinks = {},
): MetricsRecorder {
	try {
		const config = resolveMetricsRuntimeConfig(env);
		const sink = createConfiguredMetricsSink(config, sinks);

		return new RequestMetricsRecorder({
			sink,
			resourceAttributes: config.resourceAttributes,
		});
	} catch (error) {
		console.error(
			"[metrics] Failed to initialize request metrics recorder; using noop recorder",
			error,
		);
		return NOOP_METRICS_RECORDER;
	}
}

function scheduleRequestMetricsFlush(
	recorder: MetricsRecorder,
	ctx: ExecutionContext,
): void {
	let flushPromise: Promise<void>;
	try {
		flushPromise = recorder.flush().catch((error) => {
			console.error("[metrics] Failed to execute request metrics flush", error);
		});
	} catch (error) {
		console.error("[metrics] Failed to execute request metrics flush", error);
		return;
	}

	try {
		ctx.waitUntil(flushPromise);
	} catch (error) {
		console.error("[metrics] Failed to schedule request metrics flush", error);
	}
}

export async function withRequestMetrics<T>(
	env: MetricsEnvLike | undefined,
	ctx: ExecutionContext,
	handler: (recorder: MetricsRecorder) => Promise<T>,
	sinks: ConfiguredMetricsSinks = {},
): Promise<T> {
	const recorder = createRequestMetricsRecorder(env, sinks);
	setMetricsRecorderOnExecutionContext(ctx, recorder);

	try {
		return await handler(recorder);
	} finally {
		scheduleRequestMetricsFlush(recorder, ctx);
		clearMetricsRecorderFromExecutionContext(ctx);
	}
}
