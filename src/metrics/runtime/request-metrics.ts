import { resolveApiVersion } from "../../servers/version-registry";
import { createAnalyticsEngineMetricsSink } from "./analytics-engine-sink";
import { createGrafanaOtlpMetricsSink } from "./grafana-otlp-sink";
import { getStatusClass, resolveRequestMetricContext } from "./metric-context";
import {
	METRIC_NAMES,
	type MetricLabelInput,
	type MetricName,
	type MetricOutcome,
} from "./metric-types";
import {
	type MetricsRecorder,
	NOOP_METRICS_RECORDER,
	RequestMetricsRecorder,
} from "./metrics-recorder";
import type { MetricsSink } from "./metrics-sink";
import {
	type ConfiguredMetricsSinks,
	type MetricsEnvLike,
	createConfiguredMetricsSink,
	resolveMetricsRuntimeConfig,
} from "./runtime-config";

const METRICS_RECORDER_SYMBOL = Symbol.for(
	"thoughtspot.mcp.metrics.requestRecorder",
);
const GRAFANA_SINK_CACHE = new WeakMap<object, MetricsSink>();
const VERSIONED_REQUEST_ROUTE_GROUPS = new Set([
	"mcp",
	"sse",
	"bearer_mcp",
	"bearer_sse",
	"token_mcp",
	"token_sse",
] as const);
type BearerAuthRouteGroup =
	| "bearer_mcp"
	| "bearer_sse"
	| "token_mcp"
	| "token_sse";

type MetricsExecutionContext = ExecutionContext & {
	[METRICS_RECORDER_SYMBOL]?: MetricsRecorder;
	props?: {
		apiVersion?: unknown;
	};
};

export function setMetricsRecorderOnExecutionContext(
	ctx: ExecutionContext,
	recorder: MetricsRecorder,
): MetricsRecorder {
	(ctx as MetricsExecutionContext)[METRICS_RECORDER_SYMBOL] = recorder;
	return recorder;
}

function createDefaultConfiguredMetricsSinks(
	env: MetricsEnvLike | undefined,
	sinks: ConfiguredMetricsSinks,
): ConfiguredMetricsSinks {
	return {
		analyticsEngineSink:
			sinks.analyticsEngineSink ??
			createAnalyticsEngineMetricsSink(env?.ANALYTICS),
		grafanaSink: sinks.grafanaSink ?? getCachedGrafanaSink(env),
	};
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

export function getMetricOutcomeForStatus(status: number): MetricOutcome {
	if (status >= 400 && status < 500) {
		return "client_error";
	}
	if (status >= 500) {
		return "error";
	}
	return "success";
}

function getCanonicalResolvedApiVersion(apiVersion: string): string {
	if (apiVersion === "backwards-compatibility-default") {
		return "default";
	}

	const versionConfig = resolveApiVersion(apiVersion);
	if (versionConfig.version.includes("beta")) {
		return "beta";
	}

	return versionConfig.version[versionConfig.version.length - 1] ?? "unknown";
}

export function resolveCanonicalApiVersionLabel(
	request: Request,
	ctx: ExecutionContext,
): string | undefined {
	const requestContext = resolveRequestMetricContext(request);
	if (!VERSIONED_REQUEST_ROUTE_GROUPS.has(requestContext.routeGroup)) {
		return undefined;
	}

	const requestedApiVersion = new URL(request.url).searchParams.get(
		"api-version",
	);
	const effectiveApiVersion = (ctx as MetricsExecutionContext).props
		?.apiVersion;
	if (
		typeof effectiveApiVersion === "string" &&
		effectiveApiVersion.length > 0
	) {
		try {
			return getCanonicalResolvedApiVersion(effectiveApiVersion);
		} catch {
			return "unknown";
		}
	}

	if (!requestedApiVersion) {
		return "default";
	}

	try {
		return getCanonicalResolvedApiVersion(requestedApiVersion);
	} catch {
		return "unknown";
	}
}

export function recordStatusMetric(
	recorder: MetricsRecorder | undefined,
	name: MetricName,
	status: number,
	labels: MetricLabelInput = {},
): void {
	if (!recorder) {
		return;
	}

	recorder.count(name, 1, {
		...labels,
		outcome: getMetricOutcomeForStatus(status),
	});
}

export function recordBearerAuthRequestMetric(
	recorder: MetricsRecorder | undefined,
	request: Request,
	status: number,
	routeGroupOverride?: BearerAuthRouteGroup,
): void {
	if (!recorder) {
		return;
	}

	const requestContext = resolveRequestMetricContext(request);
	recordStatusMetric(recorder, METRIC_NAMES.bearerAuthRequestsTotal, status, {
		route_group: routeGroupOverride ?? requestContext.routeGroup,
		transport: routeGroupOverride?.endsWith("_sse")
			? "sse"
			: routeGroupOverride?.endsWith("_mcp")
				? "mcp"
				: requestContext.transport,
	});
}

export function recordHttpRequestMetrics(
	recorder: MetricsRecorder,
	request: Request,
	response: Response,
	ctx: ExecutionContext,
	durationMs: number,
): void {
	const requestContext = resolveRequestMetricContext(request);
	const outcome = getMetricOutcomeForStatus(response.status);
	const apiVersion = resolveCanonicalApiVersionLabel(request, ctx);
	const baseLabels: MetricLabelInput = {
		route_group: requestContext.routeGroup,
		transport: requestContext.transport,
		auth_mode: requestContext.authMode,
		api_surface: requestContext.apiSurface,
		outcome,
	};

	if (apiVersion) {
		baseLabels.api_version = apiVersion;
	}

	recorder.count(METRIC_NAMES.httpRequestsTotal, 1, {
		...baseLabels,
		status_class: getStatusClass(response.status),
	});
	recorder.histogram(
		METRIC_NAMES.httpRequestDurationMs,
		durationMs,
		baseLabels,
	);
}

function getCachedGrafanaSink(
	env: MetricsEnvLike | undefined,
): MetricsSink | undefined {
	if (!env || typeof env !== "object") {
		return createGrafanaOtlpMetricsSink(env);
	}

	// Reuse the sink for the same env object so repeated request recorders do not
	// rebuild identical Grafana exporter configuration within one Worker runtime.
	const cachedSink = GRAFANA_SINK_CACHE.get(env);
	if (cachedSink) {
		return cachedSink;
	}

	const sink = createGrafanaOtlpMetricsSink(env);
	if (sink) {
		GRAFANA_SINK_CACHE.set(env, sink);
	}
	return sink;
}

export function createRequestMetricsRecorder(
	env?: MetricsEnvLike,
	sinks: ConfiguredMetricsSinks = {},
): MetricsRecorder {
	try {
		const config = resolveMetricsRuntimeConfig(env);
		const sink = createConfiguredMetricsSink(
			config,
			createDefaultConfiguredMetricsSinks(env, sinks),
		);

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
