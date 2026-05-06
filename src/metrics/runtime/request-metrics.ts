import {
	YYYY_MM_DD_DATE_REGEX,
	resolveApiVersionMetrics,
} from "../../servers/version-registry";
import { createAnalyticsEngineMetricsSink } from "./analytics-engine-sink";
import { createGrafanaOtlpMetricsSink } from "./grafana-otlp-sink";
import { getStatusClass, resolveRequestMetricContext } from "./metric-context";
import {
	type ApiVersionMode,
	METRIC_NAMES,
	type MetricLabelInput,
	type MetricName,
	type MetricOutcome,
} from "./metric-types";
import {
	type MetricsRecorder,
	NOOP_METRICS_RECORDER,
	RequestMetricsRecorder,
	scheduleMetricsFlush,
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
		apiRequestedVersion?: unknown;
		apiVersionMode?: unknown;
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

type ApiVersionLabels = {
	apiRequestedVersion?: string;
	apiReleaseDate?: string;
	apiVersion?: string;
	apiVersionMode?: ApiVersionMode;
};

export function normalizeRequestedApiVersionForAnalytics(
	requestedApiVersion: string,
): string {
	if (
		requestedApiVersion === "beta" ||
		requestedApiVersion === "backwards-compatibility-default" ||
		requestedApiVersion === "latest" ||
		YYYY_MM_DD_DATE_REGEX.test(requestedApiVersion)
	) {
		return requestedApiVersion;
	}

	return "invalid";
}

export function resolveRequestedApiVersionMode(
	requestedApiVersion: string,
): ApiVersionMode {
	if (requestedApiVersion === "beta") {
		return "beta";
	}
	if (requestedApiVersion === "backwards-compatibility-default") {
		return "explicit_legacy";
	}
	if (requestedApiVersion === "latest") {
		return "explicit_latest";
	}
	if (YYYY_MM_DD_DATE_REGEX.test(requestedApiVersion)) {
		return "pinned";
	}
	return "unknown";
}

function getImplicitApiVersionMode(apiVersion?: string): ApiVersionMode {
	if (apiVersion === "backwards-compatibility-default") {
		return "implicit_legacy";
	}
	if (apiVersion === "latest") {
		return "implicit_latest";
	}
	if (apiVersion === "beta") {
		return "beta";
	}
	return "unknown";
}

/**
 * We intentionally split version labeling into two dimensions:
 * - `api_version`: the effective served surface (`backwards-compatibility-default`
 *   vs `latest`), which answers "which tenants are still on the legacy/v1 surface?"
 * - `api_version_mode`: how the caller selected that surface, which answers
 *   "which tenants are pinned vs implicitly following a route default?"
 * - `api_requested_version`: Analytics Engine-only context with the normalized selector
 *   the caller actually sent (`latest`, `beta`, a date, or `invalid`)
 * - `api_release_date`: the resolved dated release behind that surface, which answers
 *   "what exact release date would be affected by a deprecation?"
 */
export function resolveApiVersionLabels(
	request: Request,
	ctx: ExecutionContext,
): ApiVersionLabels {
	const requestContext = resolveRequestMetricContext(request);
	if (!VERSIONED_REQUEST_ROUTE_GROUPS.has(requestContext.routeGroup)) {
		return {};
	}

	const requestedApiVersion = new URL(request.url).searchParams.get(
		"api-version",
	);
	const effectiveApiVersion = (ctx as MetricsExecutionContext).props
		?.apiVersion;
	const effectiveRequestedApiVersion = (ctx as MetricsExecutionContext).props
		?.apiRequestedVersion;
	const effectiveApiVersionMode = (ctx as MetricsExecutionContext).props
		?.apiVersionMode;
	if (requestedApiVersion) {
		const apiVersionSource =
			typeof effectiveApiVersion === "string" && effectiveApiVersion.length > 0
				? effectiveApiVersion
				: requestedApiVersion;
		try {
			return {
				apiRequestedVersion:
					typeof effectiveRequestedApiVersion === "string" &&
					effectiveRequestedApiVersion.length > 0
						? effectiveRequestedApiVersion
						: normalizeRequestedApiVersionForAnalytics(requestedApiVersion),
				...resolveApiVersionMetrics(apiVersionSource),
				apiVersionMode:
					typeof effectiveApiVersionMode === "string" &&
					effectiveApiVersionMode.length > 0
						? effectiveApiVersionMode
						: resolveRequestedApiVersionMode(requestedApiVersion),
			};
		} catch {
			return {
				apiRequestedVersion:
					typeof effectiveRequestedApiVersion === "string" &&
					effectiveRequestedApiVersion.length > 0
						? effectiveRequestedApiVersion
						: normalizeRequestedApiVersionForAnalytics(requestedApiVersion),
				apiReleaseDate: undefined,
				apiVersion: "unknown",
				apiVersionMode: "unknown",
			};
		}
	}

	if (
		typeof effectiveApiVersion === "string" &&
		effectiveApiVersion.length > 0
	) {
		try {
			const resolved = resolveApiVersionMetrics(effectiveApiVersion);
			return {
				...resolved,
				apiVersionMode:
					typeof effectiveApiVersionMode === "string" &&
					effectiveApiVersionMode.length > 0
						? effectiveApiVersionMode
						: getImplicitApiVersionMode(resolved.apiVersion),
			};
		} catch {
			return {
				apiReleaseDate: undefined,
				apiVersion: "unknown",
				apiVersionMode: "unknown",
			};
		}
	}

	if (
		requestContext.routeGroup === "token_mcp" ||
		requestContext.routeGroup === "token_sse"
	) {
		const resolved = resolveApiVersionMetrics("latest");
		return {
			...resolved,
			apiVersionMode: "implicit_latest",
		};
	}

	const resolved = resolveApiVersionMetrics("backwards-compatibility-default");
	return {
		...resolved,
		apiVersionMode: "implicit_legacy",
	};
}

export function resolveCanonicalApiVersionLabel(
	request: Request,
	ctx: ExecutionContext,
): string | undefined {
	return resolveApiVersionLabels(request, ctx).apiVersion;
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
	const requestedApiVersion = new URL(request.url).searchParams.get(
		"api-version",
	);
	if (requestedApiVersion) {
		recorder.setAnalyticsContext({
			apiRequestedVersion:
				normalizeRequestedApiVersionForAnalytics(requestedApiVersion),
		});
	}
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
	const { apiRequestedVersion, apiReleaseDate, apiVersion, apiVersionMode } =
		resolveApiVersionLabels(request, ctx);
	if (apiRequestedVersion) {
		recorder.setAnalyticsContext({
			apiRequestedVersion,
		});
	}
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
	if (apiVersionMode) {
		baseLabels.api_version_mode = apiVersionMode;
	}
	if (apiReleaseDate) {
		baseLabels.api_release_date = apiReleaseDate;
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
	scheduleMetricsFlush(recorder, ctx.waitUntil.bind(ctx));
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
