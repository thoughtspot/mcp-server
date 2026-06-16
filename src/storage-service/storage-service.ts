import type { ConversationMetadata } from "../servers/conversation-storage-server";
import type { Message, StreamingMessagesState } from "../thoughtspot/types";

/**
 * Client for the ConversationStorageServer Durable Object.
 *
 * Communicates directly with the DO via its stub (bypassing the OAuth layer), mapping to the
 * following HTTP endpoints exposed by the server:
 *   POST  /storage/<storageId>/initialize —> initializeConversation
 *   POST  /storage/<storageId>/append     —> appendMessagesAndRestartTtl
 *   GET   /storage/<storageId>/messages   —> getNewMessagesAndUpdateBookmark
 *   GET   /storage/<storageId>/metadata   —> getMetadata
 *   PATCH /storage/<storageId>/metadata   —> mergeMetadata
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
	 * Retrieve the metadata stored for this conversation. Throws if the conversation is unknown.
	 */
	async getMetadata<T extends ConversationMetadata = ConversationMetadata>(
		conversationId: string,
	): Promise<T> {
		const response = await this.stubFor(conversationId).fetch(
			this.url(conversationId, "metadata"),
			{ method: "GET", headers: this.headers() },
		);

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Failed to get conversation metadata (${response.status}): ${text}`,
			);
		}

		return response.json() as Promise<T>;
	}

	/**
	 * Shallow-merge a partial metadata patch into the existing metadata. Returns the merged metadata.
	 */
	async updateMetadata<T extends ConversationMetadata = ConversationMetadata>(
		conversationId: string,
		patch: Partial<T>,
	): Promise<T> {
		const response = await this.stubFor(conversationId).fetch(
			this.url(conversationId, "metadata"),
			{
				method: "PATCH",
				headers: this.headers(),
				body: JSON.stringify(patch),
			},
		);

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Failed to update conversation metadata (${response.status}): ${text}`,
			);
		}

		return response.json() as Promise<T>;
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
		return this.appendEvents(conversationId, messages, isDone);
	}

	/**
	 * Retrieve all messages that have been added since the last call to this method
	 * (tracked via a per-conversation bookmark) and advance the bookmark.
	 * Also returns whether the conversation has been marked done.
	 */
	async getNewMessages(
		conversationId: string,
	): Promise<StreamingMessagesState> {
		return this.getNewEvents<Message>(conversationId);
	}

	/**
	 * Type-generic variant of `appendMessages`. The DO stores entries opaquely under indexed keys
	 * — the typed wrapper exists so SpotterViz can stream `SpotterVizEvent` objects through the
	 * same bookmark / TTL machinery used for spotter `Message` objects without leaking the
	 * SpotterViz type into the spotter API.
	 */
	async appendEvents<T>(
		conversationId: string,
		events: T[],
		isDone = false,
	): Promise<void> {
		// Wire field stays "messages" so the DO route is shared between the two callers.
		const body = { messages: events, isDone };

		const response = await this.stubFor(conversationId).fetch(
			this.url(conversationId, "append"),
			{ method: "POST", headers: this.headers(), body: JSON.stringify(body) },
		);

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to append events (${response.status}): ${text}`);
		}
	}

	/**
	 * Type-generic variant of `getNewMessages`. See `appendEvents` for the rationale.
	 */
	async getNewEvents<T>(
		conversationId: string,
	): Promise<{ messages: T[]; isDone: boolean }> {
		const response = await this.stubFor(conversationId).fetch(
			this.url(conversationId, "messages"),
			{ method: "GET", headers: this.headers() },
		);

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to get events (${response.status}): ${text}`);
		}

		return response.json() as Promise<{ messages: T[]; isDone: boolean }>;
	}
}
