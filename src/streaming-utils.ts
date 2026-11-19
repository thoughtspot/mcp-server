import { type Span, SpanStatusCode } from "@opentelemetry/api";
import type { MetricsRecorder } from "./metrics/runtime/metrics-recorder";
import {
	UPSTREAM_OPERATION_NAMES,
	recordUpstreamStreamMessageMetric,
} from "./metrics/runtime/tool-metrics";
import { withSpan } from "./metrics/tracing/tracing-utils";
import {
	type Message,
	type RawMessage,
	SpotterResponseFormat,
} from "./services/types";

// `session_id` + `gen_no` name the answer for export and dashboards, but expire
// (about 8 hours). `conversation_id` + `message_id` stay valid as long as the
// conversation does, and let get_data load the answer again for fresh ids.
function buildAnswerId(
	conversationId: string,
	item: { id?: string; metadata?: { session_id?: string; gen_no?: number } },
): string {
	return JSON.stringify({
		session_id: item.metadata?.session_id,
		gen_no: item.metadata?.gen_no,
		conversation_id: conversationId,
		message_id: item.id,
	});
}

// Which agent backend holds a file. get_file routes on it, so a file id stays
// valid if the connection later moves to another backend.
export type FileSource = "spotter3";
const FILE_SOURCES: readonly string[] = ["spotter3"] satisfies FileSource[];

// Names a file by its backend, conversation and upstream file id, so get_file
// needs one value and the parts cannot be mismatched. Parsed by `parseFileId`.
export function buildFileId(conversationId: string, tsFileId: string): string {
	return JSON.stringify({
		source: "spotter3" satisfies FileSource,
		conversation_id: conversationId,
		ts_file_id: tsFileId,
	});
}

// One URL path segment: not empty, no separator, and not a dot segment, which
// a URL parser would resolve to a different route.
function isPathSegment(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value !== "" &&
		value !== "." &&
		value !== ".." &&
		!/[/\\]/.test(value)
	);
}

export function parseFileId(
	fileId: string,
):
	| { source: FileSource; conversationId: string; tsFileId: string }
	| undefined {
	try {
		const parsed = JSON.parse(fileId);
		if (
			FILE_SOURCES.includes(parsed?.source) &&
			isPathSegment(parsed.conversation_id) &&
			isPathSegment(parsed.ts_file_id)
		) {
			return {
				source: parsed.source,
				conversationId: parsed.conversation_id,
				tsFileId: parsed.ts_file_id,
			};
		}
	} catch {
		// Not JSON: fall through.
	}
	return undefined;
}

// The ThoughtSpot route that serves a Spotter 3 file. It authenticates with the
// ThoughtSpot session cookie, so a browser signed in to ThoughtSpot can open
// it and the file never passes through the MCP client.
export function buildSpotter3FileDownloadUrl(
	instanceUrl: string,
	conversationId: string,
	tsFileId: string,
): string {
	return `${instanceUrl}/conversation/v2/${encodeURIComponent(conversationId)}/download/${encodeURIComponent(tsFileId)}`;
}

