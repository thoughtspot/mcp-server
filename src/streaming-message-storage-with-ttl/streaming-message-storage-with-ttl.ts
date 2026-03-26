import type { Message, StreamingMessagesState } from "../thoughtspot/types";

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
		newMessages: Message[],
		isDone = false,
	): Promise<void> {
		const oldState =
			await this.storage.get<StreamingMessagesWithTtlState>(conversationId);
		if (oldState?.timerId) {
			await this.cancelTimer(oldState.timerId);
		}

		const timerId = await this.scheduleTimer(this.ttlSeconds, conversationId);
		await this.storage.put<StreamingMessagesWithTtlState>(conversationId, {
			messages: [...(oldState?.messages ?? []), ...newMessages],
			isDone,
			timerId,
		});
	}

	public async getNewMessagesAndUpdateBookmark(
		conversationId: string,
	): Promise<StreamingMessagesState> {
		const bookmark =
			(await this.storage.get<number>(`${conversationId}-bookmark`)) ?? 0;

		const streamingMessagesState: StreamingMessagesWithTtlState | undefined =
			await this.storage.get<StreamingMessagesWithTtlState>(conversationId);
		if (!streamingMessagesState) {
			throw new Error("State not found");
		}

		await this.storage.put<number>(
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
