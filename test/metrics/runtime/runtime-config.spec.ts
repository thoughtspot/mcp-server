import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositeMetricsSink } from "../../../src/metrics/runtime/composite-sink";
import { NoopMetricsSink } from "../../../src/metrics/runtime/noop-sink";
import {
	createConfiguredMetricsSink,
	resolveMetricResourceAttributes,
	resolveMetricsDeploymentEnvironment,
	resolveMetricsRuntimeConfig,
	resolveMetricsSinkMode,
} from "../../../src/metrics/runtime/runtime-config";

describe("runtime-config", () => {
	const baseEnv = { ...process.env };

	afterEach(() => {
		vi.stubGlobal("process", { env: { ...baseEnv } });
		vi.restoreAllMocks();
	});

	it("defaults to both sinks and production attributes", () => {
		const config = resolveMetricsRuntimeConfig();

		expect(config.sinkMode).toBe("both");
		expect(config.deploymentEnvironment).toBe("production");
		expect(config.resourceAttributes["service.name"]).toBe(
			"thoughtspot-mcp-server",
		);
		expect(config.resourceAttributes["deployment.environment"]).toBe(
			"production",
		);
	});

	it("parses supported sink mode aliases", () => {
		expect(resolveMetricsSinkMode("analytics-engine")).toBe("analytics_engine");
		expect(resolveMetricsSinkMode("analytics")).toBe("analytics_engine");
		expect(resolveMetricsSinkMode("grafana")).toBe("grafana");
		expect(resolveMetricsSinkMode("none")).toBe("none");
		expect(resolveMetricsSinkMode(" both ")).toBe("both");
	});

	it("warns and defaults for unknown sink mode and deployment environment", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(resolveMetricsSinkMode("mystery")).toBe("both");
		expect(resolveMetricsDeploymentEnvironment("qa")).toBe("production");
		expect(warnSpy).toHaveBeenCalledTimes(2);
	});

	it("resolves runtime config from explicit env values", () => {
		const config = resolveMetricsRuntimeConfig({
			METRICS_SINK_MODE: "analytics",
			METRICS_DEPLOYMENT_ENVIRONMENT: "local",
			SERVICE_VERSION: "1.2.3",
		});

		expect(config.sinkMode).toBe("analytics_engine");
		expect(config.deploymentEnvironment).toBe("local");
		expect(config.resourceAttributes).toMatchObject({
			"deployment.environment": "local",
			"service.version": "1.2.3",
		});
	});

	it("falls back to alternate env key names", () => {
		const config = resolveMetricsRuntimeConfig({
			METRICS_SINK_MODE: "grafana",
			DEPLOYMENT_ENVIRONMENT: "local",
			npm_package_version: "9.9.9",
		});

		expect(config.sinkMode).toBe("grafana");
		expect(config.deploymentEnvironment).toBe("local");
		expect(config.resourceAttributes["service.version"]).toBe("9.9.9");
	});

	it("includes service.version only when provided", () => {
		expect(resolveMetricResourceAttributes("production")).not.toHaveProperty(
			"service.version",
		);
		expect(
			resolveMetricResourceAttributes("local", "2026.04.23")["service.version"],
		).toBe("2026.04.23");
	});

	it("creates noop sinks for none and missing single-sink modes", async () => {
		const noneSink = createConfiguredMetricsSink({ sinkMode: "none" });
		const analyticsSink = createConfiguredMetricsSink({
			sinkMode: "analytics_engine",
		});
		const grafanaSink = createConfiguredMetricsSink({ sinkMode: "grafana" });

		expect(noneSink).toBeInstanceOf(NoopMetricsSink);
		expect(analyticsSink).toBeInstanceOf(NoopMetricsSink);
		expect(grafanaSink).toBeInstanceOf(NoopMetricsSink);
		await expect(
			noneSink.flush({ observations: [], resourceAttributes: {} }),
		).resolves.toBeUndefined();
	});

	it("returns the provided single sink when configured", () => {
		const analyticsEngineSink = { flush: vi.fn() };
		const grafanaSink = { flush: vi.fn() };

		expect(
			createConfiguredMetricsSink(
				{ sinkMode: "analytics_engine" },
				{ analyticsEngineSink },
			),
		).toBe(analyticsEngineSink);
		expect(
			createConfiguredMetricsSink({ sinkMode: "grafana" }, { grafanaSink }),
		).toBe(grafanaSink);
	});

	it("creates a composite sink for both mode and tolerates missing sinks", async () => {
		const analyticsEngineSink = { flush: vi.fn() };
		const sink = createConfiguredMetricsSink(
			{ sinkMode: "both" },
			{ analyticsEngineSink },
		);

		await expect(
			sink.flush({ observations: [], resourceAttributes: {} }),
		).resolves.toBeUndefined();

		expect(sink).toBeInstanceOf(CompositeMetricsSink);
		expect(analyticsEngineSink.flush).toHaveBeenCalledTimes(1);
	});
});
