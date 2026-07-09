import type { Message, StreamingMessagesState } from "../thoughtspot/types";

/**
 * Client for the ConversationStorageServer Durable Object.
 *
 * Communicates directly with the DO via its stub (bypassing the OAuth layer), mapping to the
 * following HTTP endpoints exposed by the server:
 *   POST  /storage/<storageId>/initialize —> initializeConversation
 *   POST  /storage/<storageId>/append     —> appendMessagesAndRestartTtl
 *   GET   /storage/<storageId>/messages   —> getNewMessagesAndUpdateBookmark
 *
 * The storageId is derived by taking a hash of the user's access token and combining it with the
 * conversationId, to ensure no users can access each other's conversations.
 */
export class StorageServiceClient {
	constructor(
		private readonly namespace: DurableObjectNamespace,
		private readonly accessTokenHashUrlSafe: string,
	) {}

	private headers(): HeadersInit {
		return {
			"Content-Type": "application/json",
			Accept: "application/json",
		};
	}

	private stubFor(conversationId: string): DurableObjectStub {
		const id = this.namespace.idFromName(
			`${this.accessTokenHashUrlSafe}:${conversationId}`,
		);
		return this.namespace.get(id);
	}

	// DO stubs ignore the hostname; we use a placeholder so the path is parsed correctly.
	private url(conversationId: string, operation: string): string {
		return `https://internal/storage/${encodeURIComponent(conversationId)}/${operation}`;
	}

	/**
	 * Initialize a conversation. Must be called before appending messages.
	 * Can also be called on an existing conversation that is already marked done,
	 * to prime it for a follow-up message.
	 */
	async initializeConversation(conversationId: string): Promise<void> {
		const response = await this.stubFor(conversationId).fetch(
			this.url(conversationId, "initialize"),
			{ method: "POST", headers: this.headers() },
		);

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

		const response = await this.stubFor(conversationId).fetch(
			this.url(conversationId, "append"),
			{ method: "POST", headers: this.headers(), body: JSON.stringify(body) },
		);

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
		const response = await this.stubFor(conversationId).fetch(
			this.url(conversationId, "messages"),
			{ method: "GET", headers: this.headers() },
		);

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to get messages (${response.status}): ${text}`);
		}

		return response.json() as Promise<StreamingMessagesState>;
	}
}
