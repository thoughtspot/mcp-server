import type { Message } from "./thoughtspot/types";
import type { StreamingMessagesStorageWithTtl } from "./streaming-message-storage-with-ttl/streaming-message-storage-with-ttl";
import { withSpan } from "./metrics/tracing/tracing-utils";
import { type Span, SpanStatusCode } from "@opentelemetry/api";

/*
 * Handles processing the event stream from a send agent conversation message response. Reads from
 * the stream, parses events into messages, and stores them in the streaming message storage. We
 * wrap it with a span to collect relevant metrics during processing.
 */
export const processSendAgentConversationMessageStreamingResponse = async (
	conversationId: string,
	streamingResponseReader: ReadableStreamDefaultReader,
	streamingMessageStorage: StreamingMessagesStorageWithTtl,
	instanceUrl: string,
) => {
	return await withSpan(
		"process-send-agent-conversation-message-streaming-response",
		async (span: Span) => {
			span.setAttribute("conversation_id", conversationId);
			let nTextMessagesParsed = 0;
			let nAnswerMessagesParsed = 0;
			let nMessagesIgnored = 0;
			let spanHasError = false;

			try {
				const decoder = new TextDecoder();
				let buffer = "";

				// Keep looping to read more content from the stream
				while (true) {
					const { done, value } = await streamingResponseReader.read();

					// If stream is marked done, mark the conversation as done and exit
					if (done) {
						await streamingMessageStorage.appendMessagesAndRestartTtl(
							conversationId,
							[],
							true,
						);
						break;
					}

					// Decode the latest contents from the stream, and split by line. Leave the
					// last line in the buffer as it may be incomplete, so we'll check it on the
					// next loop.
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					// Loop through the lines and parse them into messages to be stored
					const newMessages: Message[] = [];
					for (const line of lines) {
						// Ignore blank lines and heartbeats
						if (line === "" || line === ": heartbeat") {
							continue;
						}

						// Check for other unexpected line formats
						if (!line.startsWith("data: ")) {
							console.warn(
								"Unknown line in event stream, does not start with 'data:'",
								`"${line}"`,
							);
							continue;
						}

						// Trim the "data: " prefix, then parse the line
						const data = JSON.parse(line.slice(6));

						// Loop through the items in the line and convert to messages if applicable
						for (const item of data) {
							if (item.type === "text") {
								nTextMessagesParsed++;
								newMessages.push({
									is_thinking: item.metadata?.type === "thinking",
									type: "text",
									text: item.content,
								});
							} else if (item.type === "text-chunk") {
								nTextMessagesParsed++;
								newMessages.push({
									is_thinking: item.metadata?.type === "thinking",
									type: "text_chunk",
									text: item.content,
								});
							} else if (item.type === "answer") {
								nAnswerMessagesParsed++;
								const iframeUrl = `${instanceUrl}/?tsmcp=true#/embed/conv-assist-answer?sessionId=${item.metadata?.session_id}&genNo=${item.metadata?.gen_no}&acSessionId=${item.metadata?.transaction_id}&acGenNo=${item.metadata?.generation_number}`;
								newMessages.push({
									is_thinking: item.metadata?.type === "thinking",
									type: "answer",
									answer_id: JSON.stringify({
										session_id: item.metadata?.session_id,
										gen_no: item.metadata?.gen_no,
									}),
									answer_title: item.metadata?.title,
									answer_query: item.metadata?.sage_query,
									iframe_url: iframeUrl,
								});
							} else if (
								item.type === "ack" ||
								item.type === "notification" ||
								item.type === "search_datasets" ||
								item.type === "file" ||
								item.type === "conv_title"
							) {
								// We intentionally ignore the above events
								nMessagesIgnored++;
							} else if (item.type === "error") {
								console.error("Error event in event stream: ", item);
								nTextMessagesParsed++;
								spanHasError = true;
								span.setStatus({
									code: SpanStatusCode.ERROR,
									message: item,
								});
								newMessages.push({
									is_thinking: false,
									type: "text",
									text: item.display_message || "Something went wrong",
								});
							} else {
								console.warn("Unknown event in event stream: ", item);
								nMessagesIgnored++;
							}
						}
					}

					// If we parsed any new messages, store them in the storage
					if (newMessages.length > 0) {
						await streamingMessageStorage.appendMessagesAndRestartTtl(
							conversationId,
							newMessages,
						);
					}
				}
			} catch (error) {
				console.error("Error while processing streaming response:", error);
				spanHasError = true;
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: error instanceof Error ? error.message : String(error),
				});
			}

			span.setAttributes({
				total_messages_parsed: nTextMessagesParsed + nAnswerMessagesParsed,
				total_text_messages_parsed: nTextMessagesParsed,
				total_answer_messages_parsed: nAnswerMessagesParsed,
				total_messages_ignored: nMessagesIgnored,
			});
			if (!spanHasError) {
				span.setStatus({
					code: SpanStatusCode.OK,
					message: "Streaming response concluded successfully",
				});
			}
		},
	);
};
