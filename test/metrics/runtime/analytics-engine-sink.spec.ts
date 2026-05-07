import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ANALYTICS_ENGINE_BLOB_FIELDS,
	ANALYTICS_ENGINE_CONTEXT_FIELDS,
	ANALYTICS_ENGINE_DOUBLE_FIELDS,
	ANALYTICS_ENGINE_IDENTITY_BLOB_FIELDS,
	ANALYTICS_ENGINE_INDEX_FIELDS,
	ANALYTICS_ENGINE_LABEL_FIELDS,
	ANALYTICS_ENGINE_RESOURCE_ATTRIBUTE_FIELDS,
	ANALYTICS_ENGINE_SCHEMA_VERSION,
	AnalyticsEngineMetricsSink,
	createAnalyticsEngineMetricsSink,
	getAnalyticsEngineMetricFamily,
	toAnalyticsEngineDataPoint,
} from "../../../src/metrics/runtime/analytics-engine-sink";
import { METRIC_NAMES } from "../../../src/metrics/runtime/metric-types";
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

		expect(dataPoint.indexes).toEqual(["shared"]);
		expect(dataPoint.blobs).toEqual([
			ANALYTICS_ENGINE_SCHEMA_VERSION,
			"tool",
			METRIC_NAMES.toolCallsTotal,
			"counter",
			null,
			null,
			"mcp",
			"oauth",
			null,
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

	it("keeps the Analytics Engine schema aligned with the compact single-index layout", () => {
		expect(ANALYTICS_ENGINE_INDEX_FIELDS).toEqual(["tenant_id"]);
		expect(ANALYTICS_ENGINE_IDENTITY_BLOB_FIELDS).toEqual([
			["tenant_id", "tenantId"],
			["user_id", "userId"],
		]);
		expect(ANALYTICS_ENGINE_LABEL_FIELDS).toEqual([
			"route_group",
			"auth_mode",
			"api_version",
			"api_version_mode",
			"api_release_date",
			"outcome",
			"status_class",
			"tool_name",
			"upstream_operation",
			"message_type",
			"is_done",
		]);
		expect(ANALYTICS_ENGINE_CONTEXT_FIELDS).toEqual([
			["api_requested_version", "apiRequestedVersion"],
			["analytical_session_id", "analyticalSessionId"],
		]);
		expect(ANALYTICS_ENGINE_RESOURCE_ATTRIBUTE_FIELDS).toEqual([
			["service_version", "service.version"],
		]);
		expect(ANALYTICS_ENGINE_BLOB_FIELDS).toEqual([
			"schema_version",
			"event_family",
			"metric_name",
			"metric_kind",
			"tenant_id",
			"user_id",
			...ANALYTICS_ENGINE_LABEL_FIELDS,
			"api_requested_version",
			"analytical_session_id",
			"service_version",
		]);
		expect(ANALYTICS_ENGINE_DOUBLE_FIELDS).toEqual([
			"metric_value",
			"timestamp_ms",
		]);
		expect(ANALYTICS_ENGINE_BLOB_FIELDS).toHaveLength(20);
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
				indexes: ["shared"],
				doubles: [2, 1_714_000_000_000],
			}),
		);
	});

	it("maps request-scoped event identity into the Analytics Engine index and blobs", async () => {
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
				indexes: ["tenant-123"],
				blobs: expect.arrayContaining(["tenant-123", "user-456"]),
			}),
		);
	});

	it("maps analytics context into Analytics Engine blobs", async () => {
		const dataset = { writeDataPoint: vi.fn() };
		const sink = new AnalyticsEngineMetricsSink(dataset);

		await sink.flush({
			observations: [observation],
			resourceAttributes: {},
			analyticsContext: {
				apiRequestedVersion: "2026-10-01",
				analyticalSessionId: "conv-123",
			},
		});

		expect(dataset.writeDataPoint).toHaveBeenCalledWith(
			expect.objectContaining({
				blobs: expect.arrayContaining(["2026-10-01", "conv-123"]),
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
				if (dataPoint?.blobs?.[2] === METRIC_NAMES.toolCallsTotal) {
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
