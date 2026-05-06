import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ANALYTICS_ENGINE_BLOB_FIELDS,
	ANALYTICS_ENGINE_DOUBLE_FIELDS,
	ANALYTICS_ENGINE_INDEX_FIELDS,
	ANALYTICS_ENGINE_LABEL_FIELDS,
	ANALYTICS_ENGINE_RESOURCE_ATTRIBUTE_FIELDS,
	ANALYTICS_ENGINE_SCHEMA_VERSION,
	AnalyticsEngineMetricsSink,
	createAnalyticsEngineMetricsSink,
	getAnalyticsEngineMetricFamily,
	toAnalyticsEngineDataPoint,
} from "../../../src/metrics/runtime/analytics-engine-sink";
import {
	APPROVED_METRIC_LABEL_KEYS,
	METRIC_NAMES,
} from "../../../src/metrics/runtime/metric-types";
import type { MetricObservation } from "../../../src/metrics/runtime/metrics-sink";

describe("AnalyticsEngineMetricsSink", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const observation = {
		kind: "counter",
		name: METRIC_NAMES.toolCallsTotal,
		value: 2,
		labels: {
			tool_name: "create_liveboard",
			outcome: "success",
			route_group: "mcp",
			transport: "mcp",
			api_surface: "mcp",
			auth_mode: "oauth",
		},
		timestampMs: 1_714_000_000_000,
	} satisfies MetricObservation;

	it("maps metric observations into the Analytics Engine schema", () => {
		const dataPoint = toAnalyticsEngineDataPoint(observation, {
			"deployment.environment": "production",
			"service.name": "thoughtspot-mcp-server",
			"service.namespace": "thoughtspot",
			"service.version": "0.5.0",
		});

		expect(dataPoint.indexes).toEqual([
			ANALYTICS_ENGINE_SCHEMA_VERSION,
			"tool",
			METRIC_NAMES.toolCallsTotal,
			null,
			null,
		]);
		expect(dataPoint.blobs).toEqual([
			"counter",
			"mcp",
			"mcp",
			"oauth",
			"mcp",
			null,
			null,
			"success",
			null,
			"create_liveboard",
			null,
			null,
			null,
			null,
			null,
			"production",
			"thoughtspot-mcp-server",
			"thoughtspot",
			"0.5.0",
		]);
		expect(dataPoint.doubles).toEqual([2, 1_714_000_000_000]);
	});

	it("classifies every metric name into a stable event family", () => {
		const validFamilies = [
			"analysis",
			"auth",
			"dashboard",
			"http",
			"resource",
			"stream_storage",
			"tool",
			"upstream",
		];

		for (const name of Object.values(METRIC_NAMES)) {
			expect(validFamilies).toContain(getAnalyticsEngineMetricFamily(name));
		}
		expect(
			getAnalyticsEngineMetricFamily(METRIC_NAMES.sessionsStartedTotal),
		).toBe("auth");
	});

	it("keeps the Analytics Engine schema aligned with approved labels and resource attributes", () => {
		expect(ANALYTICS_ENGINE_LABEL_FIELDS).toEqual(APPROVED_METRIC_LABEL_KEYS);
		expect(ANALYTICS_ENGINE_RESOURCE_ATTRIBUTE_FIELDS).toEqual([
			["deployment_environment", "deployment.environment"],
			["service_name", "service.name"],
			["service_namespace", "service.namespace"],
			["service_version", "service.version"],
		]);
		expect(ANALYTICS_ENGINE_INDEX_FIELDS).toEqual([
			"schema_version",
			"event_family",
			"metric_name",
			"tenant_id",
			"user_id",
		]);
		expect(ANALYTICS_ENGINE_BLOB_FIELDS).toEqual([
			"metric_kind",
			...APPROVED_METRIC_LABEL_KEYS,
			"deployment_environment",
			"service_name",
			"service_namespace",
			"service_version",
		]);
		expect(ANALYTICS_ENGINE_DOUBLE_FIELDS).toEqual([
			"metric_value",
			"timestamp_ms",
		]);
	});

	it("writes one data point per observation", async () => {
		const dataset = { writeDataPoint: vi.fn() };
		const sink = new AnalyticsEngineMetricsSink(dataset);

		await sink.flush({
			observations: [observation],
			resourceAttributes: {
				"deployment.environment": "local",
			},
		});

		expect(dataset.writeDataPoint).toHaveBeenCalledTimes(1);
		expect(dataset.writeDataPoint).toHaveBeenCalledWith(
			expect.objectContaining({
				indexes: [
					ANALYTICS_ENGINE_SCHEMA_VERSION,
					"tool",
					METRIC_NAMES.toolCallsTotal,
					null,
					null,
				],
				doubles: [2, 1_714_000_000_000],
			}),
		);
	});

	it("maps request-scoped event identity into Analytics Engine indexes", async () => {
		const dataset = { writeDataPoint: vi.fn() };
		const sink = new AnalyticsEngineMetricsSink(dataset);

		await sink.flush({
			observations: [observation],
			resourceAttributes: {},
			eventIdentity: {
				tenantId: "tenant-123",
				userId: "user-456",
			},
		});

		expect(dataset.writeDataPoint).toHaveBeenCalledWith(
			expect.objectContaining({
				indexes: [
					ANALYTICS_ENGINE_SCHEMA_VERSION,
					"tool",
					METRIC_NAMES.toolCallsTotal,
					"tenant-123",
					"user-456",
				],
			}),
		);
	});

	it("continues writing remaining data points when one write fails", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const secondObservation = {
			...observation,
			name: METRIC_NAMES.httpRequestsTotal,
		} satisfies MetricObservation;
		const dataset = {
			writeDataPoint: vi.fn((dataPoint) => {
				if (dataPoint?.indexes?.[2] === METRIC_NAMES.toolCallsTotal) {
					throw new Error("write failed");
				}
			}),
		};
		const sink = new AnalyticsEngineMetricsSink(dataset);

		await sink.flush({
			observations: [observation, secondObservation],
			resourceAttributes: {},
		});

		expect(dataset.writeDataPoint).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenCalledWith(
			`[metrics] Failed to write Analytics Engine data point for ${METRIC_NAMES.toolCallsTotal}`,
			expect.any(Error),
		);
	});

	it("only creates a sink when the Analytics Engine binding is present", () => {
		expect(
			createAnalyticsEngineMetricsSink({ writeDataPoint: vi.fn() }),
		).toBeInstanceOf(AnalyticsEngineMetricsSink);
		expect(createAnalyticsEngineMetricsSink(undefined)).toBeUndefined();
		expect(createAnalyticsEngineMetricsSink({})).toBeUndefined();
		expect(
			createAnalyticsEngineMetricsSink({ writeDataPoint: "not-a-function" }),
		).toBeUndefined();
	});
});
