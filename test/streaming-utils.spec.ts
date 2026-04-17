import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processSendAgentConversationMessageStreamingResponse } from "../src/streaming-utils";

// Helper to build a ReadableStreamDefaultReader from an array of string chunks
function makeReader(chunks: string[]): ReadableStreamDefaultReader {
	let index = 0;
	return {
		read: vi.fn(async () => {
			if (index < chunks.length) {
				const value = new TextEncoder().encode(chunks[index++]);
				return { done: false, value };
			}
			return { done: true, value: undefined };
		}),
		cancel: vi.fn(),
		releaseLock: vi.fn(),
	} as unknown as ReadableStreamDefaultReader;
}

// Mock storage
function makeMockStorage() {
	return {
		appendMessagesAndRestartTtl: vi.fn(async () => {}),
	};
}

const INSTANCE_URL = "https://test.thoughtspot.com";
const CONV_ID = "conv-123";

describe("processSendAgentConversationMessageStreamingResponse", () => {
	let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("marks the conversation as done when the stream ends with no data", async () => {
		const storage = makeMockStorage();
		const reader = makeReader([]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
	});

	it("parses a text event and stores a text message", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text", content: "Hello world" }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ type: "text", text: "Hello world" },
		]);
		// Final done call
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
	});

	it("parses a text-chunk event and stores a text_chunk message", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text-chunk", content: "chunk content" }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ type: "text_chunk", text: "chunk content" },
		]);
	});

	it("parses an answer event and constructs the correct iframe URL", async () => {
		const storage = makeMockStorage();
		const metadata = {
			session_id: "sess-1",
			gen_no: 42,
			transaction_id: "txn-1",
			generation_number: 7,
			title: "My Answer",
			sage_query: "show sales",
		};
		const line = `data: ${JSON.stringify([{ type: "answer", metadata }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		const expectedIframeUrl = `${INSTANCE_URL}/?tsmcp=true#/embed/conv-assist-answer?sessionId=sess-1&genNo=42&acSessionId=txn-1&acGenNo=7`;
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{
				type: "answer",
				answer_id: JSON.stringify({ session_id: "sess-1", gen_no: 42 }),
				answer_title: "My Answer",
				answer_query: "show sales",
				iframe_url: expectedIframeUrl,
			},
		]);
	});

	it("parses an error event and stores a text message with the display_message", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "error", code: "ERR_001", message: "internal", display_message: "Something went wrong" }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ type: "text", text: "Something went wrong" },
		]);
	});

	it("falls back to 'Something went wrong' when error event has no display_message", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "error" }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ type: "text", text: "Something went wrong" },
		]);
	});

	it("ignores ack, notification, search_datasets, file, and conv_title events", async () => {
		const storage = makeMockStorage();
		const ignoredTypes = [
			"ack",
			"notification",
			"search_datasets",
			"file",
			"conv_title",
		];
		const items = ignoredTypes.map((type) => ({ type }));
		const line = `data: ${JSON.stringify(items)}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		// Only the terminal done call should have been made (no messages stored)
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
	});

	it("ignores blank lines and heartbeat lines", async () => {
		const storage = makeMockStorage();
		// Blank line and heartbeat, then a real message
		const chunk = `\n: heartbeat\ndata: ${JSON.stringify([{ type: "text", content: "hi" }])}\n`;
		const reader = makeReader([chunk]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ type: "text", text: "hi" },
		]);
	});

	it("warns and skips lines that don't start with 'data:'", async () => {
		const storage = makeMockStorage();
		const chunk = "unexpected line format\n";
		const reader = makeReader([chunk]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		expect(consoleWarnSpy).toHaveBeenCalledWith(
			"Unknown line in event stream, does not start with 'data:'",
			'"unexpected line format"',
		);
		// Only done call, no messages stored
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
	});

	it("handles malformed JSON gracefully and logs an error", async () => {
		const storage = makeMockStorage();
		const chunk = "data: {not valid json}\n";
		const reader = makeReader([chunk]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Error while processing streaming response:",
			expect.any(Error),
		);
	});

	it("handles unknown event types by ignoring them and logging a warning", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "mystery_event" }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		expect(consoleWarnSpy).toHaveBeenCalledWith(
			"Unknown event in event stream: ",
			{ type: "mystery_event" },
		);
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
	});

	it("handles multiple chunks and assembles partial lines across reads correctly", async () => {
		const storage = makeMockStorage();
		// Split the data line across two chunks
		const fullLine = `data: ${JSON.stringify([{ type: "text", content: "split message" }])}`;
		const part1 = fullLine.slice(0, 20);
		const part2 = `${fullLine.slice(20)}\n`;
		const reader = makeReader([part1, part2]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ type: "text", text: "split message" },
		]);
	});

	it("processes multiple messages from multiple chunks and stores them in order", async () => {
		const storage = makeMockStorage();
		const chunk1 = `data: ${JSON.stringify([{ type: "text", content: "first" }])}\n`;
		const chunk2 = `data: ${JSON.stringify([{ type: "text-chunk", content: "second" }])}\n`;
		const reader = makeReader([chunk1, chunk2]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenNthCalledWith(
			1,
			CONV_ID,
			[{ type: "text", text: "first" }],
		);
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenNthCalledWith(
			2,
			CONV_ID,
			[{ type: "text_chunk", text: "second" }],
		);
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenNthCalledWith(
			3,
			CONV_ID,
			[],
			true,
		);
	});

	it("processes multiple events in the same line as a batch", async () => {
		const storage = makeMockStorage();
		const items = [
			{ type: "text", content: "one" },
			{ type: "text-chunk", content: "two" },
		];
		const chunk = `data: ${JSON.stringify(items)}\n`;
		const reader = makeReader([chunk]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage as any,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ type: "text", text: "one" },
			{ type: "text_chunk", text: "two" },
		]);
	});
});
