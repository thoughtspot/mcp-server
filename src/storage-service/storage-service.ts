import type { Message, StreamingMessagesState } from "../thoughtspot/types";

// Client for the conversation-storage and per-user token/org Durable Objects,
// talking to their stubs directly (bypassing the OAuth layer). The storage id is
// hash(user) + conversationId, so users can't reach each other's conversations.
export class StorageServiceClient {
	constructor(
		private readonly namespace: DurableObjectNamespace,
		private readonly accessTokenHashUrlSafe: string,
		// Optional so non-token callers still compile.
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

	// DO stubs ignore the hostname; a placeholder keeps the path parseable.
	private url(conversationId: string, operation: string): string {
		return `https://internal/storage/${encodeURIComponent(conversationId)}/${operation}`;
	}

	private static readonly ACTIVE_ORG_ID = "__active_org__";

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

	// Pass orgToken to commit id+token atomically (validated switch); omit it on the
	// postInit default path, where the prior token is cleared and re-minted lazily.
	async setActiveOrg(activeOrgId: string, orgToken?: string): Promise<void> {
		const id = StorageServiceClient.ACTIVE_ORG_ID;
		const response = await this.userStubFor(id).fetch(
			this.url(id, "active-org"),
			{
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({ activeOrgId, orgToken: orgToken ?? null }),
			},
		);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Failed to set active org (${response.status}): ${body}`);
		}
	}

	// Empty string clears the token (to evict a stale one before re-minting).
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

	// Read the keep-warm token (alarm-refreshed); accessToken is null if unseeded.
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

	// Seed the keep-warm token store + arm the refresh alarm. Idempotent per connect.
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

	// Record user activity for idle detection; throttled server-side.
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

	// Call before appending; also re-primes a done conversation for a follow-up.
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

	// Append messages and restart the TTL; isDone marks the conversation complete.
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

	// Return messages added since the last call (advancing a per-conversation
	// bookmark) plus whether the conversation is done.
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
