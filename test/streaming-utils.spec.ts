import { SpanStatusCode } from "@opentelemetry/api";
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
import { SpotterResponseFormat } from "../src/services/types";
import {
	processSpotter3EventStream,
	processSpotterXEventStream,
} from "../src/streaming-utils";
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

describe("processSpotter3EventStream", () => {
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: true, type: "text", text: "Reasoning..." },
		]);
	});

	it("parses a text-chunk event and stores a text_chunk message", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text-chunk", content: "chunk content", metadata: { format: "markdown" } }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text_chunk", text: "chunk content" },
		]);
	});

	it("sets is_thinking=true on a text-chunk event when metadata.type is 'thinking'", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text-chunk", content: "thinking chunk", metadata: { type: "thinking", format: "markdown" } }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: true, type: "text_chunk", text: "thinking chunk" },
		]);
	});

	it("ignores a text event whose metadata.format is not 'markdown'", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text", content: "plain text", metadata: { format: "plaintext" } }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		// Only the terminal done call should have been made (no message stored)
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			spotter_response_format: SpotterResponseFormat.SIMPLIFIED,
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			spotter_response_format: SpotterResponseFormat.SIMPLIFIED,
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
			recorder,
		);

		expect(recorder.count).not.toHaveBeenCalled();
	});

	it("ignores a text-chunk event whose metadata.format is not 'markdown'", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "text-chunk", content: "plain chunk", metadata: { format: "plaintext" } }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			spotter_response_format: SpotterResponseFormat.SIMPLIFIED,
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			spotter_response_format: SpotterResponseFormat.SIMPLIFIED,
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text", text: "keep me" },
			{ is_thinking: false, type: "text_chunk", text: "keep chunk" },
		]);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			spotter_response_format: SpotterResponseFormat.SIMPLIFIED,
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
			worksheet_id: "ws-123",
		};
		const line = `data: ${JSON.stringify([{ id: "msg-1", type: "answer", metadata }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		const expectedIframeUrl = `${INSTANCE_URL}/?tsmcp=true#/embed/conv-assist-answer?sessionId=sess-1&genNo=42&acSessionId=txn-1&acGenNo=7`;
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{
				is_thinking: false,
				type: "answer",
				answer_id: JSON.stringify({
					session_id: "sess-1",
					gen_no: 42,
					conversation_id: CONV_ID,
					message_id: "msg-1",
				}),
				answer_title: "My Answer",
				answer_data_source_id: "ws-123",
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		const expectedIframeUrl = `${INSTANCE_URL}/?tsmcp=true#/embed/conv-assist-answer?sessionId=sess-2&genNo=1&acSessionId=txn-2&acGenNo=2`;
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{
				is_thinking: true,
				type: "answer",
				answer_id: JSON.stringify({
					session_id: "sess-2",
					gen_no: 1,
					conversation_id: CONV_ID,
				}),
				answer_title: "Thinking Answer",
				answer_query: "show revenue",
				iframe_url: expectedIframeUrl,
			},
		]);
	});

	it("parses an error event and stores a text message with the display_message", async () => {
		const storage = makeMockStorage();
		const item = {
			type: "error",
			code: "ERR_001",
			message: "internal",
			display_message: "Something went wrong",
		};
		const line = `data: ${JSON.stringify([item])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text", text: "Something went wrong" },
		]);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Error event in event stream:",
			JSON.stringify(item),
		);
		expect(tracingState.span?.setStatus).toHaveBeenCalledWith({
			code: SpanStatusCode.ERROR,
			message: `Error event in event stream, error code: ${JSON.stringify(item)}`,
		});
	});

	it("falls back to 'Something went wrong' when error event has no display_message", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "error" }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text", text: "Something went wrong" },
		]);
	});

	it("does not count error events as parsed text messages", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "error", display_message: "Something went wrong" }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			spotter_response_format: SpotterResponseFormat.SIMPLIFIED,
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text", text: "hi" },
		]);
	});

	it("warns and skips lines that don't start with 'data:'", async () => {
		const storage = makeMockStorage();
		const chunk = "unexpected line format\n";
		const reader = makeReader([chunk]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(consoleWarnSpy).toHaveBeenCalledWith(
			"Unknown line in event stream, does not start with 'data:'",
			"unexpected line format",
		);
		// Only done call, no messages stored
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
	});

	it("handles malformed JSON gracefully and logs an error", async () => {
		const storage = makeMockStorage();
		const chunk = "data: {not valid json}\n";
		const reader = makeReader([chunk]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(consoleWarnSpy).toHaveBeenCalledWith(
			"Unknown event in event stream:",
			JSON.stringify({ type: "mystery_event" }),
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
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

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "text", text: "one" },
			{ is_thinking: false, type: "text_chunk", text: "two" },
		]);
	});

	it("parses a step_notification event and stores a step_notification message", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "notification", code: "TOOL_CALL_NOTIFICATION", metadata: { tool_title: "Running query" } }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: false, type: "step_notification", text: "Running query" },
		]);
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
	});

	it("sets is_thinking=true on a step_notification event when metadata.type is 'thinking'", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "notification", code: "TOOL_CALL_NOTIFICATION", metadata: { tool_title: "Thinking step", type: "thinking" } }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			{ is_thinking: true, type: "step_notification", text: "Thinking step" },
		]);
	});

	it("records a step_notification metric for a TOOL_CALL_NOTIFICATION event", async () => {
		const storage = makeMockStorage();
		const recorder: MetricsRecorder = {
			...NOOP_METRICS_RECORDER,
			count: vi.fn(),
		};
		const line = `data: ${JSON.stringify([{ type: "notification", code: "TOOL_CALL_NOTIFICATION", metadata: { tool_title: "Running query" } }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
			recorder,
		);

		expect(recorder.count).toHaveBeenCalledWith(
			METRIC_NAMES.upstreamStreamMessagesTotal,
			1,
			expect.objectContaining({
				upstream_operation: "send_agent_conversation_message_streaming",
				message_type: "step_notification",
				is_thinking: false,
			}),
		);
	});

	it("increments total_text_messages_parsed for a step_notification event", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "notification", code: "TOOL_CALL_NOTIFICATION", metadata: { tool_title: "Running query" } }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			spotter_response_format: SpotterResponseFormat.SIMPLIFIED,
			total_messages_parsed: 1,
			total_text_messages_parsed: 1,
			total_answer_messages_parsed: 0,
			total_messages_ignored: 0,
		});
	});

	it("ignores a notification event when code is not TOOL_CALL_NOTIFICATION", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "notification", code: "OTHER_NOTIFICATION", metadata: { tool_title: "Running query" } }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			spotter_response_format: SpotterResponseFormat.SIMPLIFIED,
			total_messages_parsed: 0,
			total_text_messages_parsed: 0,
			total_answer_messages_parsed: 0,
			total_messages_ignored: 1,
		});
	});

	it("ignores a notification event when metadata.tool_title is missing", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([{ type: "notification", code: "TOOL_CALL_NOTIFICATION", metadata: {} }])}\n`;
		const reader = makeReader([line]);

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			reader,
			storage.appendMessages,
		);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledOnce();
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			[],
			true,
		);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			spotter_response_format: SpotterResponseFormat.SIMPLIFIED,
			total_messages_parsed: 0,
			total_text_messages_parsed: 0,
			total_answer_messages_parsed: 0,
			total_messages_ignored: 1,
		});
	});
});

describe("processSpotter3EventStream — raw format", () => {
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

	const processRaw = (
		reader: ReadableStreamDefaultReader,
		storage: ReturnType<typeof makeMockStorage>,
		recorder?: MetricsRecorder,
	) =>
		processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.RAW,
			CONV_ID,
			reader,
			storage.appendMessages,
			recorder,
		);

	it("stores a text event verbatim instead of reshaping it", async () => {
		const storage = makeMockStorage();
		const item = {
			type: "text",
			content: "Hello world",
			metadata: { format: "markdown" },
		};
		const reader = makeReader([`data: ${JSON.stringify([item])}\n`]);

		await processRaw(reader, storage);

		// Raw mode passes the upstream item straight through — no is_thinking/text
		// projection like the simplified format performs.
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			item,
		]);
	});

	it("keeps text events that the simplified format drops for non-markdown", async () => {
		const storage = makeMockStorage();
		const plain = {
			type: "text",
			content: "Plain text",
			metadata: { format: "plain" },
		};
		const noFormat = { type: "text", content: "No format at all" };
		const reader = makeReader([`data: ${JSON.stringify([plain, noFormat])}\n`]);

		await processRaw(reader, storage);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			plain,
			noFormat,
		]);
	});

	it("keeps ack, notification, search_datasets, file, and conv_title events", async () => {
		const storage = makeMockStorage();
		const items = [
			{ type: "ack" },
			{ type: "notification", code: "OTHER_NOTIFICATION", metadata: {} },
			{ type: "search_datasets", datasets: ["ds-1"] },
			{ type: "file", url: "https://example.com/f.csv" },
			{ type: "conv_title", title: "Revenue analysis" },
		];
		const reader = makeReader([`data: ${JSON.stringify(items)}\n`]);

		await processRaw(reader, storage);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(
			CONV_ID,
			items,
		);
	});

	it("keeps unknown event types without logging a warning", async () => {
		const storage = makeMockStorage();
		const item = { type: "some_future_event_type", payload: { a: 1 } };
		const reader = makeReader([`data: ${JSON.stringify([item])}\n`]);

		await processRaw(reader, storage);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			item,
		]);
		expect(consoleWarnSpy).not.toHaveBeenCalled();
	});

	it("passes an answer event through, synthesizing answer_id but not an iframe url", async () => {
		const storage = makeMockStorage();
		const item = {
			type: "answer",
			metadata: {
				session_id: "sess-1",
				gen_no: 42,
				transaction_id: "txn-1",
				generation_number: 7,
				title: "Revenue by Region",
				sage_query: "revenue by region",
			},
		};
		const reader = makeReader([`data: ${JSON.stringify([item])}\n`]);

		await processRaw(reader, storage);

		const [, messages] = (
			storage.appendMessagesAndRestartTtl as ReturnType<typeof vi.fn>
		).mock.calls[0];
		// Raw mode still synthesizes `answer_id` so the get_session_updates ->
		// create_dashboard handoff keeps working, but does not otherwise reshape
		// the item (e.g. no iframe_url).
		expect(messages).toEqual([
			{
				...item,
				answer_id: JSON.stringify({
					session_id: "sess-1",
					gen_no: 42,
					conversation_id: CONV_ID,
				}),
			},
		]);
		expect(messages[0]).not.toHaveProperty("iframe_url");
	});

	it("passes an error event through unmodified without special logging or span flagging", async () => {
		const storage = makeMockStorage();
		const item = {
			type: "error",
			error_code: "SPOTTER_500",
			display_message: "Something broke upstream",
		};
		const reader = makeReader([`data: ${JSON.stringify([item])}\n`]);

		await processRaw(reader, storage);

		// Raw mode does not reshape the item or apply any error-specific handling;
		// the item is passed through untouched.
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledWith(CONV_ID, [
			item,
		]);
		expect(consoleErrorSpy).not.toHaveBeenCalled();
		expect(tracingState.span?.setStatus).not.toHaveBeenCalledWith(
			expect.objectContaining({ code: SpanStatusCode.ERROR }),
		);
	});

	it("marks the conversation as done when the stream ends", async () => {
		const storage = makeMockStorage();
		const reader = makeReader([
			`data: ${JSON.stringify([{ type: "text", content: "Hi" }])}\n`,
		]);

		await processRaw(reader, storage);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenLastCalledWith(
			CONV_ID,
			[],
			true,
		);
	});

	it("stores every item from a multi-item line in a single append", async () => {
		const storage = makeMockStorage();
		const items = [
			{ type: "text", content: "First", metadata: { format: "markdown" } },
			{ type: "ack" },
			{ type: "text", content: "Second", metadata: { format: "plain" } },
		];
		const reader = makeReader([`data: ${JSON.stringify(items)}\n`]);

		await processRaw(reader, storage);

		// One append for the batch, one terminal done call.
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledTimes(2);
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenNthCalledWith(
			1,
			CONV_ID,
			items,
		);
	});

	it("still skips blank lines and heartbeats", async () => {
		const storage = makeMockStorage();
		const item = { type: "text", content: "After heartbeat" };
		const reader = makeReader([
			`\n: heartbeat\ndata: ${JSON.stringify([item])}\n`,
		]);

		await processRaw(reader, storage);

		expect(storage.appendMessagesAndRestartTtl).toHaveBeenCalledTimes(2);
		expect(storage.appendMessagesAndRestartTtl).toHaveBeenNthCalledWith(
			1,
			CONV_ID,
			[item],
		);
	});

	it("still records per-message metrics and parse counters despite not reshaping messages", async () => {
		const storage = makeMockStorage();
		const recorder: MetricsRecorder = {
			...NOOP_METRICS_RECORDER,
			count: vi.fn(),
		};
		const reader = makeReader([
			`data: ${JSON.stringify([
				{ type: "text", content: "Hi", metadata: { format: "markdown" } },
				{ type: "answer", metadata: { session_id: "s1", gen_no: 1 } },
			])}\n`,
		]);

		await processRaw(reader, storage, recorder);

		// Raw mode does not reshape or per-type classify messages; every item is
		// recorded as `raw_untyped`, while parse counters stay accurate.
		expect(recorder.count).toHaveBeenCalledTimes(2);
		expect(recorder.count).toHaveBeenCalledWith(
			METRIC_NAMES.upstreamStreamMessagesTotal,
			1,
			expect.objectContaining({ message_type: "raw_untyped" }),
		);
		expect(tracingState.span?.setAttributes).toHaveBeenCalledWith({
			spotter_response_format: SpotterResponseFormat.RAW,
			total_messages_parsed: 2,
			total_text_messages_parsed: 1,
			total_answer_messages_parsed: 1,
			total_messages_ignored: 0,
		});
	});
});

describe("suppress-iframes", () => {
	it("builds no iframe_url for answers", async () => {
		const storage = makeMockStorage();
		const line = `data: ${JSON.stringify([
			{
				id: "msg-1",
				type: "answer",
				metadata: { session_id: "s1", gen_no: 2, title: "Headcount" },
			},
		])}\n`;

		await processSpotter3EventStream(
			INSTANCE_URL,
			SpotterResponseFormat.SIMPLIFIED,
			CONV_ID,
			makeReader([line]),
			storage.appendMessages,
			undefined,
			true,
		);

		const [, messages] = storage.appendMessagesAndRestartTtl.mock
			.calls[0] as any;
		expect(messages[0]).not.toHaveProperty("iframe_url");
		expect(messages[0]).toMatchObject({
			type: "answer",
			answer_title: "Headcount",
		});
	});
});

describe("processSpotterXEventStream", () => {
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

	const process = (
		reader: ReadableStreamDefaultReader,
		storage: ReturnType<typeof makeMockStorage>,
		format: SpotterResponseFormat = SpotterResponseFormat.RAW,
		recorder?: MetricsRecorder,
	) =>
		processSpotterXEventStream(
			INSTANCE_URL,
			format,
			CONV_ID,
			reader,
			storage.appendMessages,
			recorder,
		);

	it("marks the conversation as done when the stream ends with no data", async () => {
		const storage = makeMockStorage();

		await process(makeReader([]), storage);

		expect(storage.appendMessages).toHaveBeenCalledOnce();
		expect(storage.appendMessages).toHaveBeenCalledWith(CONV_ID, [], true);
	});

	describe("raw format", () => {
		it("stores each data event verbatim, then marks the conversation done", async () => {
			const storage = makeMockStorage();
			const first = { type: "text", content: "Hello" };
			const second = { type: "tool_call", name: "search", args: { q: "x" } };
			const reader = makeReader([
				`data: ${JSON.stringify(first)}\ndata: ${JSON.stringify(second)}\n`,
			]);

			await process(reader, storage);

			expect(storage.appendMessages).toHaveBeenNthCalledWith(1, CONV_ID, [
				first,
				second,
			]);
			expect(storage.appendMessages).toHaveBeenNthCalledWith(
				2,
				CONV_ID,
				[],
				true,
			);
		});

		it("ignores blank lines, id lines, and empty data lines", async () => {
			const storage = makeMockStorage();
			const item = { type: "text", content: "Hello" };
			const reader = makeReader([
				`id: 1\n\ndata: \ndata:    \ndata: ${JSON.stringify(item)}\n\n`,
			]);

			await process(reader, storage);

			expect(storage.appendMessages).toHaveBeenCalledWith(CONV_ID, [item]);
			expect(consoleWarnSpy).not.toHaveBeenCalled();
		});

		it("ignores SSE comment lines, including keep-alive pings", async () => {
			const storage = makeMockStorage();
			const item = { type: "text", content: "Hello" };
			const reader = makeReader([
				`: ping\n:\n:data: ${JSON.stringify({ hidden: true })}\n`,
				`data: ${JSON.stringify(item)}\n: keep-alive\n`,
			]);

			await process(reader, storage);

			expect(storage.appendMessages).toHaveBeenCalledTimes(2);
			expect(storage.appendMessages).toHaveBeenNthCalledWith(1, CONV_ID, [
				item,
			]);
			expect(storage.appendMessages).toHaveBeenNthCalledWith(
				2,
				CONV_ID,
				[],
				true,
			);
			expect(consoleWarnSpy).not.toHaveBeenCalled();
		});

		it("warns and skips lines that do not start with 'data: '", async () => {
			const storage = makeMockStorage();
			const item = { type: "text", content: "Hello" };
			const reader = makeReader([
				`event: message\ndata: ${JSON.stringify(item)}\n`,
			]);

			await process(reader, storage);

			expect(consoleWarnSpy).toHaveBeenCalledWith(
				"Unknown line in event stream, does not start with 'data:'",
				"event: message",
			);
			expect(storage.appendMessages).toHaveBeenCalledWith(CONV_ID, [item]);
		});

		it("buffers a line split across chunks until it is complete", async () => {
			const storage = makeMockStorage();
			const item = { type: "text", content: "Split across chunks" };
			const line = `data: ${JSON.stringify(item)}\n`;
			const reader = makeReader([line.slice(0, 15), line.slice(15)]);

			await process(reader, storage);

			expect(storage.appendMessages).toHaveBeenCalledTimes(2);
			expect(storage.appendMessages).toHaveBeenNthCalledWith(1, CONV_ID, [
				item,
			]);
			expect(storage.appendMessages).toHaveBeenNthCalledWith(
				2,
				CONV_ID,
				[],
				true,
			);
		});

		it("does not store anything for a chunk with no complete events", async () => {
			const storage = makeMockStorage();
			const reader = makeReader(["id: 1\n\n"]);

			await process(reader, storage);

			expect(storage.appendMessages).toHaveBeenCalledOnce();
			expect(storage.appendMessages).toHaveBeenCalledWith(CONV_ID, [], true);
		});

		it("records a raw_untyped stream message metric per event", async () => {
			const storage = makeMockStorage();
			const recorder: MetricsRecorder = {
				...NOOP_METRICS_RECORDER,
				count: vi.fn(),
			};
			const reader = makeReader([
				`data: ${JSON.stringify({ a: 1 })}\ndata: ${JSON.stringify({ b: 2 })}\n`,
			]);

			await process(reader, storage, SpotterResponseFormat.RAW, recorder);

			expect(recorder.count).toHaveBeenCalledTimes(2);
			expect(recorder.count).toHaveBeenCalledWith(
				METRIC_NAMES.upstreamStreamMessagesTotal,
				1,
				{
					upstream_operation: "send_agent_conversation_message_streaming",
					message_type: "raw_untyped",
					is_thinking: false,
				},
			);
		});

		it("sets is_thinking on the metric only for events with parts and no response text", async () => {
			const storage = makeMockStorage();
			const recorder: MetricsRecorder = {
				...NOOP_METRICS_RECORDER,
				count: vi.fn(),
			};
			const withParts = (parts: unknown[]) => ({
				result: { event: { content: { parts } } },
			});
			const items = [
				// Thinking: thought text and a tool call
				withParts([
					{ text: "Thinking", thought: true },
					{ function_call: { id: "call-1", name: "fetch_data" } },
				]),
				// Thinking: tool response only
				withParts([{ function_response: { id: "call-1" } }]),
				// Not thinking: response text
				withParts([{ text: "Response" }]),
				// Not thinking: mixed thought and response text
				withParts([{ text: "Thinking", thought: true }, { text: "Response" }]),
				// Not thinking: no parts
				{ result: { raw_event: { actions: { end_of_agent: true } } } },
			];
			const reader = makeReader([
				items.map((item) => `data: ${JSON.stringify(item)}\n`).join(""),
			]);

			await process(reader, storage, SpotterResponseFormat.RAW, recorder);

			expect(
				(recorder.count as ReturnType<typeof vi.fn>).mock.calls.map(
					(call) => call[2].is_thinking,
				),
			).toEqual([true, true, false, false, false]);
		});

		it("sets span attributes and an OK status on success", async () => {
			const storage = makeMockStorage();
			const reader = makeReader([
				`data: ${JSON.stringify({ a: 1 })}\ndata: ${JSON.stringify({ b: 2 })}\n`,
			]);

			await process(reader, storage);

			const span = tracingState.span!;
			expect(span.setAttribute).toHaveBeenCalledWith(
				"conversation_id",
				CONV_ID,
			);
			expect(span.setAttributes).toHaveBeenCalledWith({
				spotter_response_format: SpotterResponseFormat.RAW,
				total_messages_parsed: 2,
				total_text_messages_parsed: 2,
				total_answer_messages_parsed: 0,
				total_messages_ignored: 0,
			});
			expect(span.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.OK,
				message: "Streaming response concluded successfully",
			});
		});

		it("sets an error span status without throwing on malformed JSON", async () => {
			const storage = makeMockStorage();
			const reader = makeReader(["data: {not json\n"]);

			await expect(process(reader, storage)).resolves.toBeUndefined();

			const span = tracingState.span!;
			expect(span.setStatus).toHaveBeenCalledWith(
				expect.objectContaining({ code: SpanStatusCode.ERROR }),
			);
			expect(span.setStatus).not.toHaveBeenCalledWith(
				expect.objectContaining({ code: SpanStatusCode.OK }),
			);
			expect(consoleErrorSpy).toHaveBeenCalled();
		});

		it("sets an error span status when the reader throws", async () => {
			const storage = makeMockStorage();
			const reader = {
				read: vi.fn().mockRejectedValue(new Error("connection reset")),
			} as unknown as ReadableStreamDefaultReader;

			await process(reader, storage);

			expect(tracingState.span!.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.ERROR,
				message: "connection reset",
			});
			expect(storage.appendMessages).not.toHaveBeenCalled();
		});
	});

	describe("simplified format", () => {
		const NLS_ANSWER = {
			title: "Top 10 products",
			session_id: "session-1",
			gen_no: 1,
			transaction_id: "transaction-1",
			generation_number: 2,
			worksheet_id: "worksheet-1",
			sage_query: "top 10 [product] [sales]",
		};
		const EXPECTED_ANSWER = {
			type: "answer",
			answer_id: JSON.stringify({
				session_id: "session-1",
				gen_no: 1,
				conversation_id: CONV_ID,
			}),
			answer_title: "Top 10 products",
			answer_data_source_id: "worksheet-1",
			answer_query: "top 10 [product] [sales]",
			iframe_url: `${INSTANCE_URL}/?tsmcp=true#/embed/conv-assist-answer?sessionId=session-1&genNo=1&acSessionId=transaction-1&acGenNo=2`,
		};

		// Builds an SSE stream body from stream items, in the SpotterX envelope format
		const sse = (...items: unknown[]) =>
			items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("");
		const withEvent = (event: Record<string, unknown>) => ({
			result: { event, raw_event: event },
		});
		const withRawEventOnly = (rawEvent: Record<string, unknown>) => ({
			result: { raw_event: rawEvent },
		});
		const withParts = (parts: unknown[], partial?: boolean) =>
			withEvent({
				author: "spotterx__spotter",
				content: { role: "model", parts },
				...(partial !== undefined && { partial }),
			});
		const nlsResponsePart = (callId: string, nlsAnswerText: string) => ({
			function_response: {
				id: callId,
				name: "spotter_tools_fetch_and_visualize_data",
				response: {
					content: [
						{ type: "text", text: "Answer summary" },
						{
							type: "resource",
							annotations: { name: "nls_answer" },
							resource: { mimeType: "application/json", text: nlsAnswerText },
						},
					],
				},
			},
		});
		const inlineRefMarker = (callId: string) =>
			withRawEventOnly({
				author: "spotterx__spotter",
				custom_metadata: {
					ts_inline_tool_ref: {
						function_call_id: callId,
						ref_id: "r1",
						tool_name: "spotter_tools_fetch_and_visualize_data",
					},
				},
			});

		const processSimplified = (
			body: string,
			storage: ReturnType<typeof makeMockStorage>,
			recorder?: MetricsRecorder,
			suppressIframes = false,
		) =>
			processSpotterXEventStream(
				INSTANCE_URL,
				SpotterResponseFormat.SIMPLIFIED,
				CONV_ID,
				makeReader([body]),
				storage.appendMessages,
				recorder,
				suppressIframes,
			);

		// All messages stored across append calls, in order
		const storedMessages = (storage: ReturnType<typeof makeMockStorage>) =>
			storage.appendMessages.mock.calls.flatMap(
				(call) => (call as unknown[])[1] as unknown[],
			);

		const makeRecorder = (): MetricsRecorder => ({
			...NOOP_METRICS_RECORDER,
			count: vi.fn(),
		});
		const metricLabels = (recorder: MetricsRecorder) =>
			(recorder.count as ReturnType<typeof vi.fn>).mock.calls.map(
				(call) => call[2],
			);

		describe("text", () => {
			it("stores partial text as text_chunk messages", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withParts([{ text: "Hello" }], true),
						withParts([{ text: " world" }], true),
					),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: false, type: "text_chunk", text: "Hello" },
					{ is_thinking: false, type: "text_chunk", text: " world" },
				]);
			});

			it("sets is_thinking=true on thought text", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(withParts([{ text: "Let me think", thought: true }], true)),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: true, type: "text_chunk", text: "Let me think" },
				]);
			});

			it("skips the aggregated text in a final event after partial chunks", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withParts([{ text: "I'll hand" }], true),
						withParts([{ text: " this off." }], true),
						withParts([{ text: "I'll hand this off." }], false),
					),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: false, type: "text_chunk", text: "I'll hand" },
					{ is_thinking: false, type: "text_chunk", text: " this off." },
				]);
			});

			it("stores final text as a text message when no partial chunks preceded it", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(withParts([{ text: "Complete response" }])),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: false, type: "text", text: "Complete response" },
				]);
			});

			it("resets after a final event, so a later final event without chunks is stored", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withParts([{ text: "First" }], true),
						withParts([{ text: "First" }], false),
						withParts([{ text: "Second" }], false),
					),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: false, type: "text_chunk", text: "First" },
					{ is_thinking: false, type: "text", text: "Second" },
				]);
			});

			it("ignores empty text chunks", async () => {
				const storage = makeMockStorage();

				await processSimplified(sse(withParts([{ text: "" }], true)), storage);

				expect(storage.appendMessages).toHaveBeenCalledOnce();
				expect(storage.appendMessages).toHaveBeenCalledWith(CONV_ID, [], true);
			});
		});

		describe("tool calls", () => {
			it("stores a step_notification for a named tool call", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withParts([
							{
								function_call: {
									id: "call-1",
									name: "get_memory",
									args: { query: "x" },
								},
							},
						]),
					),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: true, type: "step_notification", text: "get_memory" },
				]);
			});

			it("stores one step_notification per tool call ID, ignoring repeats and progress updates", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withParts(
							[{ function_call: { id: "call-1", name: "fetch_data" } }],
							true,
						),
						withParts([
							{ function_call: { id: "call-1", name: "fetch_data", args: {} } },
						]),
						withParts(
							[
								{
									text: '[fetch_data] {"code":"nls_start"}',
									thought: true,
									function_call: { id: "call-1" },
								},
							],
							true,
						),
						withParts([
							{ function_call: { id: "call-2", name: "get_memory" } },
						]),
					),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: true, type: "step_notification", text: "fetch_data" },
					{ is_thinking: true, type: "step_notification", text: "get_memory" },
				]);
			});

			it("ignores a tool call with no ID", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(withParts([{ function_call: { name: "get_memory" } }])),
					storage,
				);

				expect(storedMessages(storage)).toEqual([]);
			});

			it("stores the step_notification of a final event that also repeats streamed thought text", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withParts([{ text: "Fetching data.", thought: true }], true),
						withParts([
							{ text: "Fetching data.", thought: true },
							{ function_call: { id: "call-1", name: "fetch_data" } },
						]),
					),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: true, type: "text_chunk", text: "Fetching data." },
					{ is_thinking: true, type: "step_notification", text: "fetch_data" },
				]);
			});
		});

		describe("answers", () => {
			it("stores a thinking answer from a tool response's nls_answer resource", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withParts([nlsResponsePart("call-1", JSON.stringify(NLS_ANSWER))]),
					),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: true, ...EXPECTED_ANSWER },
				]);
			});

			it("re-emits a thinking answer as a final answer when a raw_event marker references it", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withParts([nlsResponsePart("call-1", JSON.stringify(NLS_ANSWER))]),
						withParts([{ text: "Here are the results." }], true),
						inlineRefMarker("call-1"),
					),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: true, ...EXPECTED_ANSWER },
					{
						is_thinking: false,
						type: "text_chunk",
						text: "Here are the results.",
					},
					{ is_thinking: false, ...EXPECTED_ANSWER },
				]);
			});

			it("reads a marker from the typed event's custom_metadata", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withParts([nlsResponsePart("call-1", JSON.stringify(NLS_ANSWER))]),
						{
							result: {
								event: {
									custom_metadata: {
										ts_inline_tool_ref: { function_call_id: "call-1" },
									},
								},
							},
						},
					),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: true, ...EXPECTED_ANSWER },
					{ is_thinking: false, ...EXPECTED_ANSWER },
				]);
			});

			it("keeps an unreferenced answer as thinking only, and ignores a marker for an unknown call", async () => {
				const storage = makeMockStorage();
				const discarded = { ...NLS_ANSWER, session_id: "discarded" };

				await processSimplified(
					sse(
						withParts([nlsResponsePart("call-1", JSON.stringify(discarded))]),
						withParts([nlsResponsePart("call-2", JSON.stringify(NLS_ANSWER))]),
						inlineRefMarker("call-2"),
						inlineRefMarker("call-unknown"),
					),
					storage,
				);

				const answers = storedMessages(storage) as {
					is_thinking: boolean;
					answer_id: string;
				}[];
				expect(
					answers.map((answer) => [
						answer.is_thinking,
						JSON.parse(answer.answer_id).session_id,
					]),
				).toEqual([
					[true, "discarded"],
					[true, "session-1"],
					[false, "session-1"],
				]);
			});

			it("ignores tool responses without an nls_answer resource", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withParts([
							{
								function_response: {
									id: "call-1",
									name: "get_memory",
									response: { content: [{ type: "text", text: "{}" }] },
								},
							},
						]),
					),
					storage,
				);

				expect(storedMessages(storage)).toEqual([]);
			});

			it("ignores an nls_answer that is not valid JSON and logs an error", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(withParts([nlsResponsePart("call-1", "{not json")])),
					storage,
				);

				expect(storedMessages(storage)).toEqual([]);
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Failed to parse SpotterX NLS answer:",
					expect.any(String),
					expect.any(SyntaxError),
				);
			});

			it("builds no iframe_url when iframes are suppressed", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withParts([nlsResponsePart("call-1", JSON.stringify(NLS_ANSWER))]),
						inlineRefMarker("call-1"),
					),
					storage,
					undefined,
					true,
				);

				const messages = storedMessages(storage);
				expect(messages).toHaveLength(2);
				for (const message of messages) {
					expect(message).not.toHaveProperty("iframe_url");
					expect(message).toMatchObject({ type: "answer" });
				}
			});
		});

		describe("errors", () => {
			it("stores a stream-level error's message and flags the span", async () => {
				const storage = makeMockStorage();
				const recorder = makeRecorder();
				const item = {
					result: { error: { code: 409, message: "Session busy" } },
				};

				await processSimplified(sse(item), storage, recorder);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: false, type: "text", text: "Session busy" },
				]);
				expect(tracingState.span!.setStatus).toHaveBeenCalledWith({
					code: SpanStatusCode.ERROR,
					message: `Error event in event stream: ${JSON.stringify(item)}`,
				});
				expect(tracingState.span!.setStatus).not.toHaveBeenCalledWith(
					expect.objectContaining({ code: SpanStatusCode.OK }),
				);
				expect(metricLabels(recorder)).toEqual([
					expect.objectContaining({
						message_type: "error",
						is_thinking: false,
					}),
				]);
				expect(consoleErrorSpy).toHaveBeenCalled();
			});

			it("stores an agent error's error_message", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withEvent({
							error_code: "MODEL_ERROR",
							error_message: "Model failed",
							custom_metadata: { __ba_error: { display_message: "Ignored" } },
						}),
					),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: false, type: "text", text: "Model failed" },
				]);
			});

			it("falls back to the __ba_error display_message on the typed event", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse({
						result: {
							event: {
								error_code: "MODEL_ERROR",
								custom_metadata: {
									__ba_error: { display_message: "From event" },
								},
							},
						},
					}),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: false, type: "text", text: "From event" },
				]);
			});

			it("falls back to the __ba_error display_message on the raw_event", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse({
						result: {
							event: { error_code: "MODEL_ERROR" },
							raw_event: {
								error_code: "MODEL_ERROR",
								custom_metadata: {
									__ba_error: { display_message: "From raw event" },
								},
							},
						},
					}),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: false, type: "text", text: "From raw event" },
				]);
			});

			it("falls back to 'Something went wrong' when the error has no message", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(withEvent({ error_code: "MODEL_ERROR" })),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: false, type: "text", text: "Something went wrong" },
				]);
			});

			it("keeps processing events after an error", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withEvent({ error_code: "MODEL_ERROR", error_message: "Failed" }),
						withParts([{ text: "Continuing" }]),
					),
					storage,
				);

				expect(storedMessages(storage)).toEqual([
					{ is_thinking: false, type: "text", text: "Failed" },
					{ is_thinking: false, type: "text", text: "Continuing" },
				]);
			});
		});

		describe("ignored events", () => {
			it("ignores events with only state changes", async () => {
				const storage = makeMockStorage();

				await processSimplified(
					sse(
						withRawEventOnly({
							author: "TitleGenerator",
							actions: { state_delta: { __title: "Top 10 Products" } },
						}),
						withRawEventOnly({
							author: "spotterx",
							actions: { end_of_agent: true },
						}),
					),
					storage,
				);

				expect(storage.appendMessages).toHaveBeenCalledOnce();
				expect(storage.appendMessages).toHaveBeenCalledWith(CONV_ID, [], true);
			});

			it("warns about and ignores an item with no event", async () => {
				const storage = makeMockStorage();
				const item = { unexpected: true };

				await processSimplified(sse(item), storage);

				expect(storedMessages(storage)).toEqual([]);
				expect(consoleWarnSpy).toHaveBeenCalledWith(
					"Unknown event in event stream:",
					JSON.stringify(item),
				);
			});
		});

		it("records metrics and span counters for each message type", async () => {
			const storage = makeMockStorage();
			const recorder = makeRecorder();

			await processSimplified(
				sse(
					// Parsed: text chunk
					withParts([{ text: "Thinking", thought: true }], true),
					// Parsed: step notification
					withParts([{ function_call: { id: "call-1", name: "fetch_data" } }]),
					// Ignored: progress update
					withParts(
						[
							{
								text: "[fetch_data] {}",
								thought: true,
								function_call: { id: "call-1" },
							},
						],
						true,
					),
					// Parsed: thinking answer
					withParts([nlsResponsePart("call-1", JSON.stringify(NLS_ANSWER))]),
					// Parsed: final answer
					inlineRefMarker("call-1"),
					// Ignored: state-only event
					withRawEventOnly({ actions: { end_of_agent: true } }),
				),
				storage,
				recorder,
			);

			const operation = "send_agent_conversation_message_streaming";
			expect(metricLabels(recorder)).toEqual([
				{
					upstream_operation: operation,
					message_type: "text_chunk",
					is_thinking: true,
				},
				{
					upstream_operation: operation,
					message_type: "step_notification",
					is_thinking: true,
				},
				{
					upstream_operation: operation,
					message_type: "answer",
					is_thinking: true,
				},
				{
					upstream_operation: operation,
					message_type: "answer",
					is_thinking: false,
				},
			]);
			expect(tracingState.span!.setAttributes).toHaveBeenCalledWith({
				spotter_response_format: SpotterResponseFormat.SIMPLIFIED,
				total_messages_parsed: 4,
				total_text_messages_parsed: 2,
				total_answer_messages_parsed: 2,
				total_messages_ignored: 2,
			});
			expect(tracingState.span!.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.OK,
				message: "Streaming response concluded successfully",
			});
		});

		it("converts a full turn in stream order", async () => {
			const storage = makeMockStorage();

			await processSimplified(
				sse(
					withRawEventOnly({
						author: "TitleGenerator",
						actions: { state_delta: { __title: "Top 10 Products" } },
					}),
					withParts([{ text: "I'll hand this" }], true),
					withParts([{ text: " to the data agent." }], true),
					withParts([{ text: "I'll hand this to the data agent." }], false),
					withParts([{ text: "Let me fetch that.", thought: true }], true),
					withParts([
						{ text: "Let me fetch that.", thought: true },
						{ function_call: { id: "call-1", name: "fetch_data", args: {} } },
					]),
					withParts(
						[
							{
								text: '[fetch_data] {"code":"nls_start"}',
								thought: true,
								function_call: { id: "call-1" },
							},
						],
						true,
					),
					withParts([nlsResponsePart("call-1", JSON.stringify(NLS_ANSWER))]),
					withParts([{ text: "Here are the top products." }], true),
					withParts([{ text: "Here are the top products." }], false),
					inlineRefMarker("call-1"),
					withRawEventOnly({ actions: { end_of_agent: true } }),
				),
				storage,
			);

			expect(storedMessages(storage)).toEqual([
				{ is_thinking: false, type: "text_chunk", text: "I'll hand this" },
				{ is_thinking: false, type: "text_chunk", text: " to the data agent." },
				{ is_thinking: true, type: "text_chunk", text: "Let me fetch that." },
				{ is_thinking: true, type: "step_notification", text: "fetch_data" },
				{ is_thinking: true, ...EXPECTED_ANSWER },
				{
					is_thinking: false,
					type: "text_chunk",
					text: "Here are the top products.",
				},
				{ is_thinking: false, ...EXPECTED_ANSWER },
			]);
			expect(storage.appendMessages).toHaveBeenLastCalledWith(
				CONV_ID,
				[],
				true,
			);
		});

		it("still marks the conversation done when the stream has no events", async () => {
			const storage = makeMockStorage();

			await process(makeReader([]), storage, SpotterResponseFormat.SIMPLIFIED);

			expect(storage.appendMessages).toHaveBeenCalledOnce();
			expect(storage.appendMessages).toHaveBeenCalledWith(CONV_ID, [], true);
		});
	});
});
