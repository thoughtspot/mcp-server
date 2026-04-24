import type { Message, StreamingMessagesState } from "../thoughtspot/types";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

const STATE_KEY = "streaming-messages-state";
const BOOKMARK_KEY = "streaming-messages-bookmark";

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
export class ConversationStorageServer {
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
		const operation = parts[3] ?? "";

		try {
			switch (`${request.method} /${operation}`) {
				case "POST /initialize": {
					await this.initializeConversation();
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
			const message = err instanceof Error ? err.message : String(err);
			console.error("Error handling conversation storage request:", message);
			return Response.json({ error: "Something went wrong" }, { status: 500 });
		}
	}

	/*
	 * Initialize the conversation. This can be a brand new conversation, or it can be priming an
	 * existing conversation which is already marked done for a followup message.
	 */
	private async initializeConversation(): Promise<void> {
		const existing =
			await this.state.storage.get<StreamingMessagesState>(STATE_KEY);
		if (existing && !existing.isDone) {
			throw new Error("Conversation already exists and is not marked done");
		}

		await this.setStateAndRestartTtl({ messages: [], isDone: false });
		await this.state.storage.put<number>(BOOKMARK_KEY, 0);
	}

	private async appendMessagesAndRestartTtl(
		newMessages: Message[],
		isDone = false,
	): Promise<void> {
		const oldState =
			await this.state.storage.get<StreamingMessagesState>(STATE_KEY);
		if (!oldState) {
			throw new Error("Conversation not found");
		}
		if (oldState.isDone) {
			throw new Error("Cannot append messages to a conversation marked done");
		}

		await this.setStateAndRestartTtl({
			messages: [...oldState.messages, ...newMessages],
			isDone,
		});
	}

	private async getNewMessagesAndUpdateBookmark(): Promise<StreamingMessagesState> {
		const bookmark = (await this.state.storage.get<number>(BOOKMARK_KEY)) ?? 0;

		const conversationState =
			await this.state.storage.get<StreamingMessagesState>(STATE_KEY);
		if (!conversationState) {
			throw new Error("Conversation not found");
		}

		await this.state.storage.put<number>(
			BOOKMARK_KEY,
			conversationState.messages.length,
		);

		return {
			messages: conversationState.messages.slice(bookmark),
			isDone: conversationState.isDone,
		};
	}

	private async setStateAndRestartTtl(
		newState: StreamingMessagesState,
	): Promise<void> {
		// Cancel any existing alarm and schedule a fresh one
		await this.state.storage.deleteAlarm();
		await this.state.storage.setAlarm(Date.now() + DEFAULT_TTL_MS);

		await this.state.storage.put<StreamingMessagesState>(STATE_KEY, newState);
	}

	async alarm(): Promise<void> {
		await this.state.storage.delete([STATE_KEY, BOOKMARK_KEY]);
	}
}
