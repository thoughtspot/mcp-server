import { isBoolean } from "lodash";
import {
	STREAM_STORAGE_OPERATIONS,
	type StreamStorageOperation,
	recordAnalysisFirstBufferedUpdateMetric,
	recordAnalysisFirstNonEmptyResponseMetric,
	recordAnalysisFirstPollDelayMetric,
	recordAnalysisSessionNeverPolledMetric,
	recordStreamStorageErrorMetric,
} from "../metrics/runtime/analysis-metrics";
import {
	type MetricsRecorder,
	scheduleMetricsFlush,
} from "../metrics/runtime/metrics-recorder";
import type {
	MetricAnalyticsContext,
	MetricEventIdentity,
} from "../metrics/runtime/metrics-sink";
import { createRequestMetricsRecorder } from "../metrics/runtime/request-metrics";
import type { MetricsEnvLike } from "../metrics/runtime/runtime-config";
import type {
	Message,
	StreamingConversationMetricsContext,
	StreamingConversationTimingState,
	StreamingMessagesState,
} from "../thoughtspot/types";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const STORAGE_BATCH_SIZE = 127; // Cloudflare DO bulk get/put limit is 128, we use 127 to be safe

const MESSAGE_KEY_PREFIX = "message-";
const IS_DONE_KEY = "is-done";
const WRITE_BOOKMARK_KEY = "write-bookmark";
const READ_BOOKMARK_KEY = "read-bookmark";
const METRICS_STATE_KEY = "metrics-state";

type ConversationMetricsState = StreamingConversationTimingState &
	StreamingConversationMetricsContext;

/**
 * A Durable Object that stores streaming conversation messages and exposes them over HTTP.
 *
 * Each instance corresponds to a single conversation. This means we don't need to use the
 * conversationId internally, instead it is used to route to a unique instance per conversation.
 * The parent DurableObject routes requests here via /storage/<conversation-id>, and this DO
 * handles the following sub-routes:
 *
 *   POST  /storage/<conversation-id>/initialize —> initializeConversation
 *   POST  /storage/<conversation-id>/append     —> appendMessagesAndRestartTtl
 *   GET   /storage/<conversation-id>/messages   —> getNewMessagesAndUpdateBookmark
 */
export class ConversationStorageServerSQLite {
	private conversationId = "";

	constructor(
		private state: DurableObjectState,
		private env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		// Strip the /storage/<conversation-id> prefix; remaining path is the operation
		// e.g. /storage/abc123/initialize -> /initialize
		const parts = url.pathname.split("/");
		// parts: ["", "storage", "<conversationId>", "<operation>"]
		this.conversationId = parts[2];
		const operation = parts[3] ?? "";

		try {
			switch (`${request.method} /${operation}`) {
				case "POST /initialize": {
					const body =
						((await request
							.json()
							.catch(() => ({}))) as Partial<ConversationMetricsState>) ?? {};
					await this.initializeConversation(body);
					return Response.json({ ok: true });
				}

				case "POST /append": {
					const body = (await request.json()) as StreamingMessagesState;
					await this.appendMessagesAndRestartTtl(body.messages, body.isDone);
					return Response.json({ ok: true });
				}

				case "GET /messages": {
					const state = await this.getNewMessagesAndUpdateBookmark();
					return Response.json(state);
				}

				default:
					return new Response("Not Found", { status: 404 });
			}
		} catch (err) {
			await this.recordStorageErrorMetric(this.toStorageOperation(operation));
			const message = err instanceof Error ? err.message : String(err);
			console.error(
				`Error handling conversation storage request for conversation ${this.conversationId}:`,
				message,
			);
			return Response.json({ error: message }, { status: 500 });
		}
	}

