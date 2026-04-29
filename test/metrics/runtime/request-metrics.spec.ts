import { describe, expect, it, vi } from "vitest";
import { METRIC_NAMES } from "../../../src/metrics/runtime/metric-types";
import {
	clearMetricsRecorderFromExecutionContext,
	createRequestMetricsRecorder,
	getMetricsRecorderFromExecutionContext,
	setMetricsRecorderOnExecutionContext,
	withRequestMetrics,
} from "../../../src/metrics/runtime/request-metrics";

describe("withRequestMetrics", () => {
	it("exposes a request-scoped recorder during handler execution and clears it afterwards", async () => {
		const waitUntil = vi.fn();
		const analyticsEngineSink = { flush: vi.fn().mockResolvedValue(undefined) };
		const ctx = { waitUntil } as ExecutionContext;

		await withRequestMetrics(
			{ METRICS_SINK_MODE: "analytics_engine" },
			ctx,
			async (recorder) => {
				expect(getMetricsRecorderFromExecutionContext(ctx)).toBe(recorder);
				recorder.count(METRIC_NAMES.httpRequestsTotal, 1, {
					route_group: "mcp",
				});
			},
			{ analyticsEngineSink },
		);

		expect(getMetricsRecorderFromExecutionContext(ctx)).toBeUndefined();
		expect(waitUntil).toHaveBeenCalledTimes(1);
		expect(analyticsEngineSink.flush).toHaveBeenCalledTimes(1);
	});

	it("flushes and clears the request-scoped recorder when the handler throws", async () => {
		const waitUntil = vi.fn();
		const analyticsEngineSink = { flush: vi.fn().mockResolvedValue(undefined) };
		const ctx = { waitUntil } as ExecutionContext;

		await expect(
			withRequestMetrics(
				{ METRICS_SINK_MODE: "analytics_engine" },
				ctx,
				async (recorder) => {
					recorder.count(METRIC_NAMES.httpRequestsTotal, 1, {
						route_group: "mcp",
					});
					throw new Error("boom");
				},
				{ analyticsEngineSink },
			),
		).rejects.toThrow("boom");

		expect(getMetricsRecorderFromExecutionContext(ctx)).toBeUndefined();
		expect(waitUntil).toHaveBeenCalledTimes(1);
		expect(analyticsEngineSink.flush).toHaveBeenCalledTimes(1);
	});

	it("creates a recorder with resolved resource attributes", async () => {
		const grafanaSink = { flush: vi.fn().mockResolvedValue(undefined) };
		const recorder = createRequestMetricsRecorder(
			{
				METRICS_SINK_MODE: "grafana",
				METRICS_DEPLOYMENT_ENVIRONMENT: "local",
				SERVICE_VERSION: "1.2.3",
			},
			{ grafanaSink },
		);

		recorder.count(METRIC_NAMES.httpRequestsTotal);
		await recorder.flush();

		expect(grafanaSink.flush).toHaveBeenCalledWith(
			expect.objectContaining({
				resourceAttributes: expect.objectContaining({
					"deployment.environment": "local",
					"service.version": "1.2.3",
				}),
			}),
		);
	});

	it("supports setting and clearing the recorder on the execution context", () => {
		const ctx = {} as ExecutionContext;
		const recorder = createRequestMetricsRecorder();

		expect(setMetricsRecorderOnExecutionContext(ctx, recorder)).toBe(recorder);
		expect(getMetricsRecorderFromExecutionContext(ctx)).toBe(recorder);

		clearMetricsRecorderFromExecutionContext(ctx);

		expect(getMetricsRecorderFromExecutionContext(ctx)).toBeUndefined();
	});
});
