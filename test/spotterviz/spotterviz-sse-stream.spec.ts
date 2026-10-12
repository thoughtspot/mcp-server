import { afterEach, describe, expect, it, vi } from "vitest";
import {
	generationFromEvent,
	readAuroraStream,
} from "../../src/spotterviz/spotterviz-sse-stream";
import type { SpotterVizEvent } from "../../src/spotterviz/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ReaderMock = ReadableStreamDefaultReader<Uint8Array> & {
	read: ReturnType<typeof vi.fn>;
	cancel: ReturnType<typeof vi.fn>;
};

/**
 * Build a reader that yields a fixed sequence of UTF-8 chunks. After the last chunk it either
 * signals done (`close: true`) or never resolves again (simulating a socket held open).
 */
function makeReader(chunks: string[], close = true): ReaderMock {
	const encoder = new TextEncoder();
	const queue = [...chunks];
	return {
		read: vi.fn(() => {
			if (queue.length === 0) {
				return close
					? Promise.resolve({ done: true, value: undefined })
					: new Promise(() => {});
			}
			const next = queue.shift() as string;
			return Promise.resolve({ done: false, value: encoder.encode(next) });
		}),
		cancel: vi.fn().mockResolvedValue(undefined),
		releaseLock: vi.fn(),
		closed: Promise.resolve(undefined),
	} as unknown as ReaderMock;
}

function frame(eventType: string, data: Record<string, unknown> = {}): string {
	return `event: ${eventType}\ndata: ${JSON.stringify({ event_type: eventType, data })}\n\n`;
}

function collect() {
	const batches: SpotterVizEvent[][] = [];
	const onEvents = vi.fn(async (events: SpotterVizEvent[]) => {
		batches.push(events);
	});
	return { batches, onEvents };
}

const IDLE_MS = 1_000;

// ---------------------------------------------------------------------------
// readAuroraStream
// ---------------------------------------------------------------------------

describe("readAuroraStream", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns message_end on the terminal event without waiting for the socket to close", async () => {
		const reader = makeReader(
			[frame("text.delta", { text: "hi" }), frame("message.end")],
			false,
		);
		const { batches, onEvents } = collect();

		const end = await readAuroraStream(reader, onEvents, IDLE_MS);

		expect(end).toBe("message_end");
		expect(batches.flat().map((e) => e.event_type)).toEqual([
			"text.delta",
			"message.end",
		]);
		expect(reader.cancel).toHaveBeenCalled();
	});

	it("returns closed when the socket closes before message.end", async () => {
		const reader = makeReader([frame("text.delta", { text: "hi" })]);
		const { batches, onEvents } = collect();

		const end = await readAuroraStream(reader, onEvents, IDLE_MS);

		expect(end).toBe("closed");
		expect(batches.flat()).toHaveLength(1);
		expect(reader.cancel).toHaveBeenCalled();
	});

	it("flushes a trailing frame that arrives without a blank line before close", async () => {
		const reader = makeReader([
			'event: text.delta\ndata: {"data":{"text":"last"}}',
		]);
		const { batches, onEvents } = collect();

		const end = await readAuroraStream(reader, onEvents, IDLE_MS);

		expect(end).toBe("closed");
		expect(batches).toEqual([
			[
				expect.objectContaining({
					event_type: "text.delta",
					data: { text: "last" },
				}),
			],
		]);
	});

	it("returns idle when no bytes arrive within idleMs and cancels the reader", async () => {
		vi.useFakeTimers();
		const reader = makeReader([frame("text.delta", { text: "hi" })], false);
		const { batches, onEvents } = collect();

		const pending = readAuroraStream(reader, onEvents, IDLE_MS);
		await vi.advanceTimersByTimeAsync(IDLE_MS);

		await expect(pending).resolves.toBe("idle");
		expect(batches.flat()).toHaveLength(1);
		expect(reader.cancel).toHaveBeenCalled();
	});

	it("buffers partial frames split across chunks", async () => {
		const full = frame("text.delta", { text: "split" });
		const reader = makeReader([full.slice(0, 10), full.slice(10)]);
		const { batches, onEvents } = collect();

		await readAuroraStream(reader, onEvents, IDLE_MS);

		expect(batches).toEqual([
			[
				expect.objectContaining({
					event_type: "text.delta",
					data: { text: "split" },
				}),
			],
		]);
	});

	it("skips comments, blank frames and unparseable data", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const reader = makeReader([
			": heartbeat\n\n",
			"event: text.delta\ndata: {not json\n\n",
			frame("text.delta", { text: "ok" }),
		]);
		const { batches, onEvents } = collect();

		await readAuroraStream(reader, onEvents, IDLE_MS);

		expect(batches.flat().map((e) => e.data)).toEqual([{ text: "ok" }]);
	});

	it("skips frames whose data is not an object instead of failing the turn", async () => {
		const reader = makeReader([
			"event: text.delta\ndata: null\n\n",
			"event: text.delta\ndata: 42\n\n",
			frame("text.delta", { text: "ok" }),
		]);
		const { batches, onEvents } = collect();

		const end = await readAuroraStream(reader, onEvents, IDLE_MS);

		expect(end).toBe("closed");
		expect(batches.flat().map((e) => e.data)).toEqual([{ text: "ok" }]);
	});

	it("reports keepalive-only chunks as activity without emitting events", async () => {
		const reader = makeReader([": keepalive\n\n", ": keepalive\n\n"]);
		const { onEvents } = collect();
		const onBytes = vi.fn(async () => {});

		const end = await readAuroraStream(reader, onEvents, IDLE_MS, onBytes);

		expect(end).toBe("closed");
		expect(onBytes).toHaveBeenCalledTimes(2);
		expect(onEvents).not.toHaveBeenCalled();
	});

	it("falls back to the payload's event_type, then 'unknown'", async () => {
		const reader = makeReader([
			'data: {"event_type":"from.payload","data":{}}\n\n',
			'data: {"data":{}}\n\n',
		]);
		const { batches, onEvents } = collect();

		await readAuroraStream(reader, onEvents, IDLE_MS);

		expect(batches.flat().map((e) => e.event_type)).toEqual([
			"from.payload",
			"unknown",
		]);
	});
});

// ---------------------------------------------------------------------------
// generationFromEvent
// ---------------------------------------------------------------------------

describe("generationFromEvent", () => {
	it("returns the new generation from an lb_refresh control action as a string", () => {
		expect(
			generationFromEvent({
				event_type: "control.action",
				data: { action: "lb_refresh", metadata: { new_gen_number: 7 } },
			}),
		).toBe("7");
	});

	it("ignores other control actions", () => {
		expect(
			generationFromEvent({
				event_type: "control.action",
				data: { action: "other", metadata: { new_gen_number: 7 } },
			}),
		).toBeUndefined();
	});

	it("ignores lb_refresh without new_gen_number", () => {
		expect(
			generationFromEvent({
				event_type: "control.action",
				data: { action: "lb_refresh", metadata: {} },
			}),
		).toBeUndefined();
	});

	it("ignores non-control events", () => {
		expect(
			generationFromEvent({
				event_type: "text.delta",
				data: { action: "lb_refresh", metadata: { new_gen_number: 7 } },
			}),
		).toBeUndefined();
	});
});
