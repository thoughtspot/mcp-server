import { CompositeMetricsSink } from "./composite-sink";
import { NoopMetricsSink } from "./noop-sink";
import type { MetricResourceAttributes, MetricsSink } from "./metrics-sink";

export type MetricsSinkMode = "none" | "analytics_engine" | "grafana" | "both";
export type MetricsDeploymentEnvironment = "production" | "local";
export type MetricsEnvLike = Partial<Record<string, unknown>>;

export type MetricsRuntimeConfig = {
	sinkMode: MetricsSinkMode;
	deploymentEnvironment: MetricsDeploymentEnvironment;
	resourceAttributes: MetricResourceAttributes;
};

export type ConfiguredMetricsSinks = {
	analyticsEngineSink?: MetricsSink;
	grafanaSink?: MetricsSink;
};

function getProcessEnvValue(name: string): string | undefined {
	if (typeof process === "undefined") {
		return undefined;
	}
	return process.env?.[name];
}

function readConfigValue(
	env: MetricsEnvLike | undefined,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const envValue = env?.[key];
		if (typeof envValue === "string" && envValue.length > 0) {
			return envValue;
		}

		const processEnvValue = getProcessEnvValue(key);
		if (processEnvValue && processEnvValue.length > 0) {
			return processEnvValue;
		}
	}

	return undefined;
}

export function resolveMetricsSinkMode(rawValue?: string): MetricsSinkMode {
	switch (rawValue?.trim().toLowerCase()) {
		case "none":
			return "none";
		case "analytics-engine":
		case "analytics_engine":
		case "analytics":
			return "analytics_engine";
		case "grafana":
			return "grafana";
		case "both":
		case undefined:
			return "both";
		default:
			console.warn(
				`[metrics] Unknown METRICS_SINK_MODE "${rawValue}", defaulting to "both"`,
			);
			return "both";
	}
}

export function resolveMetricsDeploymentEnvironment(
	rawValue?: string,
): MetricsDeploymentEnvironment {
	switch (rawValue?.trim().toLowerCase()) {
		case "local":
			return "local";
		case "production":
		case undefined:
			return "production";
		default:
			console.warn(
				`[metrics] Unknown metrics environment "${rawValue}", defaulting to "production"`,
			);
			return "production";
	}
}

export function resolveMetricResourceAttributes(
	deploymentEnvironment: MetricsDeploymentEnvironment,
	serviceVersion?: string,
): MetricResourceAttributes {
	const resourceAttributes: MetricResourceAttributes = {
		"service.name": "thoughtspot-mcp-server",
		"service.namespace": "thoughtspot",
		"deployment.environment": deploymentEnvironment,
		"cloud.provider": "cloudflare",
		"cloud.platform": "cloudflare_workers",
	};

	if (serviceVersion) {
		resourceAttributes["service.version"] = serviceVersion;
	}

	return resourceAttributes;
}

export function resolveMetricsRuntimeConfig(
	env?: MetricsEnvLike,
): MetricsRuntimeConfig {
	const sinkMode = resolveMetricsSinkMode(
		readConfigValue(env, "METRICS_SINK_MODE"),
	);
	const deploymentEnvironment = resolveMetricsDeploymentEnvironment(
		readConfigValue(
			env,
			"METRICS_DEPLOYMENT_ENVIRONMENT",
			"DEPLOYMENT_ENVIRONMENT",
		),
	);
	const serviceVersion = readConfigValue(env, "SERVICE_VERSION", "npm_package_version");

	return {
		sinkMode,
		deploymentEnvironment,
		resourceAttributes: resolveMetricResourceAttributes(
			deploymentEnvironment,
			serviceVersion,
		),
	};
}

export function createConfiguredMetricsSink(
	config: Pick<MetricsRuntimeConfig, "sinkMode">,
	sinks: ConfiguredMetricsSinks = {},
): MetricsSink {
	switch (config.sinkMode) {
		case "none":
			return new NoopMetricsSink();
		case "analytics_engine":
			return sinks.analyticsEngineSink ?? new NoopMetricsSink();
		case "grafana":
			return sinks.grafanaSink ?? new NoopMetricsSink();
		case "both":
		default:
			return new CompositeMetricsSink([
				sinks.analyticsEngineSink ?? new NoopMetricsSink(),
				sinks.grafanaSink ?? new NoopMetricsSink(),
			]);
	}
}
