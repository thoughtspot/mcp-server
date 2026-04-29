import { RequestMetricsRecorder, type MetricsRecorder } from "./metrics-recorder";
import {
	createConfiguredMetricsSink,
	resolveMetricsRuntimeConfig,
	type ConfiguredMetricsSinks,
	type MetricsEnvLike,
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
): RequestMetricsRecorder {
	const config = resolveMetricsRuntimeConfig(env);
	const sink = createConfiguredMetricsSink(config, sinks);

	return new RequestMetricsRecorder({
		sink,
		resourceAttributes: config.resourceAttributes,
	});
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
		await recorder.flush(ctx);
		clearMetricsRecorderFromExecutionContext(ctx);
	}
}
