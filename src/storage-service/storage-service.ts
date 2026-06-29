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
		// Namespace for the per-user token/org Durable Object (UserTokenStoreSQLite),
		// separate from the conversation namespace. Optional only so existing
		// callers/tests that don't use token/org methods keep compiling.
		private readonly userTokenNamespace?: DurableObjectNamespace,
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

	// Stub for the per-user token/org DO instance, addressed by the user's
	// storage-key hash on the dedicated UserTokenStoreSQLite namespace.
	private userStubFor(id: string): DurableObjectStub {
		const ns = this.userTokenNamespace;
		if (!ns) {
			throw new Error(
				"StorageServiceClient: userTokenNamespace not configured for token/org operation",
			);
		}
		const doId = ns.idFromName(`${this.accessTokenHashUrlSafe}:${id}`);
		return ns.get(doId);
	}

	// DO stubs ignore the hostname; we use a placeholder so the path is parsed correctly.
	private url(conversationId: string, operation: string): string {
		return `https://internal/storage/${encodeURIComponent(conversationId)}/${operation}`;
	}

	// Reserved pseudo-id for the per-user token/org DO instance. Uses the same
	// hash-namespaced addressing as conversations, but on the dedicated
	// UserTokenStoreSQLite namespace; holds active org + keep-warm token, shared
	// across the user's sessions.
	private static readonly ACTIVE_ORG_ID = "__active_org__";

	/**
	 * Read the user's active org id and its (lazily-minted, shared) org token.
	 * Either may be null: no active org set, or no token minted yet.
	 */
	async getActiveOrg(): Promise<{
		activeOrgId: string | null;
		orgToken: string | null;
	}> {
		const id = StorageServiceClient.ACTIVE_ORG_ID;
		const response = await this.userStubFor(id).fetch(
			this.url(id, "active-org"),
			{
				method: "GET",
				headers: this.headers(),
			},
		);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Failed to get active org (${response.status}): ${body}`);
		}
		const data = (await response.json()) as {
			activeOrgId: string | null;
			orgToken: string | null;
		};
		return {
			activeOrgId: data.activeOrgId ?? null,
			orgToken: data.orgToken ?? null,
		};
	}

	/**
	 * Persist the user's active org id (shared across their sessions). Changing the
	 * active org clears any stored org token (it belonged to the prior org); the
	 * token is re-minted lazily on next use.
	 */
	async setActiveOrg(activeOrgId: string): Promise<void> {
		const id = StorageServiceClient.ACTIVE_ORG_ID;
		const response = await this.userStubFor(id).fetch(
			this.url(id, "active-org"),
			{
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({ activeOrgId }),
			},
		);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Failed to set active org (${response.status}): ${body}`);
		}
	}

	/**
	 * Persist a lazily-minted org token for the current active org, so other
	 * sessions/DOs reuse it instead of re-minting. Passing an empty string clears
	 * the stored token (used to evict a stale org token before re-minting).
	 */
	async setActiveOrgToken(orgToken: string): Promise<void> {
		const id = StorageServiceClient.ACTIVE_ORG_ID;
		const response = await this.userStubFor(id).fetch(
			this.url(id, "active-org-token"),
			{
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({ orgToken: orgToken || null }),
			},
		);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`Failed to set active org token (${response.status}): ${body}`,
			);
		}
	}

	/**
	 * Read the keep-warm TS access token (kept fresh by the DO alarm). Returns null
	 * if no token store has been seeded yet. Lives on the same per-user instance as
	 * the active org.
	 */
	async getTokenStore(): Promise<{
		accessToken: string | null;
		expiresAt: number | null;
	}> {
		const id = StorageServiceClient.ACTIVE_ORG_ID;
		const response = await this.userStubFor(id).fetch(
			this.url(id, "token-store"),
			{
				method: "GET",
				headers: this.headers(),
			},
		);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`Failed to get token store (${response.status}): ${body}`,
			);
		}
		return (await response.json()) as {
			accessToken: string | null;
			expiresAt: number | null;
		};
	}

	/**
	 * Seed the keep-warm token store and arm the refresh alarm. Idempotent: safe to
	 * call on every connect; it updates the tokens and only arms the alarm once.
	 */
	async seedTokenStore(store: {
		accessToken: string;
		refreshToken: string;
		instanceUrl: string;
		expiresAt?: number;
	}): Promise<void> {
		const id = StorageServiceClient.ACTIVE_ORG_ID;
		const response = await this.userStubFor(id).fetch(
			this.url(id, "token-store"),
			{
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify(store),
			},
		);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`Failed to seed token store (${response.status}): ${body}`,
			);
		}
	}

	/**
	 * Record user activity (a tool call) for idle-session detection. Best-effort
	 * and throttled server-side; safe to call on every tool invocation. Lives on
	 * the same per-user instance as the active org / token store.
	 */
	async touchLastSeen(): Promise<void> {
		const id = StorageServiceClient.ACTIVE_ORG_ID;
		const response = await this.userStubFor(id).fetch(this.url(id, "touch"), {
			method: "POST",
			headers: this.headers(),
		});
		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`Failed to touch last-seen (${response.status}): ${body}`,
			);
		}
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