	/*
	 * Initialize the conversation. This can be a brand new conversation, or it can be priming an
	 * existing conversation which is already marked done for a followup message. We never delete
	 * messages in the conversation, instead the next messages begin at the existing bookmark.
	 */
	private async initializeConversation(
		metricsContext: Partial<ConversationMetricsState>,
	): Promise<void> {
		const existingIsDone = await this.state.storage.get<boolean>(IS_DONE_KEY);
		if (isBoolean(existingIsDone) && !existingIsDone) {
			throw new Error(
				`Conversation ${this.conversationId} already exists and is not marked done`,
			);
		}

		const metricsState: ConversationMetricsState = {
			responseStartedAtMs: metricsContext.responseStartedAtMs,
			apiRequestedVersion: metricsContext.apiRequestedVersion,
			analyticalSessionId:
				metricsContext.analyticalSessionId ?? this.conversationId,
			tenantId: metricsContext.tenantId,
			userId: metricsContext.userId,
		};

		await this.state.storage.put({
			[IS_DONE_KEY]: false,
			[METRICS_STATE_KEY]: metricsState,
		});
		await this.restartTtl();
	}

	/*
	 * Append new messages to the conversation, starting at the current state of WRITE_BOOKMARK and
	 * saving the new state of WRITE_BOOKMARK after. Writes are done un bulk, but batched if there
	 * are too many operations. The isDone flag is always in the last batch, so that any reader
	 * will never think the conversation is done before all messages have been written.
	 */
	private async appendMessagesAndRestartTtl(
		newMessages: Message[],
		isDone = false,
	): Promise<void> {
		const [existingIsDone, metricsState] = await Promise.all([
			this.state.storage.get<boolean>(IS_DONE_KEY),
			this.getConversationMetricsState(),
		]);
		if (!isBoolean(existingIsDone)) {
			throw new Error(`Conversation ${this.conversationId} not found`);
		}
		if (existingIsDone) {
			throw new Error(
				`Cannot append messages to conversation ${this.conversationId} marked done`,
			);
		}

		let idx = (await this.state.storage.get<number>(WRITE_BOOKMARK_KEY)) ?? 0;
		const entriesToStore = {} as Record<string, unknown>;
		for (const message of newMessages) {
			entriesToStore[`${MESSAGE_KEY_PREFIX}${idx}`] = message;
			idx++;
		}
		entriesToStore[WRITE_BOOKMARK_KEY] = idx;

		if (isDone) {
			entriesToStore[IS_DONE_KEY] = true;
		}
		const shouldRecordFirstBufferedUpdate =
			newMessages.length > 0 && !metricsState?.firstBufferedUpdateAtMs;
		if (metricsState && shouldRecordFirstBufferedUpdate) {
			metricsState.firstBufferedUpdateAtMs = Date.now();
			entriesToStore[METRICS_STATE_KEY] = metricsState;
		}

		// Perform all writes in batches, then restart TTL
		await this.putInBatches(entriesToStore);
		await this.restartTtl();

		if (
			shouldRecordFirstBufferedUpdate &&
			metricsState?.responseStartedAtMs !== undefined &&
			metricsState.firstBufferedUpdateAtMs !== undefined
		) {
			this.recordMetricsSafe(metricsState, (recorder) => {
				recordAnalysisFirstBufferedUpdateMetric(
					recorder,
					metricsState.firstBufferedUpdateAtMs! -
						metricsState.responseStartedAtMs!,
					"success",
				);
			});
		}
	}

