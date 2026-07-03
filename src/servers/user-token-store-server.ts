const ACTIVE_ORG_KEY = "active-org";
const ORG_TOKEN_KEY = "active-org-token";
const TOKEN_STORE_KEY = "token-store";
// 11h refresh on a ~24h token: a failed attempt re-arms at ~22h, still inside the
// expiry window, giving a second chance before expiry.
const TOKEN_REFRESH_INTERVAL_MS = 11 * 60 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type TokenStore = {
	accessToken: string;
	refreshToken: string;
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
				case "GET /active-org": {
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
				case "POST /active-org": {
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
					await this.state.storage.put<string>(
						ACTIVE_ORG_KEY,
						body.activeOrgId,
					);
					if (previousOrgId !== body.activeOrgId) {
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

				case "GET /token-store": {
					const store =
						(await this.state.storage.get<TokenStore>(TOKEN_STORE_KEY)) ?? null;
					return Response.json({
						accessToken: store?.accessToken ?? null,
						expiresAt: store?.expiresAt ?? null,
					});
				}

				case "POST /token-store": {
					const body = (await request.json()) as TokenStore;
					await this.seedTokenStore(body);
					return Response.json({ ok: true });
				}

				case "POST /touch": {
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

	// Idempotent: re-seeding updates tokens without stacking alarms.
	private async seedTokenStore(store: TokenStore): Promise<void> {
		const toStore: TokenStore = {
			...store,
			lastSeenAt: store.lastSeenAt ?? Date.now(),
		};
		await this.state.storage.put<TokenStore>(TOKEN_STORE_KEY, toStore);
		const existingAlarm = await this.state.storage.getAlarm();
		if (existingAlarm == null) {
			await this.state.storage.setAlarm(Date.now() + TOKEN_REFRESH_INTERVAL_MS);
		}
	}

	// Stamp last activity, throttled to ~1/hour so fanned-out calls don't each write.
	private async touchLastSeen(): Promise<void> {
		const store = await this.state.storage.get<TokenStore>(TOKEN_STORE_KEY);
		if (!store) {
			return;
		}
		const now = Date.now();
		const THROTTLE_MS = 60 * 60 * 1000; // 1 hour
		if (store.lastSeenAt && now - store.lastSeenAt < THROTTLE_MS) {
			return;
		}
		await this.state.storage.put<TokenStore>(TOKEN_STORE_KEY, {
			...store,
			lastSeenAt: now,
		});
	}

	// Refresh the keep-warm token and re-arm. Past the idle TTL, abandon instead.
	private async refreshTokenStore(): Promise<void> {
		const store = await this.state.storage.get<TokenStore>(TOKEN_STORE_KEY);
		if (!store) {
			return;
		}

		if (
			store.lastSeenAt != null &&
			Date.now() - store.lastSeenAt >= SESSION_IDLE_TTL_MS
		) {
			console.log("Keep-warm session idle past TTL; abandoning");
			await this.state.storage.delete([
				TOKEN_STORE_KEY,
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
						Authorization: `Bearer ${store.accessToken}`,
						"X-Refresh-Token": store.refreshToken,
					},
				},
			);
			if (!response.ok) {
				const text = await response.text();
				throw new Error(`status ${response.status}: ${text}`);
			}
			const data = (await response.json()) as any;
			const accessToken = data?.token ?? data?.data?.token;
			if (!accessToken || typeof accessToken !== "string") {
				throw new Error("no token in refresh response");
			}
			const refreshToken =
				data?.refreshToken ?? data?.data?.refreshToken ?? store.refreshToken;
			const newExpiresAt =
				data?.tokenExpiryDuration ?? data?.data?.tokenExpiryDuration;
			await this.state.storage.put<TokenStore>(TOKEN_STORE_KEY, {
				accessToken,
				refreshToken,
				instanceUrl: store.instanceUrl,
				// Keep the prior expiry if the response omits one.
				expiresAt:
					typeof newExpiresAt === "number" ? newExpiresAt : store.expiresAt,
				lastSeenAt: store.lastSeenAt,
			});
			await this.state.storage.setAlarm(Date.now() + TOKEN_REFRESH_INTERVAL_MS);
		} catch (error) {
			console.error(
				"Token keep-warm refresh failed; will retry on next interval:",
				error instanceof Error ? error.message : String(error),
			);
			// Re-arm anyway; the stored token stays intact so reads work until then.
			await this.state.storage.setAlarm(Date.now() + TOKEN_REFRESH_INTERVAL_MS);
		}
	}

	async alarm(): Promise<void> {
		await this.refreshTokenStore();
	}
}
