const ACTIVE_ORG_KEY = "active-org-id";
const ORG_TOKEN_KEY = "active-org-token";
const GLOBAL_TOKEN_KEY = "global-token-details";
const GLOBAL_TOKEN_REFRESH_INTERVAL_MS = 11 * 60 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type GlobalTokenData = {
	globalToken: string;
	globalRefreshToken: string;
	instanceUrl: string;
	expiresAt?: number;
	lastSeenAt?: number;
};

// Per-user token/org DO, shared across the user's fanned-out sessions via the
// storage-key hash. Owns the active org + org token and the keep-warm cluster
// token (11h refresh alarm, abandoned after 14 idle days).
export class UserTokenStoreSQLite {
	constructor(
		private state: DurableObjectState,
		private env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const parts = url.pathname.split("/");
		const operation = parts[3] ?? "";

		try {
			switch (`${request.method} /${operation}`) {
				case "GET /active-org-id-and-token": {
					const [activeOrgId, orgToken] = await Promise.all([
						this.state.storage.get<string>(ACTIVE_ORG_KEY),
						this.state.storage.get<string>(ORG_TOKEN_KEY),
					]);
					return Response.json({
						activeOrgId: activeOrgId ?? null,
						orgToken: orgToken ?? null,
					});
				}

				// Clear the token only on a real org change; re-setting the same org
				// (every cold connect) must not delete a token a sibling just minted.
				case "POST /active-org-id-and-token": {
					const body = (await request.json()) as {
						activeOrgId: string;
						orgToken?: string | null;
					};
					if (body.orgToken) {
						await this.state.storage.put({
							[ACTIVE_ORG_KEY]: body.activeOrgId,
							[ORG_TOKEN_KEY]: body.orgToken,
						});
						return Response.json({ ok: true });
					}
					const previousOrgId =
						await this.state.storage.get<string>(ACTIVE_ORG_KEY);
					if (previousOrgId !== body.activeOrgId) {
						await this.state.storage.put<string>(
							ACTIVE_ORG_KEY,
							body.activeOrgId,
						);
						await this.state.storage.delete(ORG_TOKEN_KEY);
					}
					return Response.json({ ok: true });
				}

				case "POST /active-org-token": {
					const body = (await request.json()) as { orgToken?: string | null };
					if (body.orgToken) {
						await this.state.storage.put<string>(ORG_TOKEN_KEY, body.orgToken);
					} else {
						await this.state.storage.delete(ORG_TOKEN_KEY);
					}
					return Response.json({ ok: true });
				}

				case "GET /global-token-data": {
					const store =
						(await this.state.storage.get<GlobalTokenData>(GLOBAL_TOKEN_KEY)) ??
						null;
					return Response.json({
						globalToken: store?.globalToken ?? null,
						expiresAt: store?.expiresAt ?? null,
					});
				}

				case "POST /global-token-data": {
					const body = (await request.json()) as GlobalTokenData;
					await this.seedGlobalToken(body);
					return Response.json({ ok: true });
				}

				case "POST /last-seen": {
					await this.touchLastSeen();
					return Response.json({ ok: true });
				}

				default:
					return new Response("Not Found", { status: 404 });
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("Error handling user token-store request:", message);
			return Response.json({ error: message }, { status: 500 });
		}
	}

	private async seedGlobalToken(store: GlobalTokenData): Promise<void> {
		const existing =
			await this.state.storage.get<GlobalTokenData>(GLOBAL_TOKEN_KEY);
		const existingAlarm = await this.state.storage.getAlarm();
		if (existing?.globalToken === store.globalToken) {
			if (existingAlarm == null) {
				await this.state.storage.setAlarm(
					Date.now() + GLOBAL_TOKEN_REFRESH_INTERVAL_MS,
				);
			}
			return;
		}
		const toStore: GlobalTokenData = {
			...store,
			lastSeenAt: existing?.lastSeenAt ?? Date.now(),
		};
		await this.state.storage.put<GlobalTokenData>(GLOBAL_TOKEN_KEY, toStore);
		if (existingAlarm == null) {
			await this.state.storage.setAlarm(
				Date.now() + GLOBAL_TOKEN_REFRESH_INTERVAL_MS,
			);
		}
	}

	private async touchLastSeen(): Promise<void> {
		const store =
			await this.state.storage.get<GlobalTokenData>(GLOBAL_TOKEN_KEY);
		if (!store) {
			return;
		}
		const now = Date.now();
		const THROTTLE_MS = 60 * 60 * 1000; // 1 hour
		if (store.lastSeenAt && now - store.lastSeenAt < THROTTLE_MS) {
			return;
		}
		await this.state.storage.put<GlobalTokenData>(GLOBAL_TOKEN_KEY, {
			...store,
			lastSeenAt: now,
		});
	}

	private async refreshGlobalToken(): Promise<void> {
		const store =
			await this.state.storage.get<GlobalTokenData>(GLOBAL_TOKEN_KEY);
		if (!store) {
			return;
		}

		if (
			store.lastSeenAt != null &&
			Date.now() - store.lastSeenAt >= SESSION_IDLE_TTL_MS
		) {
			console.log("Keep-warm session idle past TTL; abandoning");
			await this.state.storage.delete([
				GLOBAL_TOKEN_KEY,
				ACTIVE_ORG_KEY,
				ORG_TOKEN_KEY,
			]);
			return;
		}

		try {
			const response = await fetch(
				`${store.instanceUrl}/callosum/v1/session/v2/gettoken?refresh=true`,
				{
					method: "GET",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
						"user-agent": "ThoughtSpot-ts-client",
						Authorization: `Bearer ${store.globalToken}`,
						"X-Refresh-Token": store.globalRefreshToken,
					},
				},
			);
			if (!response.ok) {
				const text = await response.text();
				throw new Error(`status ${response.status}: ${text}`);
			}
			const data = (await response.json()) as any;
			const globalToken = data?.token ?? data?.data?.token;
			if (!globalToken || typeof globalToken !== "string") {
				throw new Error("no token in refresh response");
			}
			const globalRefreshToken =
				data?.refreshToken ??
				data?.data?.refreshToken ??
				store.globalRefreshToken;
			const newExpiresAt =
				data?.tokenExpiryDuration ?? data?.data?.tokenExpiryDuration;
			await this.state.storage.put<GlobalTokenData>(GLOBAL_TOKEN_KEY, {
				globalToken,
				globalRefreshToken,
				instanceUrl: store.instanceUrl,
				// Keep the prior expiry if the response omits one.
				expiresAt:
					typeof newExpiresAt === "number" ? newExpiresAt : store.expiresAt,
				lastSeenAt: store.lastSeenAt,
			});
			await this.state.storage.setAlarm(
				Date.now() + GLOBAL_TOKEN_REFRESH_INTERVAL_MS,
			);
		} catch (error) {
			console.error(
				"Token keep-warm refresh failed; will retry on next interval:",
				error instanceof Error ? error.message : String(error),
			);
			await this.state.storage.setAlarm(
				Date.now() + GLOBAL_TOKEN_REFRESH_INTERVAL_MS,
			);
		}
	}

	async alarm(): Promise<void> {
		await this.refreshGlobalToken();
	}
}
