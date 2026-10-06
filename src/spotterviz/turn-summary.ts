/**
 * Derives a single, agent-facing outcome from an Aurora SSE event log.
 *
 * The wire protocol makes several distinct outcomes look alike, so this is deliberately explicit
 * about which signal means what:
 *
 * - `message.end.data.status` is the authoritative turn outcome ("completed" | "error").
 * - `message.end.data.liveboard_updated` only reports whether a `control.action`/`lb_refresh`
 *   fired, i.e. whether Aurora actually published. On Aurora's error path it is hardcoded false,
 *   so `false` alone cannot distinguish "nothing to do" from "failed after publishing".
 * - Aurora is prompted to behave as a collaborative assistant and to ask rather than infer
 *   (notably it refuses to pick a data source on its own). A clarifying question therefore
 *   arrives as a perfectly successful turn that changed nothing, plus assistant text. Reporting
 *   that as success would tell the calling agent the dashboard was built when it was not, so it
 *   is surfaced as its own `needs_input` outcome.
 *
 * Events are consumed destructively from the storage DO (each delivered exactly once), so a turn
 * observed across several polls must be accumulated as it goes. `TurnProgress` is that carry-over
 * state: derived and bounded, rather than the raw event list, which would not stay within a DO
 * value limit on a long turn.
 */

import type { SpotterVizEvent } from "./types";

export type TurnStatus = "completed" | "needs_input" | "failed";

export interface TurnChoice {
	text: string;
	allowMultiple: boolean;
	choices: string[];
}

/** Carry-over state for a turn observed across multiple polls. Safe to store in DO metadata. */
export interface TurnProgress extends Record<string, unknown> {
	text: string;
	steps: string[];
	/**
	 * Total events observed so far. Reported while a turn is still running as a liveness signal:
	 * without it, a caller cannot tell a slow turn from a dead one, since early events are all
	 * in-flight progress that produces no completed milestones.
	 */
	eventCount: number;
	/** True once any `lb_refresh` has been seen, i.e. Aurora published. */
	sawRefresh: boolean;
	/** First error message seen, if any. */
	error?: string;
	/** `message.end.data.status`, once the terminal event has arrived. */
	endStatus?: string;
	/** `message.end.data.liveboard_updated`, once the terminal event has arrived. */
	endLiveboardUpdated?: boolean;
	choice?: TurnChoice;
}

export interface TurnSummary {
	status: TurnStatus;
	/** True when Aurora published at least once during the turn. */
	liveboardUpdated: boolean;
	/** Assistant prose for the turn, concatenated in event order. */
	text: string;
	/** Present when status is "needs_input": what Aurora is asking for. */
	question?: string;
	/** Present when Aurora offered an explicit picker alongside its question. */
	choice?: TurnChoice;
	/** Present when status is "failed". */
	error?: string;
	/** Human-readable progress headings, in order, describing what was done. */
	steps: string[];
}

// Aurora prefixes some deltas with a machine-readable generation-number comment; it is metadata
// for the UI, not prose meant for a person.
const GEN_NO_COMMENT = /<!--\s*gen_no:\s*[^>]*-->/g;

/** Keeps accumulated prose inside a DO value limit on a long or chatty turn. */
const MAX_TEXT_CHARS = 8_000;
const MAX_STEPS = 100;

export const EMPTY_TURN_PROGRESS: TurnProgress = {
	text: "",
	steps: [],
	eventCount: 0,
	sawRefresh: false,
};

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function extractChoice(data: Record<string, unknown>): TurnChoice | undefined {
	const choices = data.choices;
	if (!Array.isArray(choices) || choices.length === 0) return undefined;
	return {
		text: typeof data.text === "string" ? data.text : "",
		allowMultiple: data.allow_multiple === true,
		choices: choices.map((choice) =>
			typeof choice === "string" ? choice : JSON.stringify(choice),
		),
	};
}

/**
 * Fold a freshly drained batch of events into the running progress for a turn.
 */
