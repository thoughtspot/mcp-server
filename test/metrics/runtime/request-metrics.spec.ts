import { afterEach, describe, expect, it, vi } from "vitest";
import { METRIC_NAMES } from "../../../src/metrics/runtime/metric-types";
import {
	clearMetricsRecorderFromExecutionContext,
	createRequestMetricsRecorder,
	getMetricsRecorderFromExecutionContext,
	recordBearerAuthRequestMetric,
	recordHttpRequestMetrics,
	recordStatusMetric,
	resolveApiVersionLabels,
	resolveCanonicalApiVersionLabel,
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

	it("uses Grafana OTLP config as the default grafana sink", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 200 }));
		const recorder = createRequestMetricsRecorder({
			METRICS_SINK_MODE: "grafana",
			GRAFANA_OTLP_ENDPOINT: "https://otlp.example.com/otlp",
			GRAFANA_OTLP_AUTH_HEADER: "Bearer test",
		});

		recorder.count(METRIC_NAMES.httpRequestsTotal, 1, {
			route_group: "mcp",
		});
		await recorder.flush();

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://otlp.example.com/otlp/v1/metrics",
			expect.objectContaining({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test",
				},
				body: expect.any(String),
			}),
		);
	});

	it("uses the Analytics Engine binding as the default analytics sink", async () => {
		const analyticsDataset = { writeDataPoint: vi.fn() };
		const recorder = createRequestMetricsRecorder({
			METRICS_SINK_MODE: "analytics_engine",
			ANALYTICS: analyticsDataset,
		});

		recorder.count(METRIC_NAMES.httpRequestsTotal, 1, {
			route_group: "mcp",
		});
		await recorder.flush();

		expect(analyticsDataset.writeDataPoint).toHaveBeenCalledTimes(1);
		expect(analyticsDataset.writeDataPoint).toHaveBeenCalledWith(
			expect.objectContaining({
				indexes: expect.arrayContaining([METRIC_NAMES.httpRequestsTotal]),
			}),
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
			"[metrics] Failed to schedule metrics flush",
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

	it("reuses the default Grafana sink for the same env object", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 200 }));
		const env = {
			METRICS_SINK_MODE: "grafana",
			GRAFANA_OTLP_ENDPOINT: "https://otlp.example.com/first",
			GRAFANA_OTLP_AUTH_HEADER: "Bearer first",
		};
		const firstRecorder = createRequestMetricsRecorder(env);

		env.GRAFANA_OTLP_ENDPOINT = "https://otlp.example.com/second";
		env.GRAFANA_OTLP_AUTH_HEADER = "Bearer second";
		const secondRecorder = createRequestMetricsRecorder(env);

		firstRecorder.count(METRIC_NAMES.httpRequestsTotal, 1, {
			route_group: "mcp",
		});
		secondRecorder.count(METRIC_NAMES.httpRequestsTotal, 1, {
			route_group: "mcp",
		});
		await firstRecorder.flush();
		await secondRecorder.flush();

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://otlp.example.com/first/v1/metrics",
			expect.objectContaining({
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer first",
				},
			}),
		);
		expect(fetchSpy).not.toHaveBeenCalledWith(
			"https://otlp.example.com/second/v1/metrics",
			expect.anything(),
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

	it("records HTTP request metrics with canonical route and version labels", () => {
		const recorder = createRequestMetricsRecorder();
		const ctx = {
			props: {
				apiVersion: "beta",
			},
		} as unknown as ExecutionContext;
		const request = new Request("https://example.com/mcp?api-version=beta");
		const response = new Response("ok", { status: 200 });

		recordHttpRequestMetrics(recorder, request, response, ctx, 123);

		expect(recorder.snapshot()).toEqual([
			expect.objectContaining({
				kind: "counter",
				name: METRIC_NAMES.httpRequestsTotal,
				value: 1,
				labels: {
					api_surface: "mcp",
					api_version: "beta",
					api_version_mode: "beta",
					auth_mode: "oauth",
					outcome: "success",
					route_group: "mcp",
					status_class: "2xx",
					transport: "mcp",
				},
			}),
			expect.objectContaining({
				kind: "histogram",
				name: METRIC_NAMES.httpRequestDurationMs,
				value: 123,
				labels: {
					api_surface: "mcp",
					api_version: "beta",
					api_version_mode: "beta",
					auth_mode: "oauth",
					outcome: "success",
					route_group: "mcp",
					transport: "mcp",
				},
			}),
		]);
	});

	it("labels unversioned token routes as latest when no explicit API version is requested", () => {
		const ctx = {} as ExecutionContext;
		const request = new Request("https://example.com/token/mcp");

		expect(resolveCanonicalApiVersionLabel(request, ctx)).toBe("latest");
	});

	it("uses the effective default surface when bearer routes ignore an api-version query", () => {
		const ctx = {
			props: {
				apiVersion: "backwards-compatibility-default",
			},
		} as unknown as ExecutionContext;
		const request = new Request(
			"https://example.com/bearer/mcp?api-version=beta",
		);

		expect(resolveCanonicalApiVersionLabel(request, ctx)).toBe("default");
	});

	it("labels legacy OAuth routes as implicit default when no selector is provided", () => {
		const request = new Request("https://example.com/mcp");

		expect(resolveApiVersionLabels(request, {} as ExecutionContext)).toEqual({
			apiVersion: "default",
			apiVersionMode: "implicit_default",
		});
	});

	it("labels unversioned token routes as following latest", () => {
		const request = new Request("https://example.com/token/mcp");

		expect(resolveApiVersionLabels(request, {} as ExecutionContext)).toEqual({
			apiVersion: "latest",
			apiVersionMode: "latest",
		});
	});

	it("labels date-based token routes as pinned even when they currently resolve to latest", () => {
		const request = new Request(
			"https://example.com/token/mcp?api-version=2026-05-01",
		);

		expect(resolveApiVersionLabels(request, {} as ExecutionContext)).toEqual({
			apiVersion: "latest",
			apiVersionMode: "pinned",
		});
	});

	it("maps stable date-based versions onto the latest label", () => {
		const ctx = {} as ExecutionContext;
		const request = new Request(
			"https://example.com/token/mcp?api-version=2026-05-01",
		);

		expect(resolveCanonicalApiVersionLabel(request, ctx)).toBe("latest");
	});

	it("maps older date-based versions onto the default label", () => {
		const ctx = {} as ExecutionContext;
		const request = new Request(
			"https://example.com/token/mcp?api-version=2025-12-01",
		);

		expect(resolveCanonicalApiVersionLabel(request, ctx)).toBe("default");
	});

	it("labels unresolved api-version values as unknown", () => {
		const ctx = {
			props: {
				apiVersion: "garbage",
			},
		} as unknown as ExecutionContext;
		const request = new Request(
			"https://example.com/token/mcp?api-version=garbage",
		);

		expect(resolveCanonicalApiVersionLabel(request, ctx)).toBe("unknown");
	});

	it("records auth outcome counters from response status", () => {
		const recorder = createRequestMetricsRecorder();

		recordStatusMetric(recorder, METRIC_NAMES.oauthAuthorizeSubmitTotal, 302);

		expect(recorder.snapshot()).toEqual([
			expect.objectContaining({
				kind: "counter",
				name: METRIC_NAMES.oauthAuthorizeSubmitTotal,
				value: 1,
				labels: {
					outcome: "success",
				},
			}),
		]);
	});

	it("records bearer auth traffic with route and transport labels", () => {
		const recorder = createRequestMetricsRecorder();
		const request = new Request("https://example.com/token/sse");

		recordBearerAuthRequestMetric(recorder, request, 401);

		expect(recorder.snapshot()).toEqual([
			expect.objectContaining({
				kind: "counter",
				name: METRIC_NAMES.bearerAuthRequestsTotal,
				value: 1,
				labels: {
					outcome: "client_error",
					route_group: "token_sse",
					transport: "sse",
				},
			}),
		]);
	});
});
