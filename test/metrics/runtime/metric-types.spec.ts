import { describe, expect, it, vi } from "vitest";
import {
	METRIC_NAMES,
	getMetricKind,
	normalizeMetricLabels,
} from "../../../src/metrics/runtime/metric-types";

describe("metric-types", () => {
	it("returns the configured metric kind for known metrics", () => {
		expect(getMetricKind(METRIC_NAMES.httpRequestsTotal)).toBe("counter");
		expect(getMetricKind(METRIC_NAMES.httpRequestDurationMs)).toBe("histogram");
		expect(getMetricKind(METRIC_NAMES.httpInflightRequests)).toBe("gauge");
	});

	it("normalizes labels and drops forbidden or unknown keys", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const labels = normalizeMetricLabels({
			route_group: "mcp",
			outcome: "success",
			instanceUrl: "https://tenant.thoughtspot.cloud",
			unexpected_key: "value",
			tool_name: undefined,
		});

		expect(labels).toEqual({
			outcome: "success",
			route_group: "mcp",
		});
		expect(warnSpy).toHaveBeenCalledTimes(2);
	});
});
