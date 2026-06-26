import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const tracingState = vi.hoisted(() => ({
	span: undefined as
		| {
				setAttribute: ReturnType<typeof vi.fn>;
				setAttributes: ReturnType<typeof vi.fn>;
				setStatus: ReturnType<typeof vi.fn>;
		  }
		| undefined,
}));

vi.mock("../src/metrics/tracing/tracing-utils", () => ({
	withSpan: async (_name: string, fn: (span: any) => Promise<unknown>) => {
		const span = {
			setAttribute: vi.fn(),
			setAttributes: vi.fn(),
			setStatus: vi.fn(),
		};
		tracingState.span = span;
		return fn(span);
	},
}));

import { METRIC_NAMES } from "../src/metrics/runtime/metric-types";
import {
	type MetricsRecorder,
	NOOP_METRICS_RECORDER,
} from "../src/metrics/runtime/metrics-recorder";
import { processSendAgentConversationMessageStreamingResponse } from "../src/streaming-utils";
import { makeReader } from "./servers/helpers";

// Mock storage
function makeMockStorage() {
	const fn = vi.fn(async () => {});
	return {
		appendMessages: fn,
		appendMessagesAndRestartTtl: fn,
	};
}

const INSTANCE_URL = "https://test.thoughtspot.com";
const CONV_ID = "conv-123";

