import { describe, expect, it, vi } from "vitest";
import {
	advanceGeneration,
	cleanTurnText,
	consumeModelStream,
	extractMrdPlan,
	looksLikeMrd,
} from "../../../src/thoughtspot/spotter-model/spotter-model-stream";
import type {
	ModelSessionState,
	ModelStreamSink,
	ModelUpdate,
} from "../../../src/thoughtspot/spotter-model/spotter-model-types";

// Build an SSE Response from pre-formed chunks. Each chunk is delivered as its own read(), so a
// chunk boundary is also a place the consumer re-checks whether the turn ended.
function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(body);
}

function event(type: string, data: unknown): string {
	return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeSink() {
	const updates: ModelUpdate[] = [];
	const sessionWrites: ModelSessionState[] = [];
	const state = { isDone: false };
	const sink: ModelStreamSink = {
		putSession: async (session) => {
			// Snapshot, since the consumer keeps mutating the live object.
			sessionWrites.push(JSON.parse(JSON.stringify(session)));
		},
		appendUpdates: async (batch, opts) => {
			updates.push(...batch);
			if (opts.isDone) state.isDone = true;
		},
	};
	return { sink, updates, sessionWrites, state };
}

function newSession(
	overrides: Partial<ModelSessionState> = {},
): ModelSessionState {
	return {
		transactionId: "txn-1",
		generationNo: 1,
		genNoWorkingSet: [],
		...overrides,
	};
}

describe("advanceGeneration", () => {
	it("coerces string generations to numbers", () => {
		const session = newSession();
		advanceGeneration(session, "3");
		expect(session.generationNo).toBe(3);
		expect(session.genNoWorkingSet).toEqual([3]);
	});

	it("only moves forward", () => {
		const session = newSession({ generationNo: 5 });
		advanceGeneration(session, 2);
		expect(session.generationNo).toBe(5);
		// The lower generation still joins the working set — the save needs every generation.
		expect(session.genNoWorkingSet).toEqual([2]);
	});

	it("ignores non-numeric values", () => {
		const session = newSession();
		advanceGeneration(session, undefined);
		advanceGeneration(session, "not-a-number");
		expect(session.generationNo).toBe(1);
		expect(session.genNoWorkingSet).toEqual([]);
	});

	it("accumulates a sorted, de-duplicated working set", () => {
		const session = newSession();
		advanceGeneration(session, 4);
		advanceGeneration(session, 2);
		advanceGeneration(session, 4);
		advanceGeneration(session, 3);
		expect(session.genNoWorkingSet).toEqual([2, 3, 4]);
		expect(session.generationNo).toBe(4);
	});
});

describe("looksLikeMrd", () => {
	it("requires at least two markers", () => {
		expect(looksLikeMrd("")).toBe(false);
		expect(looksLikeMrd("Here are some metrics for you")).toBe(false);
		expect(looksLikeMrd("Goal: track revenue\nKey Entities: orders")).toBe(
			true,
		);
	});

	it("ignores the section words in ordinary prose", () => {
		// Two bare words used to be enough, so a non-building turn that merely talked about the data
		// was tagged as a plan and stopped for an approval the user never needed to give.
		expect(looksLikeMrd("The goal is to track sales metrics for you")).toBe(
			false,
		);
		expect(looksLikeMrd("I can add dimensions and metrics to this model")).toBe(
			false,
		);
	});

	it("still matches the section words when they are headings", () => {
		expect(looksLikeMrd("Metrics: revenue\nDimensions: city")).toBe(true);
		expect(looksLikeMrd("**Goal:** grow revenue\n**Metrics**: bookings")).toBe(
			true,
		);
	});

	it("matches a realistic plan", () => {
		const plan =
			"**Model Requirements**\nGoal: analyse occupancy\nKey Entities: listings\nMetrics: revenue\nDimensions: city";
		expect(looksLikeMrd(plan)).toBe(true);
	});
});

describe("extractMrdPlan", () => {
	it("slices from the Goal heading to the tool-call scaffolding", () => {
		const text =
			"thinking about this...<br>**Goal**: track revenue<br>Metrics: total revenue<br>**INPUT** {tool call}";
		expect(extractMrdPlan(text)).toBe(
			"**Goal**: track revenue<br>Metrics: total revenue",
		);
	});

	it("keeps everything after Goal when there is no scaffolding", () => {
		expect(extractMrdPlan("preamble Goal: x\nMetrics: y")).toBe(
			"Goal: x\nMetrics: y",
		);
	});

	it("falls back to the full text when no Goal heading exists", () => {
		expect(extractMrdPlan("  Key Entities: orders  ")).toBe(
			"Key Entities: orders",
		);
	});
});

describe("cleanTurnText", () => {
	it("strips INPUT/OUTPUT scaffolding", () => {
		expect(cleanTurnText("Built the model. **INPUT** {call} **OUTPUT**")).toBe(
			"Built the model.",
		);
	});

	// The pattern spans INPUT→OUTPUT only, so a tool's result payload printed after
	// **OUTPUT** survives. Documented here because it is the common leak shape.
	it("keeps text that follows the OUTPUT marker", () => {
		expect(
			cleanTurnText(
				"Built the model. **INPUT** {call} **OUTPUT** {result} Done.",
			),
		).toBe("Built the model.  {result} Done.");
	});

	it("converts <br> to newlines and collapses blank runs", () => {
		expect(cleanTurnText("a<br><br><br><br>b")).toBe("a\n\nb");
	});

	it("returns an empty string when only scaffolding remains", () => {
		expect(cleanTurnText("**INPUT** x **OUTPUT**")).toBe("");
		expect(cleanTurnText("   ")).toBe("");
	});
});

describe("consumeModelStream", () => {
	it("normalizes a build turn and marks it done", async () => {
		const session = newSession();
		const { sink, updates, state } = makeSink();

		await consumeModelStream({
			response: sseResponse([
				event("MESSAGE_START", {}),
				event("META_TODO", {
					meta_todo: {
						tasks: [{ id: "1", title: "Tables", status: "PENDING" }],
					},
				}),
				event("META_MODEL_STATE", { meta_model_state: { generation_no: "2" } }),
				event("NOTIFICATION", { notification: { title: "Adding joins" } }),
				event("MESSAGE_DELTA", {
					message_delta: { content: "Built the model." },
				}),
				event("META_ACTION", {
					meta_action: { actions: [{ name: "Create Joins" }] },
				}),
				event("MESSAGE_END", { message_end: { status: "completed" } }),
			]),
			modelSessionId: "session-1",
			session,
			sink,
		});

		expect(updates.map((u) => u.type)).toEqual([
			"todo",
			"model_state",
			"notification",
			"action",
			"text",
			"message_end",
		]);
		expect(updates.find((u) => u.type === "text")?.text).toBe(
			"Built the model.",
		);
		expect(updates.find((u) => u.type === "message_end")?.status).toBe(
			"completed",
		);
		expect(session.generationNo).toBe(2);
		expect(session.genNoWorkingSet).toEqual([2]);
		expect(state.isDone).toBe(true);
	});

	it("never emits raw text_chunk updates while streaming deltas", async () => {
		const { sink, updates } = makeSink();
		await consumeModelStream({
			response: sseResponse([
				event("MESSAGE_DELTA", { message_delta: { content: "chain " } }),
				event("MESSAGE_DELTA", { message_delta: { content: "of thought" } }),
				event("MESSAGE_END", { message_end: { status: "completed" } }),
			]),
			modelSessionId: "session-1",
			session: newSession(),
			sink,
		});
		expect(updates.some((u) => u.type === "text_chunk")).toBe(false);
		// The two deltas are concatenated into one cleaned text update.
		expect(updates.filter((u) => u.type === "text")).toHaveLength(1);
		expect(updates[0].text).toBe("chain of thought");
	});

	it("tags a planning turn as mrd when the generation did not advance", async () => {
		const { sink, updates } = makeSink();
		await consumeModelStream({
			response: sseResponse([
				event("MESSAGE_DELTA", {
					message_delta: {
						content:
							"Let me think.<br>**Goal**: analyse revenue<br>Key Entities: orders<br>**INPUT** {}",
					},
				}),
				event("MESSAGE_END", { message_end: { status: "completed" } }),
			]),
			modelSessionId: "session-1",
			session: newSession(),
			sink,
		});

		const mrd = updates.find((u) => u.type === "mrd");
		expect(mrd).toBeDefined();
		expect(mrd?.text).toBe("**Goal**: analyse revenue<br>Key Entities: orders");
		// A plan is not a built model, so no plain text update duplicates it.
		expect(updates.some((u) => u.type === "text")).toBe(false);
	});

	it("does not tag prose mentioning the section words as mrd", async () => {
		const { sink, updates } = makeSink();
		await consumeModelStream({
			response: sseResponse([
				event("MESSAGE_DELTA", {
					message_delta: {
						content:
							"The goal is to track sales metrics, so which tables should I use?",
					},
				}),
				event("MESSAGE_END", { message_end: { status: "completed" } }),
			]),
			modelSessionId: "session-1",
			// Generation does NOT advance, so the structural gate alone would not save us here.
			session: newSession(),
			sink,
		});

		expect(updates.some((u) => u.type === "mrd")).toBe(false);
		expect(updates.some((u) => u.type === "text")).toBe(true);
	});

	it("does not tag MRD-looking text on a turn that advanced the generation", async () => {
		const { sink, updates } = makeSink();
		await consumeModelStream({
			response: sseResponse([
				event("META_MODEL_STATE", { meta_model_state: { generationNo: "2" } }),
				event("MESSAGE_DELTA", {
					message_delta: { content: "Goal: revenue. Key Entities: orders." },
				}),
				event("MESSAGE_END", { message_end: {} }),
			]),
			modelSessionId: "session-1",
			session: newSession(),
			sink,
		});
		expect(updates.some((u) => u.type === "mrd")).toBe(false);
		expect(updates.some((u) => u.type === "text")).toBe(true);
		// Missing status defaults to "completed".
		expect(updates.find((u) => u.type === "message_end")?.status).toBe(
			"completed",
		);
	});

	it("stores a pending choice and persists scalar state", async () => {
		const session = newSession();
		const { sink, updates, sessionWrites } = makeSink();
		const choice = {
			title: "Which fact table?",
			choice_options: [{ table_option: { id: "1", is_selected: false } }],
		};

		await consumeModelStream({
			response: sseResponse([
				event("META_CHOICE", {
					meta_choice: { choice, generationNo: "2" },
				}),
				event("MESSAGE_END", { message_end: { status: "completed" } }),
			]),
			modelSessionId: "session-1",
			session,
			sink,
		});

		expect(session.pendingChoice).toEqual(choice);
		expect(sessionWrites.at(-1)?.pendingChoice).toEqual(choice);
		expect(updates.find((u) => u.type === "choice")).toBeDefined();
	});

	it("ignores a META_CHOICE without an inner choice object", async () => {
		const session = newSession();
		const { sink, updates } = makeSink();
		await consumeModelStream({
			response: sseResponse([
				event("META_CHOICE", { meta_choice: { generationNo: "2" } }),
				event("MESSAGE_END", { message_end: {} }),
			]),
			modelSessionId: "session-1",
			session,
			sink,
		});
		expect(session.pendingChoice).toBeUndefined();
		expect(updates.some((u) => u.type === "choice")).toBe(true);
	});

	it("surfaces upstream errors as a text update", async () => {
		const { sink, updates } = makeSink();
		await consumeModelStream({
			response: sseResponse([
				event("META_ERROR", {
					meta_error: { error_response: { message: "boom" } },
				}),
				event("MESSAGE_END", { message_end: {} }),
			]),
			modelSessionId: "session-1",
			session: newSession(),
			sink,
		});
		expect(updates[0]).toEqual({ type: "text", text: "Error: boom" });
	});

	it("labels an error with no message as unknown", async () => {
		const { sink, updates } = makeSink();
		await consumeModelStream({
			response: sseResponse([
				event("META_ERROR", {}),
				event("MESSAGE_END", { message_end: {} }),
			]),
			modelSessionId: "session-1",
			session: newSession(),
			sink,
		});
		expect(updates[0].text).toBe("Error: unknown");
	});

	it("skips malformed blocks, blocks without data and unknown events", async () => {
		const { sink, updates, state } = makeSink();
		await consumeModelStream({
			response: sseResponse([
				"event: MESSAGE_DELTA\n\n", // no data line
				"event: NOTIFICATION\ndata: {not json}\n\n",
				event("SOMETHING_NEW", { whatever: true }),
				event("META_TODO", { meta_todo: { tasks: "not-an-array" } }),
				event("NOTIFICATION", { notification: {} }), // no title
				event("MESSAGE_END", { message_end: { status: "completed" } }),
			]),
			modelSessionId: "session-1",
			session: newSession(),
			sink,
		});
		expect(updates.map((u) => u.type)).toEqual(["message_end"]);
		expect(state.isDone).toBe(true);
	});

	it("stops reading after MESSAGE_END", async () => {
		const { sink, updates } = makeSink();
		await consumeModelStream({
			response: sseResponse([
				event("MESSAGE_END", { message_end: { status: "completed" } }),
				// Separate chunk: never read, because the turn already ended.
				event("NOTIFICATION", { notification: { title: "too late" } }),
			]),
			modelSessionId: "session-1",
			session: newSession(),
			sink,
		});
		expect(updates.some((u) => u.text === "too late")).toBe(false);
	});

	it("parses a trailing block that never got its blank-line terminator", async () => {
		const { sink, updates } = makeSink();
		await consumeModelStream({
			response: sseResponse([
				'event: NOTIFICATION\ndata: {"notification":{"title":"partial"}}',
			]),
			modelSessionId: "session-1",
			session: newSession(),
			sink,
		});
		expect(updates.find((u) => u.type === "notification")?.text).toBe(
			"partial",
		);
	});

	it("marks the turn done and reports the failure when the body is unreadable", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const { sink, updates, state } = makeSink();

		await consumeModelStream({
			response: new Response(null),
			modelSessionId: "session-1",
			session: newSession(),
			sink,
		});

		expect(updates[0].type).toBe("text");
		expect(String(updates[0].text)).toContain("Failed to get reader");
		expect(state.isDone).toBe(true);
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("does not throw when the final flush also fails", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const sink: ModelStreamSink = {
			putSession: async () => {},
			appendUpdates: async () => {
				throw new Error("storage down");
			},
		};

		await expect(
			consumeModelStream({
				response: new Response(null),
				modelSessionId: "session-1",
				session: newSession(),
				sink,
			}),
		).resolves.toBeUndefined();
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});
});
