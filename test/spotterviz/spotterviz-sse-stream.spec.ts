import { beforeEach, describe, expect, it, vi } from "vitest";
import { processAuroraSseStream } from "../../src/spotterviz/spotterviz-sse-stream";
import type {
	AuroraSessionContext,
	SpotterVizEvent,
} from "../../src/spotterviz/types";
import type { StorageServiceClient } from "../../src/storage-service/storage-service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONVERSATION_ID = "conv-abc";

type StorageMock = StorageServiceClient & {
	appendEvents: ReturnType<typeof vi.fn>;
	updateMetadata: ReturnType<typeof vi.fn>;
};

function makeStorageMock(): StorageMock {
	return {
		appendEvents: vi.fn().mockResolvedValue(undefined),
		updateMetadata: vi.fn().mockResolvedValue({}),
	} as unknown as StorageMock;
}

/**
 * Build a reader that yields a fixed sequence of UTF-8 chunks, then signals done.
 * Each chunk is delivered as a separate `read()` resolution so we can exercise
 * the buffer-across-chunks logic in `processAuroraSseStream`.
 */
function makeReader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
	const encoder = new TextEncoder();
	const queue = [...chunks];
	return {
		read: vi.fn(async () => {
			if (queue.length === 0) {
				return {
					done: true,
					value: undefined,
				} as ReadableStreamReadResult<Uint8Array>;
			}
			const next = queue.shift() as string;
			return {
				done: false,
				value: encoder.encode(next),
			} as ReadableStreamReadResult<Uint8Array>;
		}),
		releaseLock: vi.fn(),
		cancel: vi.fn(),
		closed: Promise.resolve(undefined),
	} as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