describe("processSendAgentConversationMessageStreamingResponse", () => {
	let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		tracingState.span = undefined;
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
			storage.appendMessages,
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
		const line = `data: ${JSON.stringify([{ type: "text", content: "Hello world", metadata: { format: "markdown" } }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text", text: "Hello world" },
		]);
		// Final done call
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
	});

	it("records upstream operation on stream message metrics", async () => {
		const storage = makeMockStorage();
		const recorder: MetricsRecorder = {
			...NOOP_METRICS_RECORDER,
			count: vi.fn(),
		};
		const line = `data: ${JSON.stringify([{ type: "text", content: "Hello world", metadata: { format: "markdown" } }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
			recorder,
		);

		expect(recorder.count).toHaveBeenCalledWith(
			METRIC_NAMES.upstreamStreamMessagesTotal,
			1,
			expect.objectContaining({
				upstream_operation: "send_agent_conversation_message_streaming",
				message_type: "text",
				is_thinking: false,
			}),
		);
	});

	it("sets is_thinking=true on a text event when metadata.type is 'thinking'", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text", content: "Reasoning...", metadata: { type: "thinking", format: "markdown" } }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: true, type: "text", text: "Reasoning..." },
		]);
	});

	it("parses a text-chunk event and stores a text_chunk message", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text-chunk", content: "chunk content", metadata: { format: "markdown" } }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text_chunk", text: "chunk content" },
		]);
	});

	it("sets is_thinking=true on a text-chunk event when metadata.type is 'thinking'", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text-chunk", content: "thinking chunk", metadata: { type: "thinking", format: "markdown" } }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: true, type: "text_chunk", text: "thinking chunk" },
		]);
	});

	it("ignores a text event whose metadata.format is not 'markdown'", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text", content: "plain text", metadata: { format: "plaintext" } }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		// Only the terminal done call should have been made (no message stored)
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			total_messages_parsed: 0,
			total_text_messages_parsed: 0,
			total_answer_messages_parsed: 0,
			total_messages_ignored: 1,
		});
	});

	it("ignores a text event with no metadata.format", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text", content: "no format", metadata: {} }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			total_messages_parsed: 0,
			total_text_messages_parsed: 0,
			total_answer_messages_parsed: 0,
			total_messages_ignored: 1,
		});
	});

	it("does not record a metric for a text event whose format is not 'markdown'", async () => {
		const storage = makeMockStorage();
		const recorder: MetricsRecorder = {
			...NOOP_METRICS_RECORDER,
			count: vi.fn(),
		};
		const line = `data: ${JSON.stringify([{ type: "text", content: "plain text", metadata: { format: "plaintext" } }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
			recorder,
		);

		expect(recorder.count).not.toHaveBeenCalled();
	});

	it("ignores a text-chunk event whose metadata.format is not 'markdown'", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text-chunk", content: "plain chunk", metadata: { format: "plaintext" } }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			total_messages_parsed: 0,
			total_text_messages_parsed: 0,
			total_answer_messages_parsed: 0,
			total_messages_ignored: 1,
		});
	});

	it("ignores a text-chunk event with no metadata.format", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text-chunk", content: "no format chunk", metadata: {} }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			total_messages_parsed: 0,
			total_text_messages_parsed: 0,
			total_answer_messages_parsed: 0,
			total_messages_ignored: 1,
		});
	});

	it("stores only markdown text items when mixed with non-markdown items", async () => {
		const storage = makeMockStorage();
		const items = [
			{ type: "text", content: "keep me", metadata: { format: "markdown" } },
			{ type: "text", content: "drop me", metadata: { format: "plaintext" } },
			{
				type: "text-chunk",
				content: "keep chunk",
				metadata: { format: "markdown" },
			},
			{ type: "text-chunk", content: "drop chunk", metadata: {} },
		];
		const line = `data: ${JSON.stringify(items)}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text", text: "keep me" },
			{ is_thinking: false, type: "text_chunk", text: "keep chunk" },
		]);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			total_messages_parsed: 2,
			total_text_messages_parsed: 2,
			total_answer_messages_parsed: 0,
			total_messages_ignored: 2,
		});
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
			storage.appendMessages,
			INSTANCE_URL,
		);

		const expectedIframeUrl = `${INSTANCE_URL}/?tsmcp=true#/embed/conv-assist-answer?sessionId=sess-1&genNo=42&acSessionId=txn-1&acGenNo=7`;
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{
				is_thinking: false,
				type: "answer",
				answer_id: JSON.stringify({ session_id: "sess-1", gen_no: 42 }),
				answer_title: "My Answer",
				answer_query: "show sales",
				iframe_url: expectedIframeUrl,
			},
		]);
	});

	it("sets is_thinking=true on an answer event when metadata.type is 'thinking'", async () => {
		const storage = makeMockStorage();
		const metadata = {
			type: "thinking",
			session_id: "sess-2",
			gen_no: 1,
			transaction_id: "txn-2",
			generation_number: 2,
			title: "Thinking Answer",
			sage_query: "show revenue",
		};
		const line = `data: ${JSON.stringify([{ type: "answer", metadata }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		const expectedIframeUrl = `${INSTANCE_URL}/?tsmcp=true#/embed/conv-assist-answer?sessionId=sess-2&genNo=1&acSessionId=txn-2&acGenNo=2`;
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{
				is_thinking: true,
				type: "answer",
				answer_id: JSON.stringify({ session_id: "sess-2", gen_no: 1 }),
				answer_title: "Thinking Answer",
				answer_query: "show revenue",
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
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text", text: "Something went wrong" },
		]);
	});

	it("falls back to 'Something went wrong' when error event has no display_message", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "error" }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text", text: "Something went wrong" },
		]);
	});

	it("does not count error events as parsed text messages", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "error", display_message: "Something went wrong" }])}\n`;
		const reader = makeReader([line]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			total_messages_parsed: 0,
			total_text_messages_parsed: 0,
			total_answer_messages_parsed: 0,
			total_messages_ignored: 0,
		});
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
			storage.appendMessages,
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
		const chunk = `\n: heartbeat\ndata: ${JSON.stringify([{ type: "text", content: "hi", metadata: { format: "markdown" } }])}\n`;
		const reader = makeReader([chunk]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text", text: "hi" },
		]);
	});

	it("warns and skips lines that don't start with 'data:'", async () => {
		const storage = makeMockStorage();
		const chunk = "unexpected line format\n";
		const reader = makeReader([chunk]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(consoleWarnSpy).toHaveBeenCalledWith(
			"Unknown line in event stream, does not start with 'data:'",
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
			storage.appendMessages,
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
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(consoleWarnSpy).toHaveBeenCalledWith(
			"Unknown event in event stream:",
			"mystery_event",
		);
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
	});

	it("handles multiple chunks and assembles partial lines across reads correctly", async () => {
		const storage = makeMockStorage();
		// Split the data line across two chunks
		const fullLine = `data: ${JSON.stringify([{ type: "text", content: "split message", metadata: { format: "markdown" } }])}`;
		const part1 = fullLine.slice(0, 20);
		const part2 = `${fullLine.slice(20)}\n`;
		const reader = makeReader([part1, part2]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text", text: "split message" },
		]);
	});

	it("processes multiple messages from multiple chunks and stores them in order", async () => {
		const storage = makeMockStorage();
		const chunk1 = `data: ${JSON.stringify([{ type: "text", content: "first", metadata: { format: "markdown" } }])}\n`;
		const chunk2 = `data: ${JSON.stringify([{ type: "text-chunk", content: "second", metadata: { format: "markdown" } }])}\n`;
		const reader = makeReader([chunk1, chunk2]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenNthCalledWith(
			1,
			CONV_ID,
			[{ is_thinking: false, type: "text", text: "first" }],
		);
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenNthCalledWith(
			2,
			CONV_ID,
			[{ is_thinking: false, type: "text_chunk", text: "second" }],
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
			{ type: "text", content: "one", metadata: { format: "markdown" } },
			{ type: "text-chunk", content: "two", metadata: { format: "markdown" } },
		];
		const chunk = `data: ${JSON.stringify(items)}\n`;
		const reader = makeReader([chunk]);

		await processSendAgentConversationMessageStreamingResponse(
			CONV_ID,
			reader,
			storage.appendMessages,
			INSTANCE_URL,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text", text: "one" },
			{ is_thinking: false, type: "text_chunk", text: "two" },
		]);
	});
});
