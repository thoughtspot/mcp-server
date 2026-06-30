// Storage keys for the per-user token/org state. This DO instance is addressed
// by the user's storage-key hash (NOT a conversation id), so all of the user's
// MCP sessions/DOs share one instance.
const ACTIVE_ORG_KEY = "active-org";
// Org-scoped bearer token for the active org, stored alongside it so it is
// minted once and shared across all of the user's MCP sessions/DOs (rather than
// each fanned-out DO re-minting). Cleared when the active org changes.
const ORG_TOKEN_KEY = "active-org-token";

// Keep-warm token store. The TS access token can only be refreshed while it is
// still valid (the refresh call needs a live access token + the refresh token),
// so we proactively re-mint it on an alarm well before the ~24h expiry. This
// keeps the token alive even if the user is absent for days.
const TOKEN_STORE_KEY = "token-store";
// Refresh interval. The TS access token expires at ~24h; refreshing at 11h means
// that if one refresh fails, the NEXT regular alarm (another 11h later, at ~22h
// elapsed) still fires before the 24h expiry — i.e. the 11h cadence builds in a
// second attempt without any special backoff logic. The alarm therefore re-arms
// on failure too (not just success).
const TOKEN_REFRESH_INTERVAL_MS = 11 * 60 * 60 * 1000; // 11 hours
// If the user has not made a tool call for this long, the keep-warm session is
// abandoned: we stop refreshing and delete the token + active-org state, so the
// user re-authenticates on their next use (and we stop spending refresh calls on
// a user who is gone). Caps the per-user keep-warm cost at ~14 days of absence.
const SESSION_IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export type TokenStore = {
	accessToken: string;
	refreshToken: string;
	instanceUrl: string;
	// Absolute epoch-ms expiry of the access token, if known.
	expiresAt?: number;
	// Absolute epoch-ms of the user's last tool call (activity). Used to abandon
	// the keep-warm session after SESSION_IDLE_TTL_MS of inactivity.
	lastSeenAt?: number;
};

/**
 * A Durable Object that holds the per-user token/org state, separate from the
 * (ephemeral, per-conversation) message storage. Addressed by the user's
 * storage-key hash, so a single instance is shared across all of the user's MCP
 * sessions/DOs. It owns:
 *   - the active org id + its lazily-minted, shared org-scoped token
 *   - the keep-warm cluster-wide token store, kept fresh by an 11h alarm and
 *     abandoned after 14 days of inactivity
 *
 * The parent worker routes requests here via /storage/<hash:__active_org__> and
 * this DO handles:
 *   GET/POST /active-org        — read/set the active org (+ optional token)
 *   POST     /active-org-token  — set/clear the active org's token
 *   GET/POST /token-store       — read/seed the keep-warm token
 *   POST     /touch             — record user activity (idle detection)
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
				// Active-org state. No TTL: it must persist until the user switches
				// again or reauthenticates (a new login yields a new hash).
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

				// Set the active org. An explicit orgToken in the body is stored as-is.
				// Otherwise the stored token is invalidated ONLY when the org id is
				// actually changing — a token belongs to a specific org. We must NOT
				// clear it when re-setting the SAME org id (which happens on every cold
				// connect, where postInit defaults the active org to the current org):
				// doing so would race the fan-out, deleting a token another session just
				// minted and forcing a re-mint storm.
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

				// Persist a lazily-minted org token for the current active org without
				// changing the active org id. An empty/missing token clears the stored
				// token (used to evict a stale org token before re-minting).
				case "POST /active-org-token": {
					const body = (await request.json()) as { orgToken?: string | null };
					if (body.orgToken) {
						await this.state.storage.put<string>(ORG_TOKEN_KEY, body.orgToken);
					} else {
						await this.state.storage.delete(ORG_TOKEN_KEY);
					}
					return Response.json({ ok: true });
				}

				// Keep-warm token store. GET returns the current (alarm-refreshed) TS
				// token; POST seeds it and arms the refresh alarm if not already armed.
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

				// Record user activity (called on each tool call) so the keep-warm
				// alarm can abandon idle sessions. Throttled to one write per hour to
				// avoid a storage write on every fanned-out call.
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

	/*
	 * Seed the keep-warm token store and arm the refresh alarm if it isn't already
	 * armed. Idempotent: re-seeding updates the tokens but won't stack alarms.
	 */
	private async seedTokenStore(store: TokenStore): Promise<void> {
		// Seeding is itself user activity (it happens on connect), so stamp
		// lastSeenAt now if the caller didn't provide one.
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

	/*
	 * Record that the user just made a tool call, for idle-session detection.
	 * Throttled: only persists when the stored lastSeenAt is more than an hour old,
	 * so rapid fanned-out calls don't each incur a storage write. No-op if no
	 * token store exists (nothing to keep warm).
	 */
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

	/*
	 * Refresh the stored TS access token using the still-valid access token plus
	 * the refresh token (gettoken?refresh=true with X-Refresh-Token). Persists the
	 * new token and re-arms the alarm.
	 *
	 * Two behaviors guard the long-running chain:
	 *  - Idle abandonment: if the user hasn't made a tool call in
	 *    SESSION_IDLE_TTL_MS (14d), delete the keep-warm token + active-org state
	 *    and stop the chain. The user re-authenticates on their next use, and we
	 *    stop spending refresh calls on a user who is gone.
	 *  - Re-arm on failure: a refresh failure re-arms the alarm anyway (rather than
	 *    stopping). Because the interval is 11h and the token lives ~24h, the next
	 *    alarm (~22h elapsed) still fires before expiry — a built-in second
	 *    attempt without bespoke backoff.
	 */
	private async refreshTokenStore(): Promise<void> {
		const store = await this.state.storage.get<TokenStore>(TOKEN_STORE_KEY);
		if (!store) {
			return; // nothing to refresh
		}

		// Abandon the session if the user has been idle past the TTL: delete the
		// keep-warm token AND the active-org state, and do NOT re-arm.
		if (
			store.lastSeenAt != null &&
			Date.now() - store.lastSeenAt >= SESSION_IDLE_TTL_MS
		) {
			console.log(
				"Keep-warm session idle past TTL; deleting token + active-org state and stopping refresh",
			);
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
				// Preserve activity tracking across refreshes.
				lastSeenAt: store.lastSeenAt,
			});
			// Re-arm for the next refresh.
			await this.state.storage.setAlarm(Date.now() + TOKEN_REFRESH_INTERVAL_MS);
		} catch (error) {
			console.error(
				"Token keep-warm refresh failed; will retry on next interval:",
				error instanceof Error ? error.message : String(error),
			);
			// Re-arm anyway. With an 11h interval under a ~24h token life, the next
			// alarm (~22h elapsed) still fires before expiry, giving a second attempt
			// without bespoke backoff. The (still-valid) stored token is left intact
			// so reads keep working until then.
			await this.state.storage.setAlarm(Date.now() + TOKEN_REFRESH_INTERVAL_MS);
		}
	}

	// This DO's only alarm is the keep-warm refresh — no branching needed.
	async alarm(): Promise<void> {
		await this.refreshTokenStore();
	}
}
