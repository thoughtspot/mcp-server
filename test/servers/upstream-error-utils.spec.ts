import { context, trace } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	recordGetDataFailure,
	summarizeUpstreamError,
} from "../../src/servers/upstream-error-utils";

// The shared OTEL mock span (test/setup.ts).
const span = () => trace.getSpan(context.active()) as any;

describe("summarizeUpstreamError", () => {
	it("returns the external message from a JSON error body", () => {
		const err = new Error(
			'getData failed with status 500: {"error":{"message":{"errorMessageExternal":"query  failed"}}}',
		);
		expect(summarizeUpstreamError(err)).toBe("query failed");
	});

	it("falls back to a generic status line when the body has no message", () => {
		const err = new Error("getData failed with status 502: <html>");
		expect(summarizeUpstreamError(err)).toBe(
			"ThoughtSpot returned an error (status 502)",
		);
	});
});

describe("recordGetDataFailure", () => {
	beforeEach(() => vi.clearAllMocks());

	it("tags an upstream error with its status", () => {
		const result = recordGetDataFailure(
			new Error("getData failed with status 503: down"),
			503,
		);
		expect(result.statusMessage).toBe("get_data upstream error (status 503)");
		expect(span().setAttributes).toHaveBeenCalledWith({
			upstream_status: 503,
			upstream_error: "ThoughtSpot returned an error (status 503)",
		});
	});

	it("labels a timeout as an upstream timeout", () => {
		const result = recordGetDataFailure(
			new Error("getData timed out after 30s waiting for ThoughtSpot"),
			undefined,
		);
		expect(result.statusMessage).toBe("get_data upstream timeout");
	});

	it("labels anything else as an internal error, with the given label", () => {
		const result = recordGetDataFailure(new Error("boom"), undefined, "x");
		expect(result).toEqual({
			summary: "boom",
			statusMessage: "x internal error",
		});
		expect(span().setAttributes).toHaveBeenCalledWith({
			upstream_error: "boom",
		});
	});
});
