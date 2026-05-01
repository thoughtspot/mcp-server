import { describe, expect, it, vi } from "vitest";
import {
	GrafanaOtlpMetricsSink,
	createGrafanaOtlpMetricsSink,
	resolveGrafanaOtlpSinkConfig,
	toOtlpMetricsPayload,
} from "../../../src/metrics/runtime/grafana-otlp-sink";
import { METRIC_NAMES } from "../../../src/metrics/runtime/metric-types";
import type { MetricsFlushPayload } from "../../../src/metrics/runtime/metrics-sink";

describe("GrafanaOtlpMetricsSink", () => {
	const payload = {
		observations: [
			{
				kind: "counter",
				name: METRIC_NAMES.httpRequestsTotal,
				value: 1,
				labels: {
					route_group: "mcp",
					status_class: "2xx",
				},
				timestampMs: 1_714_000_000_000,
			},
			{
				kind: "histogram",
				name: METRIC_NAMES.httpRequestDurationMs,
				value: 123,
				labels: {
					route_group: "mcp",
				},
				timestampMs: 1_714_000_000_123,
			},
			{
				kind: "gauge",
				name: METRIC_NAMES.httpInflightRequests,
				value: 3,
				labels: {},
				timestampMs: 1_714_000_000_456,
			},
		],
		resourceAttributes: {
			"deployment.environment": "production",
			"service.name": "thoughtspot-mcp-server",
			"service.namespace": "thoughtspot",
		},
	} satisfies MetricsFlushPayload;

	it("maps observations into OTLP JSON metrics payloads", () => {
		const otlpPayload = toOtlpMetricsPayload(payload);
		const metrics = otlpPayload.resourceMetrics[0].scopeMetrics[0].metrics;

		expect(otlpPayload.resourceMetrics[0].resource.attributes).toEqual([
			{
				key: "deployment.environment",
				value: { stringValue: "production" },
			},
			{
				key: "service.name",
				value: { stringValue: "thoughtspot-mcp-server" },
			},
			{ key: "service.namespace", value: { stringValue: "thoughtspot" } },
		]);
		expect(metrics).toHaveLength(3);
		expect(metrics[0]).toMatchObject({
			name: METRIC_NAMES.httpRequestsTotal,
			sum: {
				aggregationTemporality: 1,
				isMonotonic: true,
				dataPoints: [
					{
						asDouble: 1,
						timeUnixNano: "1714000000000000000",
						attributes: [
							{ key: "route_group", value: { stringValue: "mcp" } },
							{ key: "status_class", value: { stringValue: "2xx" } },
						],
					},
				],
			},
		});
		expect(metrics[1]).toMatchObject({
			name: METRIC_NAMES.httpRequestDurationMs,
			histogram: {
				aggregationTemporality: 1,
				dataPoints: [
					{
						count: "1",
						sum: 123,
						bucketCounts: [
							"0",
							"0",
							"0",
							"1",
							"0",
							"0",
							"0",
							"0",
							"0",
							"0",
							"0",
						],
					},
				],
			},
		});
		expect(metrics[2]).toMatchObject({
			name: METRIC_NAMES.httpInflightRequests,
			gauge: {
				dataPoints: [{ asDouble: 3 }],
			},
		});
	});

	it("aggregates observations with identical attributes before export", () => {
		const otlpPayload = toOtlpMetricsPayload({
			observations: [
				{
					kind: "counter",
					name: METRIC_NAMES.httpRequestsTotal,
					value: 1,
					labels: {
						route_group: "mcp",
						status_class: "2xx",
					},
					timestampMs: 1_714_000_000_100,
				},
				{
					kind: "counter",
					name: METRIC_NAMES.httpRequestsTotal,
					value: 2,
					labels: {
						status_class: "2xx",
						route_group: "mcp",
					},
					timestampMs: 1_714_000_000_123.5,
				},
				{
					kind: "histogram",
					name: METRIC_NAMES.httpRequestDurationMs,
					value: 25,
					labels: {
						route_group: "mcp",
					},
					timestampMs: 1_714_000_000_200,
				},
				{
					kind: "histogram",
					name: METRIC_NAMES.httpRequestDurationMs,
					value: 75,
					labels: {
						route_group: "mcp",
					},
					timestampMs: 1_714_000_000_201,
				},
				{
					kind: "gauge",
					name: METRIC_NAMES.httpInflightRequests,
					value: 1,
					labels: {
						route_group: "mcp",
					},
					timestampMs: 1_714_000_000_300,
				},
				{
					kind: "gauge",
					name: METRIC_NAMES.httpInflightRequests,
					value: 4,
					labels: {
						route_group: "mcp",
					},
					timestampMs: 1_714_000_000_301,
				},
			],
			resourceAttributes: {},
		});
		const [counterMetric, histogramMetric, gaugeMetric] =
			otlpPayload.resourceMetrics[0].scopeMetrics[0].metrics;

		expect(counterMetric).toMatchObject({
			sum: {
				dataPoints: [
					{
						asDouble: 3,
						timeUnixNano: "1714000000123500000",
					},
				],
			},
		});
		expect(counterMetric.sum.dataPoints).toHaveLength(1);
		expect(histogramMetric).toMatchObject({
			histogram: {
				dataPoints: [
					{
						count: "2",
						sum: 100,
						bucketCounts: [
							"1",
							"0",
							"1",
							"0",
							"0",
							"0",
							"0",
							"0",
							"0",
							"0",
							"0",
						],
					},
				],
			},
		});
		expect(histogramMetric.histogram.dataPoints).toHaveLength(1);
		expect(gaugeMetric).toMatchObject({
			gauge: {
				dataPoints: [
					{
						asDouble: 4,
						timeUnixNano: "1714000000301000000",
					},
				],
			},
		});
		expect(gaugeMetric.gauge.dataPoints).toHaveLength(1);
	});

	it("keeps nanosecond precision when fractional milliseconds round up a microsecond", () => {
		const otlpPayload = toOtlpMetricsPayload({
			observations: [
				{
					kind: "counter",
					name: METRIC_NAMES.httpRequestsTotal,
					value: 1,
					labels: {
						route_group: "mcp",
					},
					timestampMs: 1_714_000_000_123.9995,
				},
			],
			resourceAttributes: {},
		});
		const [metric] = otlpPayload.resourceMetrics[0].scopeMetrics[0].metrics;

		expect(metric).toMatchObject({
			sum: {
				dataPoints: [
					{
						timeUnixNano: "1714000000123999512",
					},
				],
			},
		});
	});

	it("posts OTLP JSON to the normalized metrics endpoint", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }));
		const sink = new GrafanaOtlpMetricsSink({
			endpoint: "https://otlp.example.com/otlp",
			username: "12345",
			apiToken: "secret",
			fetchFn,
		});

		await sink.flush(payload);

		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(fetchFn).toHaveBeenCalledWith(
			"https://otlp.example.com/otlp/v1/metrics",
			expect.objectContaining({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Basic MTIzNDU6c2VjcmV0",
				},
				body: expect.any(String),
			}),
		);
	});

	it("supports full metrics endpoints and explicit auth headers", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }));
		const sink = new GrafanaOtlpMetricsSink({
			endpoint: "https://otlp.example.com/v1/metrics",
			authHeader: "Bearer token",
			fetchFn,
		});

		await sink.flush(payload);

		expect(fetchFn).toHaveBeenCalledWith(
			"https://otlp.example.com/v1/metrics",
			expect.objectContaining({
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer token",
				},
			}),
		);
	});

	it("encodes Grafana Cloud Basic auth credentials as UTF-8", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }));
		const sink = new GrafanaOtlpMetricsSink({
			endpoint: "https://otlp.example.com/otlp",
			username: "üser",
			apiToken: "päss",
			fetchFn,
		});

		await sink.flush(payload);

		expect(fetchFn).toHaveBeenCalledWith(
			"https://otlp.example.com/otlp/v1/metrics",
			expect.objectContaining({
				headers: {
					"Content-Type": "application/json",
					Authorization: "Basic w7xzZXI6cMOkc3M=",
				},
			}),
		);
	});

	it("skips export when there are no observations", async () => {
		const fetchFn = vi.fn();
		const sink = new GrafanaOtlpMetricsSink({
			endpoint: "https://otlp.example.com",
			fetchFn,
		});

		await sink.flush({ observations: [], resourceAttributes: {} });

		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("throws on non-2xx responses so the recorder can isolate failures", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(new Response("bad token", { status: 401 }));
		const sink = new GrafanaOtlpMetricsSink({
			endpoint: "https://otlp.example.com",
			fetchFn,
		});

		await expect(sink.flush(payload)).rejects.toThrow(
			"Grafana OTLP metrics export failed with status 401: bad token",
		);
	});

	it("truncates large export error bodies", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(new Response("x".repeat(1_010), { status: 500 }));
		const sink = new GrafanaOtlpMetricsSink({
			endpoint: "https://otlp.example.com",
			fetchFn,
		});

		await expect(sink.flush(payload)).rejects.toThrow(
			`Grafana OTLP metrics export failed with status 500: ${"x".repeat(997)}...`,
		);
	});

	it("resolves config from Grafana and OTLP environment names", () => {
		expect(
			resolveGrafanaOtlpSinkConfig({
				GRAFANA_OTLP_ENDPOINT: "https://otlp.example.com/otlp",
				GRAFANA_CLOUD_ACCOUNT_ID: "12345",
				GRAFANA_CLOUD_API_TOKEN: "test-api-token",
			}),
		).toEqual({
			endpoint: "https://otlp.example.com/otlp/v1/metrics",
			username: "12345",
			apiToken: "test-api-token",
			authHeader: undefined,
		});
		expect(
			resolveGrafanaOtlpSinkConfig({
				OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com",
			}),
		).toMatchObject({
			endpoint: "https://collector.example.com/v1/metrics",
		});
		expect(resolveGrafanaOtlpSinkConfig()).toBeUndefined();
	});

	it("supports Grafana Cloud generated OTLP headers", () => {
		expect(
			resolveGrafanaOtlpSinkConfig({
				OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.com/otlp",
				OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20abc123",
			}),
		).toMatchObject({
			endpoint: "https://otlp.example.com/otlp/v1/metrics",
			authHeader: "Basic abc123",
		});
	});

	it("only creates a sink when an OTLP endpoint is configured", () => {
		expect(
			createGrafanaOtlpMetricsSink({
				GRAFANA_OTLP_ENDPOINT: "https://otlp.example.com",
			}),
		).toBeInstanceOf(GrafanaOtlpMetricsSink);
		expect(createGrafanaOtlpMetricsSink({})).toBeUndefined();
	});
});