/** Build a reader whose first `read()` throws. */
function makeThrowingReader(
	err: Error,
): ReadableStreamDefaultReader<Uint8Array> {
	return {
		read: vi.fn().mockRejectedValue(err),
		releaseLock: vi.fn(),
		cancel: vi.fn(),
		closed: Promise.resolve(undefined),
	} as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

const sseFrame = (eventType: string, data: unknown): string =>
	`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processAuroraSseStream", () => {
	let storage: StorageMock;

	beforeEach(() => {
		storage = makeStorageMock();
	});

	it("parses a single SSE frame and appends it to storage; marks done when the stream closes", async () => {
		const reader = makeReader([
			sseFrame("text.delta", {
				event_type: "text.delta",
				data: { text: "Hello" },
				message_id: "m-1",
				idx: 0,
				timestamp: "2024-01-01T00:00:00Z",
			}),
		]);

		await processAuroraSseStream(CONVERSATION_ID, reader, storage);

		expect(storage.appendEvents).toHaveBeenCalledTimes(2);
		const firstCall = storage.appendEvents.mock.calls[0];
		expect(firstCall[0]).toBe(CONVERSATION_ID);
		const events = firstCall[1] as SpotterVizEvent[];
		expect(events).toHaveLength(1);
		expect(events[0].event_type).toBe("text.delta");
		expect(events[0].data).toEqual({ text: "Hello" });
		expect(events[0].message_id).toBe("m-1");
		expect(events[0].idx).toBe(0);
		expect(events[0].timestamp).toBe("2024-01-01T00:00:00Z");
		expect(firstCall[2]).toBeFalsy();

		const closingCall = storage.appendEvents.mock.calls[1];
		expect(closingCall[1]).toEqual([]);
		expect(closingCall[2]).toBe(true);
	});

	it("parses multiple frames batched in one chunk and appends them in order", async () => {
		const reader = makeReader([
			sseFrame("a", { data: { i: 1 } }) +
				sseFrame("b", { data: { i: 2 } }) +
				sseFrame("c", { data: { i: 3 } }),
		]);

		await processAuroraSseStream(CONVERSATION_ID, reader, storage);

		const events = storage.appendEvents.mock.calls[0][1] as SpotterVizEvent[];
		expect(events.map((e) => e.event_type)).toEqual(["a", "b", "c"]);
	});

	it("buffers partial frames split across chunks until a frame boundary arrives", async () => {
		const frame = sseFrame("text.delta", { data: { text: "Hello world" } });
		const split = Math.floor(frame.length / 2);

		const reader = makeReader([frame.slice(0, split), frame.slice(split)]);

		await processAuroraSseStream(CONVERSATION_ID, reader, storage);

		const events = storage.appendEvents.mock.calls[0][1] as SpotterVizEvent[];
		expect(events).toHaveLength(1);
		expect(events[0].event_type).toBe("text.delta");
		expect(events[0].data).toEqual({ text: "Hello world" });
	});

	it("ignores SSE comments and blank frames (heartbeats)", async () => {
		const reader = makeReader([
			`: keepalive\n\n${sseFrame("a", { data: { i: 1 } })}\n\n`,
		]);

		await processAuroraSseStream(CONVERSATION_ID, reader, storage);

		const events = storage.appendEvents.mock.calls[0][1] as SpotterVizEvent[];
		expect(events).toHaveLength(1);
		expect(events[0].event_type).toBe("a");
	});

	it("drops frames whose data payload is unparseable JSON but keeps streaming", async () => {
		const malformedFrame = "event: bad\ndata: not-json-{}\n\n";
		const goodFrame = sseFrame("good", { data: { ok: true } });

		const reader = makeReader([malformedFrame + goodFrame]);

		await processAuroraSseStream(CONVERSATION_ID, reader, storage);

		// Only the good frame should have been appended.
		expect(storage.appendEvents).toHaveBeenCalledTimes(2);
		const events = storage.appendEvents.mock.calls[0][1] as SpotterVizEvent[];
		expect(events).toHaveLength(1);
		expect(events[0].event_type).toBe("good");
	});

	it("falls back to the data payload's event_type when SSE 'event:' header is missing", async () => {
		// No `event:` line — only `data:`. event_type should fall back to data.event_type.
		const reader = makeReader([
			'data: {"event_type":"inferred","data":{"x":1}}\n\n',
		]);

		await processAuroraSseStream(CONVERSATION_ID, reader, storage);

		const events = storage.appendEvents.mock.calls[0][1] as SpotterVizEvent[];
		expect(events).toHaveLength(1);
		expect(events[0].event_type).toBe("inferred");
	});

	it("falls back to 'unknown' when neither SSE header nor payload provides event_type", async () => {
		const reader = makeReader(['data: {"data":{"x":1}}\n\n']);

		await processAuroraSseStream(CONVERSATION_ID, reader, storage);

		const events = storage.appendEvents.mock.calls[0][1] as SpotterVizEvent[];
		expect(events[0].event_type).toBe("unknown");
	});

	it("patches AuroraSessionContext.generationNumber on control.action lb_refresh frames", async () => {
		const reader = makeReader([
			sseFrame("control.action", {
				data: {
					action: "lb_refresh",
					metadata: { new_gen_number: 42 },
				},
			}),
		]);

		await processAuroraSseStream(CONVERSATION_ID, reader, storage);

		expect(storage.updateMetadata).toHaveBeenCalledTimes(1);
		const [convId, patch] = storage.updateMetadata.mock.calls[0] as [
			string,
			Partial<AuroraSessionContext>,
		];
		expect(convId).toBe(CONVERSATION_ID);
		// Numeric new_gen_number must be coerced to string to match BACH session shape.
		expect(patch.generationNumber).toBe("42");
	});

	it("does not patch generationNumber for control.action of a different kind", async () => {
		const reader = makeReader([
			sseFrame("control.action", {
				data: { action: "something_else", metadata: { new_gen_number: 9 } },
			}),
		]);

		await processAuroraSseStream(CONVERSATION_ID, reader, storage);

		expect(storage.updateMetadata).not.toHaveBeenCalled();
	});

	it("does not patch when lb_refresh metadata lacks new_gen_number", async () => {
		const reader = makeReader([
			sseFrame("control.action", {
				data: { action: "lb_refresh", metadata: {} },
			}),
		]);

		await processAuroraSseStream(CONVERSATION_ID, reader, storage);

		expect(storage.updateMetadata).not.toHaveBeenCalled();
	});

	it("swallows errors from updateMetadata so a failing patch does not abort the stream", async () => {
		storage.updateMetadata.mockRejectedValueOnce(new Error("patch failed"));
		const reader = makeReader([
			sseFrame("control.action", {
				data: { action: "lb_refresh", metadata: { new_gen_number: 5 } },
			}) + sseFrame("text.delta", { data: { text: "still flowing" } }),
		]);

		await expect(
			processAuroraSseStream(CONVERSATION_ID, reader, storage),
		).resolves.toBeUndefined();

		// Events still appended despite the patch error.
		const events = storage.appendEvents.mock.calls[0][1] as SpotterVizEvent[];
		expect(events.map((e) => e.event_type)).toEqual([
			"control.action",
			"text.delta",
		]);
		// And the stream-close marker still fires.
		const last = storage.appendEvents.mock.calls.at(-1);
		expect(last?.[2]).toBe(true);
	});

	it("marks the conversation done with isDone=true on a clean stream close even when no frames were sent", async () => {
		const reader = makeReader([]);

		await processAuroraSseStream(CONVERSATION_ID, reader, storage);

		// Only the closing call.
		expect(storage.appendEvents).toHaveBeenCalledTimes(1);
		expect(storage.appendEvents.mock.calls[0]).toEqual([
			CONVERSATION_ID,
			[],
			true,
		]);
	});

	it("on a reader read() error, marks the conversation done as a best-effort", async () => {
		const reader = makeThrowingReader(new Error("network blew up"));

		await expect(
			processAuroraSseStream(CONVERSATION_ID, reader, storage),
		).resolves.toBeUndefined();

		expect(storage.appendEvents).toHaveBeenCalledWith(
			CONVERSATION_ID,
			[],
			true,
		);
	});

	it("swallows the secondary error if marking-done itself fails after a stream error", async () => {
		const reader = makeThrowingReader(new Error("stream error"));
		storage.appendEvents.mockRejectedValue(new Error("mark-done failed"));

		await expect(
			processAuroraSseStream(CONVERSATION_ID, reader, storage),
		).resolves.toBeUndefined();
	});

	it("does not append an empty-events batch between frames (only the stream-close marker)", async () => {
		// One frame, then a heartbeat-only chunk, then close.
		const reader = makeReader([
			sseFrame("a", { data: { i: 1 } }),
			": heartbeat\n\n",
		]);

		await processAuroraSseStream(CONVERSATION_ID, reader, storage);

		// First call has the real event; second is the close (no third empty-events batch).
		expect(storage.appendEvents).toHaveBeenCalledTimes(2);
		expect(
			(storage.appendEvents.mock.calls[0][1] as SpotterVizEvent[]).length,
		).toBe(1);
		expect(storage.appendEvents.mock.calls[1]).toEqual([
			CONVERSATION_ID,
			[],
			true,
		]);
	});
});