	/*
	 * Retrieve all new messages since the last time this was called. We use a READ_BOOKMARK to
	 * track the index of the last returned message, and update it when returning new messages. We
	 * use WRITE_BOOKMARK to know up to which index new messages have been written.
	 */
	private async getNewMessagesAndUpdateBookmark(): Promise<StreamingMessagesState> {
		const [isDone, readBookmark, writeBookmark, metricsState] =
			await this.getConversationStateSnapshot();
		if (!isBoolean(isDone)) {
			throw new Error(`Conversation ${this.conversationId} not found`);
		}
		const shouldRecordFirstPoll = !metricsState?.firstPollAtMs;
		if (metricsState && shouldRecordFirstPoll) {
			metricsState.firstPollAtMs = Date.now();
			await this.state.storage.put(METRICS_STATE_KEY, metricsState);
			if (metricsState.responseStartedAtMs !== undefined) {
				this.recordMetricsSafe(metricsState, (recorder) => {
					recordAnalysisFirstPollDelayMetric(
						recorder,
						metricsState.firstPollAtMs! - metricsState.responseStartedAtMs!,
						"success",
					);
				});
			}
		}

		const newMessages = await this.getMessagesInRange(
			readBookmark,
			writeBookmark,
			true,
		);

		const shouldRecordFirstNonEmptyResponse =
			metricsState &&
			newMessages.length > 0 &&
			!metricsState.firstNonEmptyResponseAtMs;
		if (shouldRecordFirstNonEmptyResponse) {
			metricsState.firstNonEmptyResponseAtMs = Date.now();
			await this.state.storage.put(METRICS_STATE_KEY, metricsState);
			if (metricsState.responseStartedAtMs !== undefined) {
				this.recordMetricsSafe(metricsState, (recorder) => {
					recordAnalysisFirstNonEmptyResponseMetric(
						recorder,
						metricsState.firstNonEmptyResponseAtMs! -
							metricsState.responseStartedAtMs!,
						"success",
					);
				});
			}
		}

		await this.state.storage.put<number>(READ_BOOKMARK_KEY, writeBookmark);

		return {
			messages: newMessages,
			isDone,
		};
	}

	/*
	 * Perform bulk get operations in batches up to STORAGE_BATCH_SIZE
	 */
	private async getInBatches<T>(keys: string[]): Promise<Map<string, T>> {
		const result = new Map<string, T>();
		for (let i = 0; i < keys.length; i += STORAGE_BATCH_SIZE) {
			const batch = keys.slice(i, i + STORAGE_BATCH_SIZE);
			const batchResult = await this.state.storage.get<T>(batch);
			for (const [k, v] of batchResult) {
				result.set(k, v);
			}
		}
		return result;
	}

	/*
	 * Perform bulk put operations in batches up to STORAGE_BATCH_SIZE
	 */
	private async putInBatches(entries: Record<string, unknown>): Promise<void> {
		const keys = Object.keys(entries);
		for (let i = 0; i < keys.length; i += STORAGE_BATCH_SIZE) {
			const batchKeys = keys.slice(i, i + STORAGE_BATCH_SIZE);
			const batch = Object.fromEntries(batchKeys.map((k) => [k, entries[k]]));
			await this.state.storage.put(batch);
		}
	}

	/*
	 * Restart TTL timer by canceling any old alarm and scheduling a new one for DEFAULT_TTL_MS
	 */
	private async restartTtl(): Promise<void> {
		await this.state.storage.deleteAlarm();
		await this.state.storage.setAlarm(Date.now() + DEFAULT_TTL_MS);
	}

	async alarm(): Promise<void> {
		// Check for any abnormalities in the state prior to deleting
		const [isDone, readBookmark, writeBookmark, metricsState] =
			await this.getConversationStateSnapshot();
		if (!isBoolean(isDone) || !isDone) {
			console.warn(
				`Conversation ${this.conversationId} expired without being marked done`,
				{
					isDone,
					readBookmark,
					writeBookmark,
				},
			);
		}
		if (writeBookmark !== readBookmark) {
			console.warn(
				`Conversation ${this.conversationId} expired with unread messages`,
				{
					isDone,
					readBookmark,
					writeBookmark,
				},
			);
		}
		if (!metricsState?.firstPollAtMs) {
			this.recordMetricsSafe(metricsState, (recorder) => {
				recordAnalysisSessionNeverPolledMetric(recorder);
			});
		}

		// Delete everything in storage
		await this.state.storage.deleteAll();
	}

