import type { SpotterVizEvent } from "./types";

/** Why a stream read stopped. */
export type StreamEnd = "message_end" | "closed" | "idle";

/**
 * Read an Aurora `/aurora/chat/stream` SSE body and hand each batch of parsed events to
 * `onEvents`.
 *
 * Wire format: each SSE frame is `event: <type>\ndata: <json>\n\n`.
 *
 * The read stops at the first of:
 * - `message.end`, Aurora's terminal event for the turn. Aurora can hold the socket open after it
 *   (keepalive layer), so waiting for the close alone can leave a finished turn looking stuck.
 * - the socket closing.
 * - `idleMs` with no bytes at all (not even keepalives), which means Aurora has stalled. The caller decides what that
 *   means for the turn; this function only cancels the read.
 */
export async function readAuroraStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	onEvents: (events: SpotterVizEvent[]) => Promise<void>,
	idleMs: number,
	onBytes?: () => Promise<void>,
): Promise<StreamEnd> {
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const idle = new Promise<"idle">((resolve) => {
				timer = setTimeout(() => resolve("idle"), idleMs);
			});
			const result = await Promise.race([reader.read(), idle]);
			clearTimeout(timer);

			if (result === "idle") {
				return "idle";
			}
			if (result.done) {
				// Flush a final frame that arrived without a trailing blank line.
				const events = parseFrames(`${buffer}\n\n`).events;
				if (events.length > 0) {
					await onEvents(events);
				}
				return "closed";
			}

			buffer += decoder.decode(result.value, { stream: true });
			// Any bytes, keepalive comments included, prove the turn is alive. Aurora sends a
			// keepalive every few seconds while a long tool call runs without emitting events.
			await onBytes?.();

			// SSE frames are separated by a blank line. Anything after the last `\n\n` is a partial
			// frame; keep it in the buffer for the next read.
			const lastBoundary = buffer.lastIndexOf("\n\n");
			if (lastBoundary === -1) {
				continue;
			}
			const { events, sawEnd } = parseFrames(buffer.slice(0, lastBoundary));
			buffer = buffer.slice(lastBoundary + 2);

			if (events.length > 0) {
				await onEvents(events);
			}
			if (sawEnd) {
				return "message_end";
			}
		}
	} finally {
		// Releases the upstream connection whichever way the read ended. Errors here only mean the
		// stream was already closed.
		reader.cancel().catch(() => {});
	}
}

function parseFrames(chunk: string): {
	events: SpotterVizEvent[];
	sawEnd: boolean;
} {
	const events: SpotterVizEvent[] = [];
	let sawEnd = false;
	for (const rawFrame of chunk.split("\n\n")) {
		const frame = rawFrame.trim();
		if (!frame || frame.startsWith(":")) {
			// Blank or SSE comment (e.g. heartbeats).
			continue;
		}
		const parsed = parseSseFrame(frame);
		if (!parsed) {
			continue;
		}
		events.push(parsed);
		if (parsed.event_type === "message.end") {
			sawEnd = true;
		}
	}
	return { events, sawEnd };
}

/**
 * The BACH generation an `lb_refresh` control event moves the liveboard to, if this event is one.
 * Aurora emits it as an int; it is kept as a string to match the rest of the BACH session shape.
 */
export function generationFromEvent(
	event: SpotterVizEvent,
): string | undefined {
	if (event.event_type !== "control.action") {
		return undefined;
	}
	const metadata = event.data?.metadata as Record<string, unknown> | undefined;
	if (event.data?.action === "lb_refresh" && metadata?.new_gen_number != null) {
		return String(metadata.new_gen_number);
	}
	return undefined;
}

/**
 * Parse a single SSE frame ("event: <type>\ndata: <json>\n[...]") into a `SpotterVizEvent`.
 * Returns `null` for frames we can't interpret (missing data field, malformed JSON, etc.) —
 * those are logged but don't abort the stream, since a single bad frame shouldn't kill the turn.
 */
function parseSseFrame(frame: string): SpotterVizEvent | null {
	let eventType: string | undefined;
	const dataLines: string[] = [];

	for (const line of frame.split("\n")) {
		if (line.startsWith("event:")) {
			eventType = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trim());
		}
		// Other SSE fields (id:, retry:) are not used by Aurora.
	}

	if (dataLines.length === 0) {
		return null;
	}

	const dataJson = dataLines.join("\n");
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(dataJson);
	} catch (err) {
		console.warn(
			`Aurora SSE frame had unparseable data (event=${eventType ?? "unknown"}):`,
			err,
		);
		return null;
	}
	// Aurora always sends an object; skip anything else rather than fail the whole turn.
	if (!parsed || typeof parsed !== "object") {
		return null;
	}

	// Aurora's BaseEvent already includes `event_type`; if the SSE `event:` field is missing,
	// fall back to whatever the data payload says.
	const inferredType =
		eventType ?? (parsed.event_type as string | undefined) ?? "unknown";

	return {
		event_type: inferredType,
		data: (parsed.data as Record<string, unknown>) ?? {},
		message_id: parsed.message_id as string | undefined,
		idx: parsed.idx as number | undefined,
		timestamp: parsed.timestamp as string | undefined,
		tool_id: parsed.tool_id as string | undefined,
		group_id: parsed.group_id as string | undefined,
		heading: parsed.heading as string | undefined,
	};
}