// Lower-case extension of a file name, without the dot ("" when there is none).
export function fileExtension(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

interface Spotter3FileItem {
	ts_file_id?: string;
	display_name?: string;
	file_type?: string;
}

function buildAnswerIframeUrl(
	instanceUrl: string,
	metadata?: {
		session_id?: string;
		gen_no?: number;
		transaction_id?: string;
		generation_number?: number;
	},
): string {
	return `${instanceUrl}/?tsmcp=true#/embed/conv-assist-answer?sessionId=${metadata?.session_id}&genNo=${metadata?.gen_no}&acSessionId=${metadata?.transaction_id}&acGenNo=${metadata?.generation_number}`;
}

/*
 * Parses the event stream for a Spotter 3 conversation. Converts the stream into discrete
 * events, which are stored in the conversation storage server for later retrieval.
 */
export const processSpotter3EventStream = async (
	instanceUrl: string,
	spotterResponseFormat: SpotterResponseFormat,
	conversationId: string,
	streamingResponseReader: ReadableStreamDefaultReader,
	appendStoredMessages: (
		conversationId: string,
		messages: (Message | RawMessage)[],
		isDone?: boolean,
	) => Promise<void>,
	recorder?: MetricsRecorder,
	suppressIframes = false,
	// Emit `file` messages (simplified format). Off unless the caller can fetch
	// them with get_file, so the client is not offered a file it cannot read.
	includeFiles = false,
) => {
	return await withSpan("process-spotter3-event-stream", async (span: Span) => {
		// Include the operation on every stream-message metric so future streamed
		// upstream calls do not collapse into the same series.
		const upstreamOperation =
			UPSTREAM_OPERATION_NAMES.sendAgentConversationMessageStreaming;
		span.setAttribute("conversation_id", conversationId);
		let nTextMessagesParsed = 0;
		let nAnswerMessagesParsed = 0;
		let nFileMessagesParsed = 0;
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
					await appendStoredMessages(conversationId, [], true);
					break;
				}

				// Decode the latest contents from the stream, and split by line. Leave the
				// last line in the buffer as it may be incomplete, so we'll check it on the
				// next loop.
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				// Loop through the lines and parse them into messages to be stored
				const newMessages: (Message | RawMessage)[] = [];
				for (const line of lines) {
					// Ignore blank lines and heartbeats
					if (line === "" || line === ": heartbeat") {
						continue;
					}

					// Check for other unexpected line formats
					if (!line.startsWith("data: ")) {
						console.warn(
							"Unknown line in event stream, does not start with 'data:'",
							line,
						);
						continue;
					}

					// Trim the "data: " prefix, then parse the line
					const data = JSON.parse(line.slice(6));

					// Loop through the items in the line and convert to messages if applicable
					for (const item of data) {
						// For the raw format, we don't need to perform any post-processing, so
						// just add the messages directly. The one exception is for answer
						// messages, where we generate the answer_id field for convenience.
						if (spotterResponseFormat === SpotterResponseFormat.RAW) {
							recordUpstreamStreamMessageMetric(
								recorder,
								upstreamOperation,
								"raw_untyped",
								item.metadata?.type === "thinking",
							);
							if (item.type === "answer") {
								nAnswerMessagesParsed++;
								newMessages.push({
									...item,
									answer_id: buildAnswerId(conversationId, item),
								});
							} else {
								nTextMessagesParsed++;
								newMessages.push({ ...item });
							}
							continue;
						}

						// For the simplified format, we perform some further processing
						if (item.type === "text") {
							// Ignore non-markdown text messages
							if (item.metadata?.format !== "markdown") {
								nMessagesIgnored++;
								continue;
							}

							nTextMessagesParsed++;
							recordUpstreamStreamMessageMetric(
								recorder,
								upstreamOperation,
								"text",
								item.metadata?.type === "thinking",
							);
							newMessages.push({
								is_thinking: item.metadata?.type === "thinking",
								type: "text",
								text: item.content,
							});
						} else if (item.type === "text-chunk") {
							// Ignore non-markdown text-chunk messages
							if (item.metadata?.format !== "markdown") {
								nMessagesIgnored++;
								continue;
							}

							nTextMessagesParsed++;
							recordUpstreamStreamMessageMetric(
								recorder,
								upstreamOperation,
								"text_chunk",
								item.metadata?.type === "thinking",
							);
							newMessages.push({
								is_thinking: item.metadata?.type === "thinking",
								type: "text_chunk",
								text: item.content,
							});
						} else if (item.type === "answer") {
							nAnswerMessagesParsed++;
							recordUpstreamStreamMessageMetric(
								recorder,
								upstreamOperation,
								"answer",
								item.metadata?.type === "thinking",
							);
							newMessages.push({
								is_thinking: item.metadata?.type === "thinking",
								type: "answer",
								answer_id: buildAnswerId(conversationId, item),
								answer_title: item.metadata?.title,
								answer_data_source_id: item.metadata?.worksheet_id,
								answer_query: item.metadata?.sage_query,
								...(!suppressIframes && {
									iframe_url: buildAnswerIframeUrl(instanceUrl, item.metadata),
								}),
							});
						} else if (item.type === "notification") {
							if (
								item.code !== "TOOL_CALL_NOTIFICATION" ||
								!item.metadata?.tool_title
							) {
								nMessagesIgnored++;
								continue;
							}

							nTextMessagesParsed++;
							recordUpstreamStreamMessageMetric(
								recorder,
								upstreamOperation,
								"step_notification",
								item.metadata?.type === "thinking",
							);
							newMessages.push({
								is_thinking: item.metadata?.type === "thinking",
								type: "step_notification",
								text: item.metadata.tool_title,
							});
						} else if (item.type === "file" && includeFiles) {
							const files: Spotter3FileItem[] = Array.isArray(item.files)
								? item.files
								: [];
							for (const file of files) {
								if (!file?.ts_file_id) {
									nMessagesIgnored++;
									continue;
								}
								nFileMessagesParsed++;
								recordUpstreamStreamMessageMetric(
									recorder,
									upstreamOperation,
									"file",
									item.metadata?.type === "thinking",
								);
								newMessages.push({
									is_thinking: item.metadata?.type === "thinking",
									type: "file",
									file_id: buildFileId(conversationId, file.ts_file_id),
									// Upstream escapes some names with backslashes.
									file_name: (file.display_name || file.ts_file_id).replace(
										/\\/g,
										"",
									),
									file_type: (
										file.file_type || fileExtension(file.ts_file_id)
									).toLowerCase(),
									file_download_url: buildSpotter3FileDownloadUrl(
										instanceUrl,
										conversationId,
										file.ts_file_id,
									),
								});
							}
						} else if (
							item.type === "ack" ||
							item.type === "search_datasets" ||
							item.type === "file" ||
							item.type === "conv_title"
						) {
							// We intentionally ignore the above events
							nMessagesIgnored++;
						} else if (item.type === "error") {
							console.error(
								"Error event in event stream:",
								JSON.stringify(item),
							);
							recordUpstreamStreamMessageMetric(
								recorder,
								upstreamOperation,
								"error",
								false,
							);
							spanHasError = true;
							span.setStatus({
								code: SpanStatusCode.ERROR,
								message: `Error event in event stream, error code: ${JSON.stringify(item)}`,
							});
							newMessages.push({
								is_thinking: false,
								type: "text",
								text: item.display_message || "Something went wrong",
							});
						} else {
							console.warn(
								"Unknown event in event stream:",
								JSON.stringify(item),
							);
							nMessagesIgnored++;
						}
					}
				}

				// If we parsed any new messages, store them in the storage
				if (newMessages.length > 0) {
					await appendStoredMessages(conversationId, newMessages);
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
			spotter_response_format: spotterResponseFormat,
			total_messages_parsed:
				nTextMessagesParsed + nAnswerMessagesParsed + nFileMessagesParsed,
			total_text_messages_parsed: nTextMessagesParsed,
			total_answer_messages_parsed: nAnswerMessagesParsed,
			...(includeFiles && {
				total_file_messages_parsed: nFileMessagesParsed,
			}),
			total_messages_ignored: nMessagesIgnored,
		});
		if (!spanHasError) {
			span.setStatus({
				code: SpanStatusCode.OK,
				message: "Streaming response concluded successfully",
			});
		}
	});
};

