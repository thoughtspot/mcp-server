import type { KeyValueStorage } from "./streaming-message-storage-with-ttl";

/**
 * Implements KeyValueStorage by forwarding calls to the StorageHandler
 * Durable Object via its HTTP API. This allows StreamingMessagesStorageWithTtl
 * to store data in an isolated, dedicated DO per user rather than in the
 * MCP server DO's own storage.
 *
 * The stub should already be scoped to the correct user's DO instance
 * (i.e. resolved via idFromName(userGuid) by the caller).
 *
 * DO stubs ignore the hostname in the URL, so we use a placeholder base URL.
 */
export class RemoteDurableObjectStorage implements KeyValueStorage {
	private readonly baseUrl: string;

	constructor(
		private readonly stub: DurableObjectStub,
		userGuid: string,
	) {
		this.baseUrl = `https://internal/storage/${encodeURIComponent(userGuid)}`;
	}

	async get<T>(key: string): Promise<T | undefined> {
		const url = `${this.baseUrl}/get?key=${encodeURIComponent(key)}`;
		const response = await this.stub.fetch(url, { method: "GET" });
		if (!response.ok) {
			throw new Error(
				`StorageHandler GET failed: ${response.status} ${await response.text()}`,
			);
		}
		const { value } = await response.json<{ value: T | null }>();
		return value ?? undefined;
	}

	async put<T>(key: string, value: T): Promise<void> {
		const response = await this.stub.fetch(`${this.baseUrl}/put`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key, value }),
		});
		if (!response.ok) {
			throw new Error(
				`StorageHandler PUT failed: ${response.status} ${await response.text()}`,
			);
		}
	}

	async delete(keys: string[]): Promise<number> {
		const response = await this.stub.fetch(`${this.baseUrl}/delete`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keys }),
		});
		if (!response.ok) {
			throw new Error(
				`StorageHandler DELETE failed: ${response.status} ${await response.text()}`,
			);
		}
		const { deleted } = await response.json<{ deleted: number }>();
		return deleted;
	}
}
