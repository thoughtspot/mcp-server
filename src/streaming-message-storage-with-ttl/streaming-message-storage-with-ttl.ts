import type { StreamingMessagesState } from "../thoughtspot/types";

const DEFAULT_TTL_SECONDS = 30 * 60; // 30 minutes

type StreamingMessagesWithTtlState = StreamingMessagesState & {
	timerId: string;
};

export class StreamingMessagesStorageWithTtl {
	constructor(
		private storage: DurableObjectStorage,
		private scheduleTimer: (
			delaySeconds: number,
			conversationId: string,
		) => Promise<string>,
		private cancelTimer: (timerId: string) => Promise<void>,
		private ttlSeconds = DEFAULT_TTL_SECONDS,
	) {}

	public async appendMessagesAndRestartTtl(
		conversationId: string,
		newMessages: string[],
		isDone = false,
	): Promise<void> {
		const oldState: StreamingMessagesWithTtlState | undefined =
			await this.storage.get(conversationId);
		if (oldState?.timerId) {
			await this.cancelTimer(oldState.timerId);
		}

		const timerId = await this.scheduleTimer(this.ttlSeconds, conversationId);
		await this.storage.put(conversationId, {
			messages: [...(oldState?.messages ?? []), ...newMessages],
			isDone,
			timerId,
		});
	}

	public async getNewMessagesAndUpdateBookmark(
		conversationId: string,
	): Promise<StreamingMessagesState> {
		const bookmark: number =
			(await this.storage.get(`${conversationId}-bookmark`)) ?? 0;

		const streamingMessagesState: StreamingMessagesWithTtlState | undefined =
			await this.storage.get(conversationId);
		if (!streamingMessagesState) {
			throw new Error("State not found");
		}

		await this.storage.put(
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
		await this.storage.delete([conversationId, `${conversationId}-bookmark`]);
	}
}
