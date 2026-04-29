import { describe, expect, it, vi } from "vitest";
import { METRIC_NAMES } from "../../../src/metrics/runtime/metric-types";
import { RequestMetricsRecorder } from "../../../src/metrics/runtime/metrics-recorder";

describe("RequestMetricsRecorder", () => {
	it("records normalized observations and flushes them once", async () => {
		const flushSpy = vi.fn().mockResolvedValue(undefined);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const recorder = new RequestMetricsRecorder({
			sink: { flush: flushSpy },
			resourceAttributes: { "service.name": "thoughtspot-mcp-server" },
			now: () => 123,
		});

		recorder.count(METRIC_NAMES.httpRequestsTotal, 1, {
			route_group: "mcp",
			instanceUrl: "forbidden",
		});
		recorder.histogram(METRIC_NAMES.httpRequestDurationMs, 50, {
			outcome: "success",
		});
		recorder.gauge(METRIC_NAMES.httpInflightRequests, 2, {
			transport: "mcp",
		});

		expect(recorder.snapshot()).toEqual([
			{
				kind: "counter",
				name: METRIC_NAMES.httpRequestsTotal,
				value: 1,
				labels: { route_group: "mcp" },
				timestampMs: 123,
			},
			{
				kind: "histogram",
				name: METRIC_NAMES.httpRequestDurationMs,
				value: 50,
				labels: { outcome: "success" },
				timestampMs: 123,
			},
			{
				kind: "gauge",
				name: METRIC_NAMES.httpInflightRequests,
				value: 2,
				labels: { transport: "mcp" },
				timestampMs: 123,
			},
		]);

		await recorder.flush();
		await recorder.flush();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(flushSpy).toHaveBeenCalledTimes(1);
		expect(flushSpy).toHaveBeenCalledWith({
			observations: recorder.snapshot(),
			resourceAttributes: { "service.name": "thoughtspot-mcp-server" },
		});
	});

	it("schedules the flush with waitUntil when an execution context is provided", async () => {
		const flushSpy = vi.fn().mockResolvedValue(undefined);
		const waitUntil = vi.fn();
		const recorder = new RequestMetricsRecorder({
			sink: { flush: flushSpy },
		});

		recorder.count(METRIC_NAMES.httpRequestsTotal);
		const flushPromise = recorder.flush({ waitUntil } as ExecutionContext);

		expect(waitUntil).toHaveBeenCalledTimes(1);
		expect(waitUntil).toHaveBeenCalledWith(flushPromise);
		await flushPromise;
		expect(flushSpy).toHaveBeenCalledTimes(1);
	});

	it("does not emit observations for the wrong metric kind", () => {
		const recorder = new RequestMetricsRecorder({
			sink: { flush: vi.fn().mockResolvedValue(undefined) },
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		recorder.histogram(METRIC_NAMES.httpRequestsTotal, 10);

		expect(recorder.snapshot()).toEqual([]);
		expect(warnSpy).toHaveBeenCalledOnce();
	});

	it("swallows sink flush failures", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const recorder = new RequestMetricsRecorder({
			sink: {
				flush: vi.fn().mockRejectedValue(new Error("flush failed")),
			},
		});

		recorder.count(METRIC_NAMES.httpRequestsTotal);

		await expect(recorder.flush()).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalled();
	});

	it("rejects new metrics once a flush has started", async () => {
		let resolveFlush!: () => void;
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const flushSpy = vi.fn().mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveFlush = resolve;
				}),
		);
		const recorder = new RequestMetricsRecorder({
			sink: { flush: flushSpy },
		});

		recorder.count(METRIC_NAMES.httpRequestsTotal);
		const flushPromise = recorder.flush();
		recorder.histogram(METRIC_NAMES.httpRequestDurationMs, 25);

		expect(recorder.snapshot()).toHaveLength(1);
		expect(warnSpy).toHaveBeenCalledWith(
			`[metrics] Ignoring metric recorded after flush: ${METRIC_NAMES.httpRequestDurationMs}`,
		);

		resolveFlush();
		await flushPromise;

		expect(flushSpy).toHaveBeenCalledWith({
			observations: [
				expect.objectContaining({
					name: METRIC_NAMES.httpRequestsTotal,
					kind: "counter",
				}),
			],
			resourceAttributes: {},
		});
	});

	it("ignores metrics recorded after the recorder has been flushed", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const flushSpy = vi.fn().mockResolvedValue(undefined);
		const recorder = new RequestMetricsRecorder({
			sink: { flush: flushSpy },
		});

		recorder.count(METRIC_NAMES.httpRequestsTotal);
		await recorder.flush();
		recorder.count(METRIC_NAMES.httpRequestsTotal, 5);

		expect(flushSpy).toHaveBeenCalledTimes(1);
		expect(recorder.snapshot()).toHaveLength(1);
		expect(warnSpy).toHaveBeenCalledWith(
			`[metrics] Ignoring metric recorded after flush: ${METRIC_NAMES.httpRequestsTotal}`,
		);
	});

	it("ignores non-finite metric values", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const recorder = new RequestMetricsRecorder({
			sink: { flush: vi.fn().mockResolvedValue(undefined) },
		});

		recorder.histogram(METRIC_NAMES.httpRequestDurationMs, Number.NaN);
		recorder.gauge(METRIC_NAMES.httpInflightRequests, Number.POSITIVE_INFINITY);

		expect(recorder.snapshot()).toEqual([]);
		expect(warnSpy).toHaveBeenCalledTimes(2);
	});

	it("does not flush empty observations but still closes the recorder", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const flushSpy = vi.fn().mockResolvedValue(undefined);
		const recorder = new RequestMetricsRecorder({
			sink: { flush: flushSpy },
		});

		await recorder.flush();
		recorder.count(METRIC_NAMES.httpRequestsTotal);

		expect(flushSpy).not.toHaveBeenCalled();
		expect(recorder.snapshot()).toEqual([]);
		expect(warnSpy).toHaveBeenCalledWith(
			`[metrics] Ignoring metric recorded after flush: ${METRIC_NAMES.httpRequestsTotal}`,
		);
	});
});
