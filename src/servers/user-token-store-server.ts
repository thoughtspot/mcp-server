const ACTIVE_ORG_KEY = "active-org";
// Org-scoped token, minted once and shared across the user's sessions. Cleared
// when the active org changes.
const ORG_TOKEN_KEY = "active-org-token";
const TOKEN_STORE_KEY = "token-store";
// Refresh at 11h (token lives ~24h): a failed refresh leaves the next regular
// alarm at ~22h still inside the expiry window, a built-in second attempt — so
// the alarm re-arms on failure too.
const TOKEN_REFRESH_INTERVAL_MS = 11 * 60 * 60 * 1000;
// After this much inactivity the session is abandoned: stop refreshing and drop
// the token + active-org state so the user re-authenticates on return.
const SESSION_IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type TokenStore = {
	accessToken: string;
	refreshToken: string;
	instanceUrl: string;
	// Absolute epoch-ms expiry of the access token, if known.
	expiresAt?: number;
	// Absolute epoch-ms of the user's last tool call, for idle abandonment.
	lastSeenAt?: number;
};

/**
 * Per-user token/org Durable Object, separate from conversation storage and
 * addressed by the user's storage-key hash so one instance is shared across all
 * of the user's (fanned-out) MCP sessions. Owns the active org + its org-scoped
 * token, and the keep-warm cluster token (refreshed by an 11h alarm, abandoned
 * after 14 idle days). Routes: GET/POST /active-org, POST /active-org-token,
 * GET/POST /token-store, POST /touch.
 */
export class UserTokenStoreSQLite {
	constructor(
		private state: DurableObjectState,
		private env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		// Path shape mirrors the conversation DO: /storage/<id>/<operation>.
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

				// Clear the stored token only when the org id actually changes — NOT
				// when re-setting the same org (every cold connect does this), which
				// would race the fan-out and delete a token a sibling just minted.
				case "POST /active-org": {
					const body = (await request.json()) as {
						activeOrgId: string;
						orgToken?: string | null;
					};
					const previousOrgId =
						await this.state.storage.get<string>(ACTIVE_ORG_KEY);
					await this.state.storage.put<string>(
						ACTIVE_ORG_KEY,
						body.activeOrgId,
					);
					if (body.orgToken) {
						await this.state.storage.put<string>(ORG_TOKEN_KEY, body.orgToken);
					} else if (previousOrgId !== body.activeOrgId) {
						// Org actually changed — the old token no longer applies.
						await this.state.storage.delete(ORG_TOKEN_KEY);
					}
					return Response.json({ ok: true });
				}

				// Set (or, with an empty/missing token, clear) the org token without
				// touching the active org id.
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

	// Seed the token store and arm the refresh alarm if not already armed.
	// Idempotent: re-seeding updates tokens without stacking alarms.
	private async seedTokenStore(store: TokenStore): Promise<void> {
		// Seeding happens on connect, so it counts as activity.
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

	// Stamp last activity for idle detection, throttled to ~1/hour so rapid
	// fanned-out calls don't each write. No-op if there's no token store.
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

	// Refresh the stored access token (gettoken?refresh=true + X-Refresh-Token)
	// and re-arm. Past the idle TTL, abandon instead: drop the token + active-org
	// state and stop. On failure, re-arm anyway — the 11h/24h margin gives a second
	// attempt before expiry without bespoke backoff.
	private async refreshTokenStore(): Promise<void> {
		const store = await this.state.storage.get<TokenStore>(TOKEN_STORE_KEY);
		if (!store) {
			return;
		}

		// Idle past the TTL: abandon (delete state, do not re-arm).
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
			const expiresAt =
				data?.tokenExpiryDuration ?? data?.data?.tokenExpiryDuration;
			await this.state.storage.put<TokenStore>(TOKEN_STORE_KEY, {
				accessToken,
				refreshToken,
				instanceUrl: store.instanceUrl,
				expiresAt: typeof expiresAt === "number" ? expiresAt : undefined,
				lastSeenAt: store.lastSeenAt,
			});
			await this.state.storage.setAlarm(Date.now() + TOKEN_REFRESH_INTERVAL_MS);
		} catch (error) {
			console.error(
				"Token keep-warm refresh failed; will retry on next interval:",
				error instanceof Error ? error.message : String(error),
			);
			// Re-arm anyway; the stored token is left intact so reads work until then.
			await this.state.storage.setAlarm(Date.now() + TOKEN_REFRESH_INTERVAL_MS);
		}
	}

	// This DO's only alarm is the keep-warm refresh — no branching needed.
	async alarm(): Promise<void> {
		await this.refreshTokenStore();
	}
}
