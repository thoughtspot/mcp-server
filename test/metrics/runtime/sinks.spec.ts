import { describe, expect, it, vi } from "vitest";
import { CompositeMetricsSink } from "../../../src/metrics/runtime/composite-sink";
import { NoopMetricsSink } from "../../../src/metrics/runtime/noop-sink";

describe("runtime sinks", () => {
	it("flushes every sink in the composite", async () => {
		const payload = { observations: [], resourceAttributes: {} };
		const firstSink = { flush: vi.fn().mockResolvedValue(undefined) };
		const secondSink = { flush: vi.fn().mockResolvedValue(undefined) };
		const sink = new CompositeMetricsSink([firstSink, secondSink]);

		await expect(sink.flush(payload)).resolves.toBeUndefined();

		expect(firstSink.flush).toHaveBeenCalledWith(payload);
		expect(secondSink.flush).toHaveBeenCalledWith(payload);
	});

	it("logs rejected sinks but still resolves the composite flush", async () => {
		const payload = { observations: [], resourceAttributes: {} };
		const failure = new Error("grafana unavailable");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const sink = new CompositeMetricsSink([
			{ flush: vi.fn().mockRejectedValue(failure) },
			{ flush: vi.fn().mockResolvedValue(undefined) },
		]);

		await expect(sink.flush(payload)).resolves.toBeUndefined();

		expect(errorSpy).toHaveBeenCalledWith(
			"[metrics] Sink at index 0 failed during flush",
			failure,
		);
	});

	it("treats the noop sink as a successful no-op", async () => {
		const sink = new NoopMetricsSink();

		await expect(
			sink.flush({ observations: [], resourceAttributes: {} }),
		).resolves.toBeUndefined();
	});
});
