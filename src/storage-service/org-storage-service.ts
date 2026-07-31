// Client for the per-user org/token Durable Object (UserTokenStoreSQLite,
// bound as USER_TOKEN_OBJECT). Owns the active-org selection and the keep-warm
// global cluster token. Kept separate from the Spotter conversation storage
// (StorageServiceClient) so the two surface areas stay isolated.
export class OrgStorageServiceClient {
	// Single per-user DO instance name; all org/token state lives under it.
	private static readonly STORAGE_STUB_ID = "__active_org__";

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

	private stubFor(id: string): DurableObjectStub {
		const doId = this.namespace.idFromName(
			`${this.accessTokenHashUrlSafe}:${id}`,
		);
		return this.namespace.get(doId);
	}

	private url(id: string, operation: string): string {
		return `https://internal/storage/${encodeURIComponent(id)}/${operation}`;
	}

	async getActiveOrgIdAndToken(): Promise<{
		activeOrgId: string | null;
		activeOrgToken: string | null;
	}> {
		const id = OrgStorageServiceClient.STORAGE_STUB_ID;
		const response = await this.stubFor(id).fetch(
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
			activeOrgToken: string | null;
		};
		return {
			activeOrgId: data.activeOrgId ?? null,
			activeOrgToken: data.activeOrgToken ?? null,
		};
	}

	async setActiveOrgIdAndToken(
		activeOrgId: string,
		orgToken?: string,
	): Promise<void> {
		const id = OrgStorageServiceClient.STORAGE_STUB_ID;
		const response = await this.stubFor(id).fetch(
			this.url(id, "active-org-id-and-token"),
			{
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({ activeOrgId, activeOrgToken: orgToken ?? null }),
			},
		);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Failed to set active org (${response.status}): ${body}`);
		}
	}

	async getGlobalTokenData(): Promise<{
		globalToken: string | null;
		globalTokenExpiresAt: number | null;
	}> {
		const id = OrgStorageServiceClient.STORAGE_STUB_ID;
		const response = await this.stubFor(id).fetch(
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
			globalTokenExpiresAt: number | null;
		};
	}

	async setGlobalTokenData(store: {
		globalToken: string;
		globalRefreshToken: string;
		instanceUrl: string;
		globalTokenExpiresAt?: number;
	}): Promise<void> {
		const id = OrgStorageServiceClient.STORAGE_STUB_ID;
		const response = await this.stubFor(id).fetch(
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

	async setLastSeen(): Promise<void> {
		const id = OrgStorageServiceClient.STORAGE_STUB_ID;
		const response = await this.stubFor(id).fetch(this.url(id, "last-seen"), {
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
}