	/*
	 * Retrieve the core conversation state and metrics metadata in one transaction.
	 */
	async getConversationStateSnapshot(): Promise<
		[boolean | undefined, number, number, ConversationMetricsState | undefined]
	> {
		const result = await this.state.storage.get<
			boolean | number | ConversationMetricsState
		>([IS_DONE_KEY, READ_BOOKMARK_KEY, WRITE_BOOKMARK_KEY, METRICS_STATE_KEY]);
		return [
			result.get(IS_DONE_KEY) as boolean,
			(result.get(READ_BOOKMARK_KEY) as number) ?? 0,
			(result.get(WRITE_BOOKMARK_KEY) as number) ?? 0,
			result.get(METRICS_STATE_KEY) as ConversationMetricsState | undefined,
		];
	}

	private async getConversationMetricsState(): Promise<
		ConversationMetricsState | undefined
	> {
		return this.state.storage.get<ConversationMetricsState>(METRICS_STATE_KEY);
	}

	private async getMessagesInRange(
		readBookmark: number,
		writeBookmark: number,
		warnOnMissing = false,
	): Promise<Message[]> {
		const keys = [];
		for (let i = readBookmark; i < writeBookmark; i++) {
			keys.push(MESSAGE_KEY_PREFIX + i);
		}

		const messages: Message[] = [];
		const messagesMap = await this.getInBatches<Message>(keys);
		for (let i = readBookmark; i < writeBookmark; i++) {
			const message = messagesMap.get(MESSAGE_KEY_PREFIX + i);
			if (!message) {
				if (warnOnMissing) {
					console.warn(
						`Expected message at index ${i} for conversation ${this.conversationId} not found`,
						{ readBookmark, writeBookmark },
					);
				}
				continue;
			}
			messages.push(message);
		}

		return messages;
	}

	private createMetricsRecorder(
		metricsState?: ConversationMetricsState,
	): MetricsRecorder {
		const recorder = createRequestMetricsRecorder(
			this.env as unknown as MetricsEnvLike,
		);

		const analyticsContext: MetricAnalyticsContext = {};
		if (metricsState?.apiRequestedVersion) {
			analyticsContext.apiRequestedVersion = metricsState.apiRequestedVersion;
		}
		if (metricsState?.analyticalSessionId) {
			analyticsContext.analyticalSessionId = metricsState.analyticalSessionId;
		}
		if (Object.keys(analyticsContext).length > 0) {
			recorder.setAnalyticsContext(analyticsContext);
		}

		const eventIdentity: MetricEventIdentity = {};
		if (metricsState?.tenantId) {
			eventIdentity.tenantId = metricsState.tenantId;
		}
		if (metricsState?.userId) {
			eventIdentity.userId = metricsState.userId;
		}
		if (Object.keys(eventIdentity).length > 0) {
			recorder.setEventIdentity(eventIdentity);
		}

		return recorder;
	}

	private recordMetricsSafe(
		metricsState: ConversationMetricsState | undefined,
		record: (recorder: MetricsRecorder) => void,
	): void {
		try {
			const recorder = this.createMetricsRecorder(metricsState);
			record(recorder);
			scheduleMetricsFlush(recorder);
		} catch (error) {
			console.error(
				`[metrics] Failed to record conversation storage metrics for ${this.conversationId}`,
				error,
			);
		}
	}

	private async recordStorageErrorMetric(
		operation: StreamStorageOperation,
	): Promise<void> {
		try {
			const metricsState = await this.getConversationMetricsState();
			this.recordMetricsSafe(metricsState, (recorder) => {
				recordStreamStorageErrorMetric(recorder, operation);
			});
		} catch (error) {
			console.error(
				`[metrics] Failed to record conversation storage error metric for ${this.conversationId}`,
				error,
			);
		}
	}

	private toStorageOperation(operation: string): StreamStorageOperation {
		switch (operation) {
			case "initialize":
				return STREAM_STORAGE_OPERATIONS.initialize;
			case "append":
				return STREAM_STORAGE_OPERATIONS.append;
			case "messages":
				return STREAM_STORAGE_OPERATIONS.messages;
			default:
				return STREAM_STORAGE_OPERATIONS.unknown;
		}
	}
}
