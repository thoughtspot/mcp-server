/**
 * Lumos SSE stream consumer for the Spotter Model flow, plus the text heuristics it relies on.
 *
 * Runs in the background after send_model_message returns: it normalizes upstream events into
 * ModelUpdates and writes them to a sink (the Durable Object store, in production) which the
 * updates long-poll drains. It always marks the turn done, so a poller can never hang forever.
 */

import { MRD_MARKERS } from "./spotter-model-constants";
import type {
	ModelSessionState,
	ModelStreamSink,
	ModelUpdate,
} from "./spotter-model-types";

/**
 * Advance the tracked generation to the latest the server reports (coerced from string, forward
 * only so a stray lower value can't clobber state) and accumulate it into genNoWorkingSet. Sent as
 * generation_no on the next edit so the save pins against the live generation, not the stale
 * gen-1 baseline (which silently wiped earlier turns' tables).
 */
export function advanceGeneration(
	session: { generationNo: number; genNoWorkingSet?: number[] },
	raw: unknown,
): void {
	const next = Number(raw);
	if (!Number.isFinite(next)) {
		return;
	}
	if (next > session.generationNo) {
		session.generationNo = next;
	}
	// Accumulate this edit generation into the working set the SAVE request needs.
	if (session.genNoWorkingSet && !session.genNoWorkingSet.includes(next)) {
		session.genNoWorkingSet.push(next);
		session.genNoWorkingSet.sort((a, b) => a - b);
	}
}

// Does this turn's text read like an MRD? Require ≥2 markers so ordinary narration mentioning one
// word isn't misclassified. Only consulted on turns that didn't advance the generation.
export function looksLikeMrd(text: string): boolean {
	if (!text) return false;
	return MRD_MARKERS.filter((m) => m.test(text)).length >= 2;
}

// Slice the plan from the first "Goal" heading to the tool-call scaffolding (`<br>**INPUT**…`)
// after it. Falls back to the full trimmed text if the markers aren't found, so we never drop it.
export function extractMrdPlan(text: string): string {
	const start = text.search(/\*{0,2}\s*Goal\s*\*{0,2}\s*:/i);
	if (start === -1) {
		return text.trim();
	}
	const rest = text.slice(start);
	// Cut trailing tool-call scaffolding that follows the plan (e.g. "<br>**INPUT** …").
	const end = rest.search(/<br\s*\/?>\s*\*{0,2}\s*INPUT\b/i);
	return (end === -1 ? rest : rest.slice(0, end)).trim();
}

