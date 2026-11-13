import { getActiveSpan } from "../metrics/tracing/tracing-utils";

// Condense a verbose upstream error into one user-facing line: ThoughtSpot's
// external message when present, else a generic status line — dropping the
// internal debug/stacktrace blob that a raw 500 body carries.
export function summarizeUpstreamError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const status = raw.match(/status (\d{3})/)?.[1];
	const generic = status
		? `ThoughtSpot returned an error (status ${status})`
		: raw;
	const jsonAt = raw.indexOf("{");
	if (jsonAt === -1) {
		return generic;
	}
	try {
		const msg = JSON.parse(raw.slice(jsonAt))?.error?.message;
		const external =
			msg && typeof msg === "object" ? msg.errorMessageExternal : msg;
		return typeof external === "string" && external.trim()
			? external.trim().replace(/\s+/g, " ")
			: generic;
	} catch {
		return generic;
	}
}

// Tag the span with the condensed upstream error; returns it plus a
// low-cardinality status so Honeycomb splits upstream vs our own failures.
export function recordGetDataFailure(
	error: unknown,
	status: number | undefined,
	label = "get_data",
): { summary: string; statusMessage: string } {
	const summary = summarizeUpstreamError(error);
	getActiveSpan()?.setAttributes({
		...(status ? { upstream_status: status } : {}),
		upstream_error: summary,
	});
	let kind = "internal error";
	if (status) {
		kind = `upstream error (status ${status})`;
	} else if (/timed out/i.test(summary)) {
		kind = "upstream timeout";
	}
	return { summary, statusMessage: `${label} ${kind}` };
}
