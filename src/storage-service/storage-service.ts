import type { Message, StreamingMessagesState } from "../thoughtspot/types";

export class StorageServiceClient {
	constructor(
		private readonly namespace: DurableObjectNamespace,
		private readonly accessTokenHashUrlSafe: string,
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
			this.url(id, "active-org-id-and-token"),
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

	async setActiveOrg(activeOrgId: string, orgToken?: string): Promise<void> {
		const id = StorageServiceClient.ACTIVE_ORG_ID;
		const response = await this.userStubFor(id).fetch(
			this.url(id, "active-org-id-and-token"),
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

	async getTokenStore(): Promise<{
		globalToken: string | null;
		expiresAt: number | null;
	}> {
		const id = StorageServiceClient.ACTIVE_ORG_ID;
		const response = await this.userStubFor(id).fetch(
			this.url(id, "global-token-data"),
			{
				method: "GET",
				headers: this.headers(),
			},
		);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`Failed to get global token data (${response.status}): ${body}`,
			);
		}
		return (await response.json()) as {
			globalToken: string | null;
			expiresAt: number | null;
		};
	}

	async seedTokenStore(store: {
		globalToken: string;
		globalRefreshToken: string;
		instanceUrl: string;
		expiresAt?: number;
	}): Promise<void> {
		const id = StorageServiceClient.ACTIVE_ORG_ID;
		const response = await this.userStubFor(id).fetch(
			this.url(id, "global-token-data"),
			{
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify(store),
			},
		);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`Failed to seed global token data (${response.status}): ${body}`,
			);
		}
	}

	async touchLastSeen(): Promise<void> {
		const id = StorageServiceClient.ACTIVE_ORG_ID;
		const response = await this.userStubFor(id).fetch(
			this.url(id, "last-seen"),
			{
				method: "POST",
				headers: this.headers(),
			},
		);
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
