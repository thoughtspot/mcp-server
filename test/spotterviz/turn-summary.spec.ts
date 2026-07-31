import { describe, expect, it } from "vitest";
import {
	accumulateProgress,
	summarizeProgress,
	summarizeTurn,
} from "../../src/spotterviz/turn-summary";
import type { SpotterVizEvent } from "../../src/spotterviz/types";

function event(
	event_type: string,
	data: Record<string, unknown>,
	extra: Partial<SpotterVizEvent> = {},
): SpotterVizEvent {
	return { event_type, data, ...extra };
}

const messageStart = event("message.start", {
	message: "",
	liveboard_id: "lb",
});

describe("summarizeTurn", () => {
	it("reports completed when the liveboard was published", () => {
		const result = summarizeTurn([
			messageStart,
			event("control.action", {
				action: "lb_refresh",
				metadata: { new_gen_number: 7 },
			}),
			event("message.end", { status: "completed", liveboard_updated: true }),
		]);

		expect(result.status).toBe("completed");
		expect(result.liveboardUpdated).toBe(true);
	});

	it("treats an lb_refresh as a publish even if message.end says otherwise", () => {
		// Aurora derives liveboard_updated itself; a refresh is the ground truth that it published.
		const result = summarizeTurn([
			event("control.action", { action: "lb_refresh", metadata: {} }),
			event("message.end", { status: "completed", liveboard_updated: false }),
		]);

		expect(result.status).toBe("completed");
		expect(result.liveboardUpdated).toBe(true);
	});

	it("reports needs_input when the turn succeeded but only produced a question", () => {
		// This is the important case: on the wire it is a perfectly successful turn. Reporting it
		// as success would tell the calling agent the dashboard was built when nothing happened.
		const result = summarizeTurn([
			messageStart,
			event("message.delta", {
				content: "Which data source should I use?",
				source: "llm",
			}),
			event("message.end", { status: "completed", liveboard_updated: false }),
		]);

		expect(result.status).toBe("needs_input");
		expect(result.question).toBe("Which data source should I use?");
		expect(result.liveboardUpdated).toBe(false);
	});

	it("captures offered choices alongside the question", () => {
		const result = summarizeTurn([
			event("message.delta", {
				text: "Pick a data source",
				choices: ["Sales", "Retail"],
				allow_multiple: false,
			}),
			event("message.end", { status: "completed", liveboard_updated: false }),
		]);

		expect(result.status).toBe("needs_input");
		expect(result.choice?.choices).toEqual(["Sales", "Retail"]);
		expect(result.choice?.allowMultiple).toBe(false);
	});

	it("reports failed on meta.error even when the turn also published", () => {
		const result = summarizeTurn([
			event("control.action", { action: "lb_refresh", metadata: {} }),
			event("meta.error", {
				message: "Something broke",
				error_type: "processing_error",
			}),
			event("message.end", { status: "error", liveboard_updated: false }),
		]);

		expect(result.status).toBe("failed");
		expect(result.error).toBe("Something broke");
		// Still surfaced, because a partially-published dashboard is a real state to report.
		expect(result.liveboardUpdated).toBe(true);
	});

	it("reports failed when message.end says error with no meta.error", () => {
		const result = summarizeTurn([
			event("message.end", { status: "error", liveboard_updated: false }),
		]);

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/stopped with an error/i);
	});

	it("reports failed when the turn published nothing and said nothing", () => {
		// Observed live on a large request: the designer works for minutes, then closes the stream
		// having created nothing, with no error event. Reporting that as completed would tell the
		// calling agent the dashboard was built.
		const result = summarizeTurn([
			messageStart,
			event("meta.progress", { stage: "completed" }, { heading: "Working" }),
			event("message.end", { status: "completed", liveboard_updated: false }),
		]);

		expect(result.status).toBe("failed");
		expect(result.liveboardUpdated).toBe(false);
		expect(result.error).toMatch(/without making any changes/i);
		// The steps it did get through are still worth reporting.
		expect(result.steps).toEqual(["Working"]);
	});

	it("only reports completed when something actually changed", () => {
		const result = summarizeTurn([
			messageStart,
			event("control.action", { action: "lb_refresh", metadata: {} }),
			event("message.end", { status: "completed", liveboard_updated: true }),
		]);

		expect(result.status).toBe("completed");
	});

	it("collects completed progress headings in order without duplicates", () => {
		const result = summarizeTurn([
			event(
				"meta.progress",
				{ stage: "working" },
				{ heading: "Understanding" },
			),
			event(
				"meta.progress",
				{ stage: "completed" },
				{ heading: "Understanding" },
			),
			event(
				"meta.progress",
				{ stage: "completed" },
				{ heading: "Understanding" },
			),
			event("meta.progress", { stage: "completed" }, { heading: "Publishing" }),
			event("message.end", { status: "completed", liveboard_updated: true }),
		]);

		expect(result.steps).toEqual(["Understanding", "Publishing"]);
	});

	it("strips the gen_no metadata comment out of assistant prose", () => {
		const result = summarizeTurn([
			event("message.delta", { content: "<!-- gen_no: 12 -->Need a source" }),
			event("message.end", { status: "completed", liveboard_updated: false }),
		]);

		expect(result.question).toBe("Need a source");
	});

	it("concatenates prose split across deltas", () => {
		const result = summarizeTurn([
			event("message.delta", { content: "Which " }),
			event("message.delta", { content: "source?" }),
			event("message.end", { status: "completed", liveboard_updated: false }),
		]);

		expect(result.question).toBe("Which source?");
	});
});

describe("accumulateProgress", () => {
	it("carries a question across polls that each drained part of the turn", () => {
		// Events are delivered exactly once by the storage DO, so a turn seen over several polls
		// must accumulate. Losing the early batch would turn a question into a silent no-op.
		const first = accumulateProgress(undefined, [
			messageStart,
			event("message.delta", { content: "Which data source" }),
		]);
		const second = accumulateProgress(first, [
			event("message.delta", { content: " should I use?" }),
			event("message.end", { status: "completed", liveboard_updated: false }),
		]);

		const result = summarizeProgress(second);
		expect(result.status).toBe("needs_input");
		expect(result.question).toBe("Which data source should I use?");
	});

	it("remembers a publish seen in an earlier batch", () => {
		const first = accumulateProgress(undefined, [
			event("control.action", { action: "lb_refresh", metadata: {} }),
		]);
		const second = accumulateProgress(first, [
			event("message.end", { status: "completed", liveboard_updated: false }),
		]);

		expect(summarizeProgress(second).liveboardUpdated).toBe(true);
	});

	it("bounds accumulated prose so it stays storable", () => {
		let progress = accumulateProgress(undefined, []);
		for (let i = 0; i < 50; i++) {
			progress = accumulateProgress(progress, [
				event("message.delta", { content: "x".repeat(500) }),
			]);
		}

		expect(progress.text.length).toBeLessThanOrEqual(8_000);
	});
});
