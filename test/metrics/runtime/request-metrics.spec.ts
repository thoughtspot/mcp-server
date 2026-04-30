import { afterEach, describe, expect, it, vi } from "vitest";
import { METRIC_NAMES } from "../../../src/metrics/runtime/metric-types";
import {
	clearMetricsRecorderFromExecutionContext,
	createRequestMetricsRecorder,
	getMetricsRecorderFromExecutionContext,
	setMetricsRecorderOnExecutionContext,
	withRequestMetrics,
} from "../../../src/metrics/runtime/request-metrics";

describe("withRequestMetrics", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

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

	it("does not await slow metrics flushes on the request path", async () => {
		let resolveFlush!: () => void;
		const waitUntil = vi.fn();
		const analyticsEngineSink = {
			flush: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						resolveFlush = resolve;
					}),
			),
		};
		const ctx = { waitUntil } as unknown as ExecutionContext;

		const result = await withRequestMetrics(
			{ METRICS_SINK_MODE: "analytics_engine" },
			ctx,
			async (recorder) => {
				recorder.count(METRIC_NAMES.httpRequestsTotal, 1, {
					route_group: "mcp",
				});
				return "handler-result";
			},
			{ analyticsEngineSink },
		);

		expect(result).toBe("handler-result");
		expect(analyticsEngineSink.flush).toHaveBeenCalledTimes(1);
		expect(waitUntil).toHaveBeenCalledTimes(1);
		expect(getMetricsRecorderFromExecutionContext(ctx)).toBeUndefined();

		resolveFlush();
		await waitUntil.mock.calls[0][0];
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

	it("does not mask handler failures with slow metrics flushes", async () => {
		let resolveFlush!: () => void;
		const waitUntil = vi.fn();
		const analyticsEngineSink = {
			flush: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						resolveFlush = resolve;
					}),
			),
		};
		const ctx = { waitUntil } as unknown as ExecutionContext;

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

		expect(waitUntil).toHaveBeenCalledTimes(1);
		resolveFlush();
		await waitUntil.mock.calls[0][0];
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

	it("falls back to a noop recorder when metrics config resolution throws", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const env = Object.defineProperty({}, "METRICS_SINK_MODE", {
			get() {
				throw new Error("env unavailable");
			},
		});
		const recorder = createRequestMetricsRecorder(env);

		recorder.count(METRIC_NAMES.httpRequestsTotal);
		await expect(recorder.flush()).resolves.toBeUndefined();
		expect(recorder.snapshot()).toEqual([]);

		expect(errorSpy).toHaveBeenCalledWith(
			"[metrics] Failed to initialize request metrics recorder; using noop recorder",
			expect.any(Error),
		);
	});

	it("falls back to a noop recorder when sink construction throws", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const sinks = Object.defineProperty({}, "analyticsEngineSink", {
			get() {
				throw new Error("sink unavailable");
			},
		});
		const recorder = createRequestMetricsRecorder(
			{ METRICS_SINK_MODE: "analytics_engine" },
			sinks,
		);

		recorder.count(METRIC_NAMES.httpRequestsTotal);
		await expect(recorder.flush()).resolves.toBeUndefined();
		expect(recorder.snapshot()).toEqual([]);

		expect(errorSpy).toHaveBeenCalledWith(
			"[metrics] Failed to initialize request metrics recorder; using noop recorder",
			expect.any(Error),
		);
	});

	it("does not fail the request when waitUntil rejects scheduling", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const ctx = {
			waitUntil: vi.fn(() => {
				throw new Error("waitUntil unavailable");
			}),
		} as unknown as ExecutionContext;
		const analyticsEngineSink = { flush: vi.fn().mockResolvedValue(undefined) };

		const result = await withRequestMetrics(
			{ METRICS_SINK_MODE: "analytics_engine" },
			ctx,
			async (recorder) => {
				recorder.count(METRIC_NAMES.httpRequestsTotal, 1, {
					route_group: "mcp",
				});
				return "handler-result";
			},
			{ analyticsEngineSink },
		);

		expect(result).toBe("handler-result");
		expect(errorSpy).toHaveBeenCalledWith(
			"[metrics] Failed to schedule request metrics flush",
			expect.any(Error),
		);
	});

	it("does not fail the request when metrics delivery fails", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const waitUntil = vi.fn();
		const ctx = { waitUntil } as unknown as ExecutionContext;
		const analyticsEngineSink = {
			flush: vi.fn().mockRejectedValue(new Error("metrics unavailable")),
		};

		const result = await withRequestMetrics(
			{ METRICS_SINK_MODE: "analytics_engine" },
			ctx,
			async (recorder) => {
				recorder.count(METRIC_NAMES.httpRequestsTotal, 1, {
					route_group: "mcp",
				});
				return "handler-result";
			},
			{ analyticsEngineSink },
		);

		expect(result).toBe("handler-result");
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await waitUntil.mock.calls[0][0];
		expect(errorSpy).toHaveBeenCalledWith(
			"[metrics] Flush failed",
			expect.any(Error),
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
