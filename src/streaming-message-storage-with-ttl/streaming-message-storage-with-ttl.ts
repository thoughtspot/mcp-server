import type { Message, StreamingMessagesState } from "../thoughtspot/types";

/**
 * Minimal key-value storage interface used by StreamingMessagesStorageWithTtl.
 * Satisfied by both DurableObjectStorage (directly) and RemoteDurableObjectStorage.
 */
export interface KeyValueStorage {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	delete(keys: string[]): Promise<number>;
}

/*
 * Notes on race condition avoidance:
 * 1. You can only call initializeConversation on a conversationId that does not exist, or is
 *    already marked done. Trying to call it on a conversation not marked done will fail.
 * 2. We only expect one appendMessagesAndRestartTtl call at a time, because only one streaming
 *    request can be in progress at any given time. Therefore we do not need to design for allowing
 *    multiple concurrent appendMessagesAndRestartTtl calls for the same conversation.
 * 3. Multiple concurrent calls to getNewMessagesAndUpdateBookmark for the same conversation should
 *    not occur, but the system is capable of handling it. Two concurrent calls will return the
 *    same state and update the bookmark to the same new position.
 * 4. Calls to appendMessagesAndRestartTtl and getNewMessagesAndUpdateBookmark on the same
 *    conversation can occur concurrently and at any time:
 *    - If appendMessagesAndRestartTtl is made first and getNewMessagesAndUpdateBookmark interrupts
 *      it, then the latter will return the (internally consistent) state prior to the former call.
 *      The updated state from the former call will be returned by the next call to
 *      getNewMessagesAndUpdateBookmark, no different than if the updates happened to arrive a few
 *      moments later.
 *    - If getNewMessagesAndUpdateBookmark is made first and appendMessagesAndRestartTtl interrupts
 *      it, then the former may return the state prior to or after the latter call depending on the
 *      timing of the interruption. In either case, the returned state will be internally
 *      consistent.
 * 5. It is technically possible that onTimerTriggered can be called concurrently with another
 *    call. In those cases, it is possible the latter call will fail with conversation not found,
 *    similar to if onTimerTriggered had been called a few moments earlier. In other cases:
 *    - With appendMessagesAndRestartTtl: it is unlikely that the streaming response will have a
 *      30 minute gap between events. If this occurs, onTimerTriggered will delete the state but
 * 	    the appendMessagesAndRestartTtl call will recreate it. The bookmark will be deleted
 *      however, so the subsequent getNewMessagesAndUpdateBookmark call will return the entire
 *      conversation again, but the host agent should be able to handle that in this rare scenario.
 *    - With getNewMessagesAndUpdateBookmark: it is unlikely that the host agent will wait 30
 *      minutes before checking for conversation updates. Even if this occurs, it is possible that
 *      it will save a "ghost" bookmark for a conversation that is deleted, but that should not be
 *      a major issue. Any subsequent call will fail with conversation not found, and the bookmark
 *      will not interfere with future operations. The bookmark is only a single numerical value so
 *      the memory impact is also negligible.
 */

const DEFAULT_TTL_SECONDS = 30 * 60; // 30 minutes

type StreamingMessagesWithTtlState = StreamingMessagesState & {
	timerId: string;
};

export class StreamingMessagesStorageWithTtl {
	private storageCache = new Map<string, KeyValueStorage>();

	constructor(
		private storageFactory: (conversationId: string) => KeyValueStorage,
		private scheduleTimer: (
			delaySeconds: number,
			conversationId: string,
		) => Promise<string>,
		private cancelTimer: (timerId: string) => Promise<void>,
		private ttlSeconds = DEFAULT_TTL_SECONDS,
	) {}

	private storageFor(conversationId: string): KeyValueStorage {
		let storage = this.storageCache.get(conversationId);
		if (!storage) {
			storage = this.storageFactory(conversationId);
			this.storageCache.set(conversationId, storage);
		}
		return storage;
	}

	/*
	 * Initialize a conversation with the given ID. This can be a brand new conversation, or it can
	 * be priming an existing conversation which is already marked done for a followup message.
	 */
	public async initializeConversation(conversationId: string): Promise<void> {
		const storage = this.storageFor(conversationId);
		const streamingMessagesState: StreamingMessagesWithTtlState | undefined =
			await storage.get<StreamingMessagesWithTtlState>(conversationId);
		if (streamingMessagesState && !streamingMessagesState.isDone) {
			throw new Error("Conversation already exists and is not marked done");
		}

		await this.setConversationStateAndRestartTtl(
			conversationId,
			{
				messages: [],
				isDone: false,
			},
			streamingMessagesState?.timerId,
		);
		await storage.put<number>(`${conversationId}-bookmark`, 0);
	}

	public async appendMessagesAndRestartTtl(
		conversationId: string,
		newMessages: Message[],
		isDone = false,
	): Promise<void> {
		const oldState =
			await this.storageFor(conversationId).get<StreamingMessagesWithTtlState>(
				conversationId,
			);
		if (!oldState) {
			throw new Error("Conversation not found");
		}
		if (oldState.isDone) {
			throw new Error("Cannot append messages to a conversation marked done");
		}

		await this.setConversationStateAndRestartTtl(
			conversationId,
			{
				messages: [...(oldState?.messages ?? []), ...newMessages],
				isDone,
			},
			oldState.timerId,
		);
	}

	public async getNewMessagesAndUpdateBookmark(
		conversationId: string,
	): Promise<StreamingMessagesState> {
		const storage = this.storageFor(conversationId);
		const bookmark =
			(await storage.get<number>(`${conversationId}-bookmark`)) ?? 0;

		const streamingMessagesState: StreamingMessagesWithTtlState | undefined =
			await storage.get<StreamingMessagesWithTtlState>(conversationId);
		if (!streamingMessagesState) {
			throw new Error("Conversation not found");
		}

		await storage.put<number>(
			`${conversationId}-bookmark`,
			streamingMessagesState.messages.length,
		);

		const newMessages = streamingMessagesState.messages.slice(bookmark);
		return {
			messages: newMessages,
			isDone: streamingMessagesState.isDone,
		};
	}

	public async onTimerTriggered(conversationId: string): Promise<void> {
		await this.storageFor(conversationId).delete([
			conversationId,
			`${conversationId}-bookmark`,
		]);
		this.storageCache.delete(conversationId);
	}

	private async setConversationStateAndRestartTtl(
		conversationId: string,
		newState: StreamingMessagesState,
		oldTimerId?: string,
	): Promise<void> {
		if (oldTimerId) {
			await this.cancelTimer(oldTimerId);
		}

		const timerId = await this.scheduleTimer(this.ttlSeconds, conversationId);
		await this.storageFor(conversationId).put<StreamingMessagesWithTtlState>(
			conversationId,
			{
				...newState,
				timerId,
			},
		);
	}
}