export function accumulateProgress(
	prior: TurnProgress | undefined,
	events: SpotterVizEvent[],
): TurnProgress {
	const next: TurnProgress = {
		text: prior?.text ?? "",
		steps: [...(prior?.steps ?? [])],
		eventCount: (prior?.eventCount ?? 0) + events.length,
		sawRefresh: prior?.sawRefresh ?? false,
		error: prior?.error,
		endStatus: prior?.endStatus,
		endLiveboardUpdated: prior?.endLiveboardUpdated,
		choice: prior?.choice,
	};

	for (const event of events) {
		const data = asRecord(event.data);

		switch (event.event_type) {
			case "message.delta": {
				// Assistant prose arrives as `content` (TextDelta) or `text` (ChoiceDelta).
				const chunk = data.content ?? data.text;
				if (typeof chunk === "string" && chunk.length > 0) {
					next.text = (next.text + chunk).slice(0, MAX_TEXT_CHARS);
				}
				next.choice = next.choice ?? extractChoice(data);
				break;
			}
			case "meta.progress": {
				// Keep completed, non-ephemeral milestones only, and drop consecutive repeats:
				// Aurora emits the same heading for the started and completed halves of a step.
				const heading = event.heading;
				if (
					typeof heading === "string" &&
					heading.length > 0 &&
					data.stage === "completed" &&
					next.steps[next.steps.length - 1] !== heading &&
					next.steps.length < MAX_STEPS
				) {
					next.steps.push(heading);
				}
				break;
			}
			case "control.action": {
				// Aurora can publish more than once per turn; any lb_refresh means the liveboard moved.
				if (data.action === "lb_refresh") {
					next.sawRefresh = true;
				}
				break;
			}
			case "meta.error": {
				if (!next.error && typeof data.message === "string") {
					next.error = data.message;
				}
				// An error event with no usable message still marks the turn as failed.
				next.error = next.error ?? "The dashboard agent stopped with an error.";
				break;
			}
			case "message.end": {
				if (typeof data.status === "string") {
					next.endStatus = data.status;
				}
				next.endLiveboardUpdated = data.liveboard_updated === true;
				break;
			}
			default:
				break;
		}
	}

	return next;
}

/**
 * Decide the outcome of a finished turn from its accumulated progress.
 */
export function summarizeProgress(progress: TurnProgress): TurnSummary {
	const text = progress.text.replace(GEN_NO_COMMENT, "").trim();
	const steps = progress.steps;
	const liveboardUpdated =
		progress.sawRefresh || progress.endLiveboardUpdated === true;

	if (progress.error || progress.endStatus === "error") {
		return {
			status: "failed",
			liveboardUpdated,
			text,
			steps,
			error: progress.error ?? "The dashboard agent stopped with an error.",
		};
	}

	// The turn ran cleanly but changed nothing. If Aurora said something, it is asking us for
	// something; treat it as a question rather than reporting a success that did not happen.
	if (!liveboardUpdated && (text.length > 0 || progress.choice)) {
		return {
			status: "needs_input",
			liveboardUpdated: false,
			text,
			steps,
			question: text.length > 0 ? text : progress.choice?.text,
			choice: progress.choice,
		};
	}

	// Nothing published and nothing said. Observed on large requests: the designer works for
	// several minutes, then closes the stream having created nothing, with no error event. There
	// is no sense in which that succeeded, so do not let it read as success to a calling agent.
	if (!liveboardUpdated) {
		return {
			status: "failed",
			liveboardUpdated: false,
			text,
			steps,
			error:
				"The dashboard designer finished without making any changes and without saying why. This has been seen on large requests; try again with fewer charts, or split the request into a smaller create followed by modifications.",
		};
	}

	return { status: "completed", liveboardUpdated, text, steps };
}

/**
 * Reduce a complete Aurora event log to one outcome. Pure: safe to unit test against recorded logs.
 */
export function summarizeTurn(events: SpotterVizEvent[]): TurnSummary {
	return summarizeProgress(accumulateProgress(undefined, events));
}