// Parsed JSON contents from SpotterXFunctionResponse for an NLS answer
interface SpotterXNlsAnswerResponse {
	title?: string;
	session_id?: string;
	gen_no?: number;
	transaction_id?: string;
	generation_number?: number;
	worksheet_id?: string;
	sage_query?: string;
}

interface SpotterXFunctionResponse {
	id?: string;
	name?: string;
	response?: {
		content?: {
			type?: string;
			annotations?: { name?: string };
			resource?: { text?: string };
		}[];
	};
}

// Subset of the ADK event fields we use. SpotterX serializes ADK events in snake_case
interface SpotterXEventPart {
	text?: string;
	thought?: boolean;
	function_call?: { id?: string; name?: string };
	function_response?: SpotterXFunctionResponse;
}

interface SpotterXEvent {
	partial?: boolean;
	content?: { parts?: SpotterXEventPart[] };
	error_code?: string;
	error_message?: string;
	custom_metadata?: {
		__ba_error?: { display_message?: string };
		// Marks where the agent presents a tool call's result (e.g. an answer) in its
		// final response
		ts_inline_tool_ref?: { function_call_id?: string };
	};
}

// SpotterX wraps each ADK event in an envelope. `event` is absent on some events (e.g.
// title generation, end of agent), in which case only `raw_event` is present. `error`
// is a stream-level error (e.g. session busy), separate from agent errors on the event
interface SpotterXStreamItem {
	result?: {
		event?: SpotterXEvent;
		raw_event?: SpotterXEvent;
		error?: { code?: number; message?: string };
	};
}

/*
 * Answers are returned in a tool's response, as a resource item annotated `nls_answer`
 * whose text is the answer JSON. Returns the parsed answer, or undefined if the response
 * has none or parsing fails.
 */
function parseSpotterXNlsAnswer(
	functionResponse: SpotterXFunctionResponse,
): SpotterXNlsAnswerResponse | undefined {
	const nlsText = functionResponse.response?.content?.find(
		(item) =>
			item.type === "resource" &&
			item.annotations?.name === "nls_answer" &&
			item.resource?.text,
	)?.resource?.text;
	if (!nlsText) {
		return undefined;
	}
	try {
		return JSON.parse(nlsText);
	} catch (error) {
		console.error(
			"Failed to parse SpotterX NLS answer:",
			JSON.stringify(functionResponse),
			error,
		);
		return undefined;
	}
}