// Strip `**INPUT**…**OUTPUT**` tool-call scaffolding and <br> tags from a non-planning turn's
// text, collapsing blank lines. Returns "" when nothing meaningful is left (caller emits no text).
export function cleanTurnText(text: string): string {
	return text
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(
			/\*{0,2}\s*INPUT\s*\*{0,2}[\s\S]*?\*{0,2}\s*OUTPUT\s*\*{0,2}/gi,
			"",
		)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Parse Lumos SSE into normalized updates and flush them to the sink: immediately on structural
 * events (choice/model_state/todo/action/notification/message_end/error), otherwise buffered.
 * Scalar state (generation/pendingChoice) is persisted on change; raw MESSAGE_DELTA text is emitted
 * once at MESSAGE_END (cleaned, or as `mrd`). Catches its own errors and always marks the turn done.
 */
export async function consumeModelStream({
	response,
	modelSessionId,
	session,
	sink,
}: {
	response: Response;
	modelSessionId: string;
	session: ModelSessionState;
	sink: ModelStreamSink;
}): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	const pending: ModelUpdate[] = [];
	let scalarDirty = false;
	// Set when the turn's MESSAGE_END arrives — the authoritative end-of-turn signal.
	let ended = false;
	// Accumulate the turn's text and the starting generation so MESSAGE_END can recognize a
	// planning (MRD) turn — a plan that stopped for approval without advancing the model.
	let turnText = "";
	const turnStartGen = session.generationNo;

	const flush = async (isDone = false): Promise<void> => {
		// Disjoint keys on the same DO, so fire both writes concurrently rather than sequentially.
		const writes: Promise<unknown>[] = [];
		// Keep scalarDirty set until the write RESOLVES, so a failed putSession stays pending and the
		// next flush (including the error path's final one) retries it. Clearing it up front loses the
		// generation advance and its genNoWorkingSet entry, which then under-pins the save.
		const sessionWriteScheduled = scalarDirty;
		if (scalarDirty) {
			writes.push(sink.putSession(session));
		}
		if (pending.length > 0 || isDone) {
			const batch = pending.splice(0, pending.length);
			writes.push(sink.appendUpdates(batch, { isDone }));
		}
		if (writes.length > 0) {
			await Promise.all(writes);
		}
		if (sessionWriteScheduled) {
			scalarDirty = false;
		}
	};

	// Parse one SSE block, push its normalized update, and report whether to flush now.
	const handleBlock = (block: string): boolean => {
		const lines = block.split("\n");
		const eventLine = lines.find((l) => l.startsWith("event:"));
		const dataLine = lines.find((l) => l.startsWith("data:"));
		if (!dataLine) return false;
		const eventType = (eventLine?.slice("event:".length) ?? "").trim();
		let data: any;
		try {
			data = JSON.parse(dataLine.slice("data:".length).trim());
		} catch {
			return false;
		}
		switch (eventType) {
			case "MESSAGE_DELTA":
				// Accumulate silently (deltas carry chain-of-thought/scaffolding);
				// emit one cleaned text or mrd at MESSAGE_END.
				if (data.message_delta?.content) {
					turnText += data.message_delta.content;
				}
				return false;
			case "NOTIFICATION":
				if (data.notification?.title) {
					pending.push({
						type: "notification",
						text: data.notification.title,
					});
				}
				return true;
			case "META_CHOICE": {
				// Remember the inner choice so send_model_message can echo it back with the user's
				// selection applied (the builder sends no choice_id to bind against).
				const metaChoice = data.meta_choice ?? {};
				if (metaChoice.choice && typeof metaChoice.choice === "object") {
					session.pendingChoice = metaChoice.choice;
				}
				// The sibling META_MODEL_STATE carries this as snake_case generation_no on the wire, so
				// accept either casing here rather than depending on which one this event uses.
				advanceGeneration(
					session,
					metaChoice.generation_no ?? metaChoice.generationNo,
				);
				scalarDirty = true;
				pending.push({ type: "choice", choice: metaChoice });
				return true;
			}
			case "META_MODEL_STATE": {
				const genRaw =
					data.meta_model_state?.generation_no ??
					data.meta_model_state?.generationNo;
				advanceGeneration(session, genRaw);
				scalarDirty = true;
				pending.push({
					type: "model_state",
					generation_no: session.generationNo,
				});
				return true;
			}
			case "META_ERROR":
				pending.push({
					type: "text",
					text: `Error: ${data.meta_error?.error_response?.message ?? "unknown"}`,
				});
				return true;
			case "META_TODO": {
				// Auto-build progress tracker: tasks (e.g. Tables/Joins/Columns) with statuses
				// (PENDING/IN_PROGRESS/COMPLETED) and descriptions that fill in with results.
				const tasks = data.meta_todo?.tasks;
				if (Array.isArray(tasks)) {
					pending.push({ type: "todo", tasks });
				}
				return true;
			}
			case "META_ACTION": {
				// Suggested next actions (e.g. "Create Joins", "Select Columns") — not required.
				const actions = data.meta_action?.actions;
				if (Array.isArray(actions)) {
					pending.push({ type: "action", actions });
				}
				return true;
			}
			case "MESSAGE_END": {
				// Authoritative end-of-turn marker; message_end.status is e.g. "completed".
				ended = true;
				// Planning turn (plan streamed, generation didn't advance): surface as a distinct
				// `mrd` update so the client presents it for approval, not as a built model.
				const built = session.generationNo > turnStartGen;
				if (!built && looksLikeMrd(turnText)) {
					pending.push({ type: "mrd", text: extractMrdPlan(turnText) });
				} else {
					const cleaned = cleanTurnText(turnText);
					if (cleaned) {
						pending.push({ type: "text", text: cleaned });
					}
				}
				pending.push({
					type: "message_end",
					status: String(data.message_end?.status ?? "completed"),
				});
				return true;
			}
			default:
				// MESSAGE_START and any unrecognized event: no user-facing payload.
				return false;
		}
	};

	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		reader = response.body?.getReader();
		if (!reader) {
			throw new Error("Failed to get reader from model stream response");
		}
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx: number;
			// biome-ignore lint: sequential block extraction
			while ((idx = buffer.indexOf("\n\n")) !== -1) {
				const block = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				if (block.trim() && handleBlock(block)) await flush();
			}
			// MESSAGE_END is the authoritative end of the turn; stop reading even if the
			// upstream connection lingers, so is_done is set promptly.
			if (ended) break;
		}
		if (!ended && buffer.trim()) handleBlock(buffer);
		// Final flush marks the turn done so pollers stop.
		await flush(true);
	} catch (error) {
		// The caller already returned, so surface failures into the update stream and always
		// mark the turn done — otherwise the updates poll would never finish.
		console.error(
			`Error consuming model stream for session ${modelSessionId}:`,
			(error as Error).message,
		);
		pending.push({
			type: "text",
			text: `Error: ${(error as Error).message}`,
		});
		try {
			await flush(true);
		} catch (flushError) {
			console.error(
				`Failed to persist final model updates for session ${modelSessionId}:`,
				(flushError as Error).message,
			);
		}
	} finally {
		// MESSAGE_END breaks the read loop while the upstream connection may still be open, so
		// release it explicitly instead of leaving one SSE body dangling per turn.
		await reader?.cancel().catch(() => {});
	}
}
