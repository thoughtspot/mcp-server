import type { Message, StreamingMessagesState } from "../thoughtspot/types";

/**
 * Client for the ConversationStorageServer Durable Object.
 *
 * Provides typed methods for each HTTP endpoint exposed by the server:
 *   POST  /storage/<conversationId>/initialize —> initializeConversation
 *   POST  /storage/<conversationId>/append     —> appendMessagesAndRestartTtl
 *   GET   /storage/<conversationId>/messages   —> getNewMessagesAndUpdateBookmark
 */
export class StorageServiceClient {
	constructor(
		private readonly baseUrl: string,
		private readonly authToken: string,
	) {}

	private headers(): HeadersInit {
		return {
			"Content-Type": "application/json",
			Accept: "application/json",
			Authorization: `Bearer ${this.authToken}`,
		};
	}

	private url(conversationId: string, operation: string): string {
		return `${this.baseUrl}/storage/${encodeURIComponent(conversationId)}/${operation}`;
	}

	/**
	 * Initialize a conversation. Must be called before appending messages.
	 * Can also be called on an existing conversation that is already marked done,
	 * to prime it for a follow-up message.
	 */
	async initializeConversation(conversationId: string): Promise<void> {
		const response = await fetch(this.url(conversationId, "initialize"), {
			method: "POST",
			headers: this.headers(),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`Failed to initialize conversation (${response.status}): ${body}`,
			);
		}
	}

	/**
	 * Append new messages to a conversation and restart its TTL.
	 * Optionally mark the conversation as done.
	 */
	async appendMessages(
		conversationId: string,
		messages: Message[],
		isDone = false,
	): Promise<void> {
		const body: StreamingMessagesState = { messages, isDone };

		const response = await fetch(this.url(conversationId, "append"), {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Failed to append messages (${response.status}): ${text}`,
			);
		}
	}

	/**
	 * Retrieve all messages that have been added since the last call to this method
	 * (tracked via a per-conversation bookmark) and advance the bookmark.
	 * Also returns whether the conversation has been marked done.
	 */
	async getNewMessages(
		conversationId: string,
	): Promise<StreamingMessagesState> {
		const response = await fetch(this.url(conversationId, "messages"), {
			method: "GET",
			headers: this.headers(),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to get messages (${response.status}): ${text}`);
		}

		return response.json() as Promise<StreamingMessagesState>;
	}
}