/*
 * Parses the event stream for a SpotterX conversation. Converts the stream into discrete
 * events, which are stored in the conversation storage server for later retrieval.
 */
export const processSpotterXEventStream = async (
	instanceUrl: string,
	spotterResponseFormat: SpotterResponseFormat,
	conversationId: string,
	streamingResponseReader: ReadableStreamDefaultReader,
	appendStoredMessages: (
		conversationId: string,
		messages: (Message | RawMessage)[],
		isDone?: boolean,
	) => Promise<void>,
	recorder?: MetricsRecorder,
	suppressIframes = false,
) => {
	return await withSpan("process-spotterx-event-stream", async (span: Span) => {
		// Include the operation on every stream-message metric so future streamed
		// upstream calls do not collapse into the same series.
		const upstreamOperation =
			UPSTREAM_OPERATION_NAMES.sendAgentConversationMessageStreaming;
		span.setAttribute("conversation_id", conversationId);
		let nTextMessagesParsed = 0;
		let nAnswerMessagesParsed = 0;
		let nMessagesIgnored = 0;
		let spanHasError = false;

		// ADK streams text as partial chunks, then repeats the full text in a final
		// non-partial event. We keep just the partial chunks and ignore the final repeated text.
		// Thinking and final text are tracked separately, as a non-partial event can repeat
		// one and introduce the other.
		let sawPartialThinkingText = false;
		let sawPartialFinalText = false;
		// Keep track of thinking answers, because they can be reused as final response answers
		const seenThinkingAnswers = new Map<string, RawMessage>();
		// Keep track of tool call IDs we already sent a step notification for
		const seenToolCallIds = new Set<string>();

		try {
			const decoder = new TextDecoder();
			let buffer = "";

			// Keep looping to read more content from the stream
			while (true) {
				const { done, value } = await streamingResponseReader.read();

				// If stream is marked done, mark the conversation as done and exit
				if (done) {
					await appendStoredMessages(conversationId, [], true);
					break;
				}

				// Decode the latest contents from the stream, and split by line. Leave the
				// last line in the buffer as it may be incomplete, so we'll check it on the
				// next loop.
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				// Loop through the lines and parse them into messages to be stored
				const newMessages: (Message | RawMessage)[] = [];
				for (const line of lines) {
					// Ignore blank lines, comment lines, and id lines
					if (
						line.trim() === "" ||
						line.startsWith(":") ||
						line.startsWith("id:")
					) {
						continue;
					}

					// Check for other unexpected line formats
					if (!line.startsWith("data: ")) {
						console.warn(
							"Unknown line in event stream, does not start with 'data:'",
							line,
						);
						continue;
					}

					// Trim the "data: " prefix, then parse the line if it's non-empty
					const prefixTrimmedLine = line.slice(6);
					if (prefixTrimmedLine.trim() === "") {
						continue;
					}
					const item = JSON.parse(prefixTrimmedLine) as SpotterXStreamItem;

					// For the raw format, we don't need to perform any post-processing, so
					// just add the messages directly
					if (spotterResponseFormat === SpotterResponseFormat.RAW) {
						// There could be multiple parts, we treat the whole thing as "thinking"
						// only if all parts are either non-text or have no thinking flag.
						const isThinking =
							!!item?.result?.event?.content?.parts?.length &&
							!item?.result?.event?.content?.parts.some(
								(part) => part.text && !part.thought,
							);
						recordUpstreamStreamMessageMetric(
							recorder,
							upstreamOperation,
							"raw_untyped",
							isThinking,
						);
						nTextMessagesParsed++;
						newMessages.push({ ...item });
						continue;
					}

					// For the simplified format, convert the ADK event into our message shapes

					// Handle errors: either a stream-level error or an agent error on the event
					const event = item?.result?.event ?? item?.result?.raw_event;
					if (
						item?.result?.error ||
						event?.error_code ||
						event?.error_message
					) {
						console.error("Error event in event stream:", JSON.stringify(item));
						recordUpstreamStreamMessageMetric(
							recorder,
							upstreamOperation,
							"error",
							false,
						);
						spanHasError = true;
						span.setStatus({
							code: SpanStatusCode.ERROR,
							message: `Error event in event stream: ${JSON.stringify(item)}`,
						});
						newMessages.push({
							is_thinking: false,
							type: "text",
							text:
								item?.result?.error?.message ||
								event?.error_message ||
								item?.result?.event?.custom_metadata?.__ba_error
									?.display_message ||
								item?.result?.raw_event?.custom_metadata?.__ba_error
									?.display_message ||
								"Something went wrong",
						});
						continue;
					}

					if (!event) {
						console.warn(
							"Unknown event in event stream:",
							JSON.stringify(item),
						);
						nMessagesIgnored++;
						continue;
					}

					// Answers in the final response are created by referencing an answer by ID
					// which was produced during thinking steps. In that scenario, look up the
					// referenced answer in the thinkingAnswers map and re-emit it as a final
					// response answer object.
					const inlineRef =
						item?.result?.event?.custom_metadata?.ts_inline_tool_ref ??
						item?.result?.raw_event?.custom_metadata?.ts_inline_tool_ref;
					const referencedAnswer =
						inlineRef?.function_call_id &&
						seenThinkingAnswers.get(inlineRef.function_call_id);
					if (referencedAnswer) {
						nAnswerMessagesParsed++;
						recordUpstreamStreamMessageMetric(
							recorder,
							upstreamOperation,
							"answer",
							false,
						);
						newMessages.push({ is_thinking: false, ...referencedAnswer });
					}

					// Ignore events with only state changes (title, end of agent, etc)
					const parts = event.content?.parts;
					if (!parts || parts.length === 0) {
						if (!referencedAnswer) {
							nMessagesIgnored++;
						}
						continue;
					}

					// ADK streams text as partial chunks, then repeats the full text in a final
					// non-partial event. Ignore the full text repetition of text we already saw
					// in partial chunks to avoid duplicating output.
					const skipRepeatedThinkingText =
						!event.partial && sawPartialThinkingText;
					const skipRepeatedFinalText = !event.partial && sawPartialFinalText;
					if (!event.partial) {
						sawPartialThinkingText = false;
						sawPartialFinalText = false;
					}

					for (const part of parts) {
						// Tool calls. The same call can appear in several events (e.g. progress
						// updates reference it by ID), so send a step notification only the first
						// time we see a call ID with a name, and ignore the rest
						if (part.function_call) {
							if (
								!part.function_call.id ||
								!part.function_call.name ||
								seenToolCallIds.has(part.function_call.id)
							) {
								nMessagesIgnored++;
								continue;
							}
							seenToolCallIds.add(part.function_call.id);
							nTextMessagesParsed++;
							recordUpstreamStreamMessageMetric(
								recorder,
								upstreamOperation,
								"step_notification",
								true,
							);
							newMessages.push({
								is_thinking: true,
								type: "step_notification",
								text: part.function_call.name,
							});
							continue;
						}

						// Tool responses. We care about answer generation so check for that, but
						// ignore the responses for any other tool calls.
						if (part.function_response) {
							const callId = part.function_response.id;
							const nlsAnswer = parseSpotterXNlsAnswer(part.function_response);
							if (!callId || !nlsAnswer) {
								nMessagesIgnored++;
								continue;
							}
							const answer = {
								type: "answer",
								answer_id: buildAnswerId(conversationId, {
									metadata: nlsAnswer,
								}),
								answer_title: nlsAnswer.title,
								answer_data_source_id: nlsAnswer.worksheet_id,
								answer_query: nlsAnswer.sage_query,
								...(!suppressIframes && {
									iframe_url: buildAnswerIframeUrl(instanceUrl, nlsAnswer),
								}),
							};
							seenThinkingAnswers.set(callId, answer);
							nAnswerMessagesParsed++;
							recordUpstreamStreamMessageMetric(
								recorder,
								upstreamOperation,
								"answer",
								true,
							);
							newMessages.push({ is_thinking: true, ...answer });
							continue;
						}

						// Text, either streamed as partial chunks or as a single final event
						if (part.text !== undefined) {
							const isThinking = part.thought === true;
							if (
								part.text === "" ||
								(isThinking ? skipRepeatedThinkingText : skipRepeatedFinalText)
							) {
								nMessagesIgnored++;
								continue;
							}
							if (event.partial && isThinking) {
								sawPartialThinkingText = true;
							} else if (event.partial) {
								sawPartialFinalText = true;
							}
							const type = event.partial ? "text_chunk" : "text";
							nTextMessagesParsed++;
							recordUpstreamStreamMessageMetric(
								recorder,
								upstreamOperation,
								type,
								isThinking,
							);
							newMessages.push({
								is_thinking: isThinking,
								type,
								text: part.text,
							});
							continue;
						}

						// Ignore anything else
						nMessagesIgnored++;
					}
				}

				// If we parsed any new messages, store them in the storage
				if (newMessages.length > 0) {
					await appendStoredMessages(conversationId, newMessages);
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
			spotter_response_format: spotterResponseFormat,
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
	});
};
