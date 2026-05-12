import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { METRIC_NAMES } from "../../../src/metrics/runtime/metric-types";
import {
	getToolMetricOutcomeFromError,
	getToolMetricOutcomeFromResult,
	recordToolInvocationMetrics,
	recordUpstreamCallMetrics,
	recordUpstreamStreamMessageMetric,
	recordUpstreamStreamStartedMetric,
} from "../../../src/metrics/runtime/tool-metrics";
import { McpServerError } from "../../../src/utils";

function makeRecorder() {
	return { count: vi.fn(), histogram: vi.fn() };
}

describe("getToolMetricOutcomeFromResult", () => {
	it("returns error when result has isError === true", () => {
		expect(getToolMetricOutcomeFromResult({ isError: true })).toBe("error");
	});

	it("returns success when isError is false", () => {
		expect(getToolMetricOutcomeFromResult({ isError: false })).toBe("success");
	});

	it("returns success when result is a plain string", () => {
		expect(getToolMetricOutcomeFromResult("ok")).toBe("success");
	});

	it("returns success when result is null", () => {
		expect(getToolMetricOutcomeFromResult(null)).toBe("success");
	});

	it("returns success when result is an object without isError", () => {
		expect(getToolMetricOutcomeFromResult({ data: 42 })).toBe("success");
	});
});

describe("getToolMetricOutcomeFromError", () => {
	it("returns validation_error for ZodError", () => {
		const err = new ZodError([]);
		expect(getToolMetricOutcomeFromError(err)).toBe("validation_error");
	});

	it("returns client_error for McpServerError with 4xx status", () => {
		const err = new McpServerError("bad request", 400);
		expect(getToolMetricOutcomeFromError(err)).toBe("client_error");
	});

	it("returns client_error for McpServerError with status 499", () => {
		const err = new McpServerError("unauthorized", 499);
		expect(getToolMetricOutcomeFromError(err)).toBe("client_error");
	});

	it("returns error for McpServerError with 5xx status", () => {
		const err = new McpServerError("server error", 500);
		expect(getToolMetricOutcomeFromError(err)).toBe("error");
	});

	it("returns error for unknown error types", () => {
		expect(getToolMetricOutcomeFromError(new Error("boom"))).toBe("error");
		expect(getToolMetricOutcomeFromError("string error")).toBe("error");
		expect(getToolMetricOutcomeFromError(null)).toBe("error");
	});
});

describe("recordToolInvocationMetrics", () => {
	it("records count and histogram with minimal labels", () => {
		const recorder = makeRecorder();
		recordToolInvocationMetrics(recorder, "my_tool", "mcp", "success", 123);

		expect(recorder.count).toHaveBeenCalledWith(
			METRIC_NAMES.toolCallsTotal,
			1,
			expect.objectContaining({ tool_name: "my_tool", outcome: "success" }),
		);
		expect(recorder.histogram).toHaveBeenCalledWith(
			METRIC_NAMES.toolDurationMs,
			123,
			expect.objectContaining({ tool_name: "my_tool" }),
		);
	});

	it("includes optional label fields when provided", () => {
		const recorder = makeRecorder();
		recordToolInvocationMetrics(
			recorder,
			"my_tool",
			"mcp",
			"error",
			50,
			"v2",
			"exact",
			"2025-01-01",
		);

		const labels = recorder.count.mock.calls[0][2];
		expect(labels.api_version).toBe("v2");
		expect(labels.api_version_mode).toBe("exact");
		expect(labels.api_release_date).toBe("2025-01-01");
	});

	it("omits optional label fields when not provided", () => {
		const recorder = makeRecorder();
		recordToolInvocationMetrics(recorder, "t", "mcp", "success", 1);

		const labels = recorder.count.mock.calls[0][2];
		expect(labels).not.toHaveProperty("api_version");
		expect(labels).not.toHaveProperty("api_version_mode");
		expect(labels).not.toHaveProperty("api_release_date");
	});
});

describe("recordUpstreamCallMetrics", () => {
	it("does nothing when recorder is undefined", () => {
		// should not throw
		recordUpstreamCallMetrics(undefined, "get_session_info", "success", 10);
	});

	it("records count and histogram when recorder is provided", () => {
		const recorder = makeRecorder();
		recordUpstreamCallMetrics(recorder, "single_answer", "error", 200);

		expect(recorder.count).toHaveBeenCalledWith(
			METRIC_NAMES.upstreamCallsTotal,
			1,
			{ upstream_operation: "single_answer", outcome: "error" },
		);
		expect(recorder.histogram).toHaveBeenCalledWith(
			METRIC_NAMES.upstreamDurationMs,
			200,
			{ upstream_operation: "single_answer", outcome: "error" },
		);
	});
});

describe("recordUpstreamStreamStartedMetric", () => {
	it("does nothing when recorder is undefined", () => {
		recordUpstreamStreamStartedMetric(undefined, "search_metadata", "success");
	});

	it("records count when recorder is provided", () => {
		const recorder = makeRecorder();
		recordUpstreamStreamStartedMetric(recorder, "search_metadata", "success");

		expect(recorder.count).toHaveBeenCalledWith(
			METRIC_NAMES.upstreamStreamsStartedTotal,
			1,
			{ upstream_operation: "search_metadata", outcome: "success" },
		);
	});
});

describe("recordUpstreamStreamMessageMetric", () => {
	it("does nothing when recorder is undefined", () => {
		recordUpstreamStreamMessageMetric(
			undefined,
			"single_answer",
			"text",
			false,
		);
	});

	it("records count with all labels when recorder is provided", () => {
		const recorder = makeRecorder();
		recordUpstreamStreamMessageMetric(
			recorder,
			"single_answer",
			"text_chunk",
			true,
		);

		expect(recorder.count).toHaveBeenCalledWith(
			METRIC_NAMES.upstreamStreamMessagesTotal,
			1,
			{
				upstream_operation: "single_answer",
				message_type: "text_chunk",
				is_thinking: true,
			},
		);
	});
});
