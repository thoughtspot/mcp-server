import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { withSpan } from "../metrics/tracing/tracing-utils";
import type { StorageServiceClient } from "../storage-service/storage-service";
import type { AuroraSessionContext, SpotterVizEvent } from "./types";

/**
 * Drain an Aurora `/aurora/chat/stream` SSE response into the conversation storage DO.
 *
 * Wire format: each SSE frame is `event: <type>\ndata: <json>\n\n`. We keep the event_type alongside
 * the parsed data so the get_updates tool can project into the user-facing shape without re-parsing.
 *
 * Lifecycle: mirroring the spotter streaming pattern, the conversation is marked done only when
 * the HTTP stream itself closes — never on in-band terminal events like `message.end`. Trailing
 * frames from Aurora's SSE keepalive layer are simply appended like any other event.
 *
 * Side effect: when a `control.action` of `action: "lb_refresh"` carries a `new_gen_number`, the
 * stored AuroraSessionContext.generationNumber is patched so the next turn addresses the right
 * BACH state.
 */
export const processAuroraSseStream = async (
	conversationId: string,
	reader: ReadableStreamDefaultReader<Uint8Array>,
	storage: StorageServiceClient,
): Promise<void> => {
	return await withSpan("process-spotterviz-sse-stream", async (span: Span) => {
		span.setAttribute("conversation_id", conversationId);

		let nEvents = 0;
		let nGenNumberUpdates = 0;
		let spanHasError = false;

		try {
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					await storage.appendEvents(conversationId, [], true);
					break;
				}

				buffer += decoder.decode(value, { stream: true });

				// SSE frames are separated by a blank line. Anything after the last `\n\n` is a
				// partial frame; keep it in the buffer for the next loop.
				const lastBoundary = buffer.lastIndexOf("\n\n");
				if (lastBoundary === -1) {
					continue;
				}
				const completeFrames = buffer.slice(0, lastBoundary);
				buffer = buffer.slice(lastBoundary + 2);

				const newEvents: SpotterVizEvent[] = [];
				let genNumberPatch: string | undefined;

				for (const rawFrame of completeFrames.split("\n\n")) {
					const frame = rawFrame.trim();
					if (!frame || frame.startsWith(":")) {
						// Blank or SSE comment (e.g. heartbeats).
						continue;
					}

					const parsed = parseSseFrame(frame);
					if (!parsed) {
						continue;
					}

					newEvents.push(parsed);
					nEvents++;

					if (parsed.event_type === "meta.error") {
						spanHasError = true;
						const msg =
							(parsed.data?.message as string | undefined) ?? "unknown error";
						span.setStatus({
							code: SpanStatusCode.ERROR,
							message: `Aurora meta.error: ${msg}`,
						});
					} else if (parsed.event_type === "control.action") {
						const action = parsed.data?.action;
						const metadata = parsed.data?.metadata as
							| Record<string, unknown>
							| undefined;
						if (action === "lb_refresh" && metadata?.new_gen_number != null) {
							// Aurora emits new_gen_number as an int; we keep it as a string to match
							// the rest of the BACH session shape in AuroraSessionContext.
							genNumberPatch = String(metadata.new_gen_number);
						}
					}
				}

				if (genNumberPatch !== undefined) {
					try {
						await storage.updateMetadata<AuroraSessionContext>(conversationId, {
							generationNumber: genNumberPatch,
						});
						nGenNumberUpdates++;
					} catch (err) {
						console.error(
							`Failed to patch generationNumber for ${conversationId}:`,
							err,
						);
					}
				}

				if (newEvents.length > 0) {
					await storage.appendEvents(conversationId, newEvents);
				}
			}
		} catch (error) {
			console.error(
				`Error processing Aurora SSE stream for ${conversationId}:`,
				error,
			);
			spanHasError = true;
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error instanceof Error ? error.message : String(error),
			});
			// Best-effort: mark the conversation done so get_updates doesn't hang on a turn that
			// will never produce more events.
			try {
				await storage.appendEvents(conversationId, [], true);
			} catch (markErr) {
				console.error(
					`Failed to mark conversation ${conversationId} done after stream error:`,
					markErr,
				);
			}
		}

		span.setAttributes({
			total_events_parsed: nEvents,
			gen_number_updates: nGenNumberUpdates,
		});
		if (!spanHasError) {
			span.setStatus({
				code: SpanStatusCode.OK,
				message: "Aurora SSE stream concluded",
			});
		}
	});
};

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
