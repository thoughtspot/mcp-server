import {
	fetchOrgToken,
	refreshGlobalToken,
} from "../thoughtspot/token-endpoints";

const ACTIVE_ORG_KEY = "active-org-id";
const ORG_TOKEN_KEY = "active-org-token";
const GLOBAL_TOKEN_KEY = "global-token-details";
const GLOBAL_TOKEN_REFRESH_INTERVAL_MS = 11 * 60 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type GlobalTokenData = {
	globalToken: string;
	globalRefreshToken: string;
	instanceUrl: string;
	globalTokenExpiresAt?: number;
	lastSeenAt?: number;
	// Debug counters for diagnosing early reauth; reset on a successful refresh.
	consecutiveRefreshFailures?: number;
	lastRefreshOkAt?: number;
};

// Log a token prefix only, never the full value.
const tokPrefix = (t: string | null | undefined): string =>
	t ? `${t.slice(0, 6)}…(${t.length})` : "<none>";

const asHours = (ms: number): string => `${(ms / 3_600_000).toFixed(1)}h`;

// One-line token-health snapshot for [keepwarm-debug] logs.
function tokenHealth(store: GlobalTokenData): string {
	const now = Date.now();
	const expiresAt = store.globalTokenExpiresAt;
	const ttl =
		typeof expiresAt === "number"
			? `expiresIn=${asHours(expiresAt - now)}${expiresAt <= now ? " (EXPIRED)" : ""}`
			: "expiresIn=unknown";
	const idle =
		store.lastSeenAt != null
			? `idle=${asHours(now - store.lastSeenAt)}`
			: "idle=unknown";
	const lastOk =
		store.lastRefreshOkAt != null
			? `sinceLastRefreshOk=${asHours(now - store.lastRefreshOkAt)}`
			: "sinceLastRefreshOk=never";
	return `token=${tokPrefix(store.globalToken)} ${ttl} ${idle} ${lastOk} consecFailures=${store.consecutiveRefreshFailures ?? 0}`;
}

// Per-user token/org DO, shared across the user's fanned-out sessions via the
// storage-key hash. Owns the active org + org token and the keep-warm cluster
// token (11h refresh alarm, abandoned after 14 idle days).
export class UserTokenStoreSQLite {
	constructor(
		private state: DurableObjectState,
		private env: Env,
	) {}

	// Stable per-user key for [keepwarm-debug] logs (DO id prefix — hash-derived,
	// not a token). Lets you grep one user's full alarm/refresh/expiry history.
	private userKey(): string {
		return `user=${this.state.id?.toString().slice(0, 12) ?? "unknown"}`;
	}

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
						activeOrgToken: orgToken ?? null,
					});
				}

				// Clear the token only on a real org change; re-setting the same org
				// (every cold connect) must not delete a token a sibling just minted.
				case "POST /active-org-id-and-token": {
					const body = (await request.json()) as {
						activeOrgId: string;
						activeOrgToken?: string | null;
					};
					if (body.activeOrgToken) {
						await this.state.storage.put({
							[ACTIVE_ORG_KEY]: body.activeOrgId,
							[ORG_TOKEN_KEY]: body.activeOrgToken,
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

				case "GET /global-token-data": {
					const store =
						(await this.state.storage.get<GlobalTokenData>(GLOBAL_TOKEN_KEY)) ??
						null;
					return Response.json({
						globalToken: store?.globalToken ?? null,
						globalTokenExpiresAt: store?.globalTokenExpiresAt ?? null,
					});
				}

				case "POST /global-token-data": {
					const body = (await request.json()) as GlobalTokenData;
					await this.storeGlobalTokenData(body);
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

	private async storeGlobalTokenData(store: GlobalTokenData): Promise<void> {
		const existing =
			await this.state.storage.get<GlobalTokenData>(GLOBAL_TOKEN_KEY);
		// Same token already stored (every cold connect re-seeds): the refresh
		// alarm was armed when it was first stored, so nothing to do.
		if (existing?.globalToken === store.globalToken) {
			return;
		}
		await this.state.storage.put<GlobalTokenData>(GLOBAL_TOKEN_KEY, {
			...store,
			lastSeenAt: existing?.lastSeenAt ?? Date.now(),
		});
		console.log(
			`[keepwarm-debug] ${this.userKey()} seeded token ${tokPrefix(store.globalToken)}, arming alarm +${asHours(GLOBAL_TOKEN_REFRESH_INTERVAL_MS)}; ${tokenHealth(store)}`,
		);
		await this.state.storage.setAlarm(
			Date.now() + GLOBAL_TOKEN_REFRESH_INTERVAL_MS,
		);
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

	private async refreshGlobalAndOrgTokens(): Promise<void> {
		const store =
			await this.state.storage.get<GlobalTokenData>(GLOBAL_TOKEN_KEY);
		if (!store) {
			// Abandoned/never seeded — keep-warm state was already gone.
			console.log(
				`[keepwarm-debug] ${this.userKey()} alarm fired but no store present (nothing to refresh)`,
			);
			return;
		}

		console.log(
			`[keepwarm-debug] ${this.userKey()} alarm fired: ${tokenHealth(store)}`,
		);

		// Explicit expiry event: the alarm found the token already past expiry, so
		// this user's session is dead and their next call will force a reauth.
		const expiresAt = store.globalTokenExpiresAt;
		if (typeof expiresAt === "number" && expiresAt <= Date.now()) {
			console.error(
				`[keepwarm-debug] ${this.userKey()} TOKEN EXPIRED at alarm (expiredBy=${asHours(Date.now() - expiresAt)}); user will reauth. ${tokenHealth(store)}`,
			);
		}

		if (
			store.lastSeenAt != null &&
			Date.now() - store.lastSeenAt >= SESSION_IDLE_TTL_MS
		) {
			console.log(
				`[keepwarm-debug] ${this.userKey()} idle past 14d TTL; ABANDONING (expected early-reauth cause): idle=${asHours(Date.now() - store.lastSeenAt)} ${tokenHealth(store)}`,
			);
			await this.state.storage.delete([
				GLOBAL_TOKEN_KEY,
				ACTIVE_ORG_KEY,
				ORG_TOKEN_KEY,
			]);
			return;
		}

		try {
			const refreshed = await refreshGlobalToken({
				instanceUrl: store.instanceUrl,
				globalToken: store.globalToken,
				globalRefreshToken: store.globalRefreshToken,
			});
			await this.state.storage.put<GlobalTokenData>(GLOBAL_TOKEN_KEY, {
				globalToken: refreshed.globalToken,
				globalRefreshToken: refreshed.globalRefreshToken,
				instanceUrl: store.instanceUrl,
				// Keep the prior expiry if the response omits one.
				globalTokenExpiresAt:
					refreshed.globalTokenExpiresAt ?? store.globalTokenExpiresAt,
				lastSeenAt: store.lastSeenAt,
				consecutiveRefreshFailures: 0,
				lastRefreshOkAt: Date.now(),
			});
			console.log(
				`[keepwarm-debug] ${this.userKey()} refresh OK: ${tokPrefix(store.globalToken)} -> ${tokPrefix(refreshed.globalToken)} newExpiresIn=${
					typeof refreshed.globalTokenExpiresAt === "number"
						? asHours(refreshed.globalTokenExpiresAt - Date.now())
						: "unchanged"
				} cluster=${store.instanceUrl}`,
			);
			// Keep the org token as warm as the global token: re-mint it from the
			// fresh global token so an active session never hits an expired org
			// token mid-conversation.
			await this.refreshOrgToken(store.instanceUrl, refreshed.globalToken);
			await this.state.storage.setAlarm(
				Date.now() + GLOBAL_TOKEN_REFRESH_INTERVAL_MS,
			);
		} catch (error) {
			// Prime suspect for early reauth: repeated failures across the token's
			// ~24h life expire it well before the 14d idle TTL (no retry until the
			// next 11h alarm).
			const failures = (store.consecutiveRefreshFailures ?? 0) + 1;
			await this.state.storage.put<GlobalTokenData>(GLOBAL_TOKEN_KEY, {
				...store,
				consecutiveRefreshFailures: failures,
			});
			const failExpiresAt = store.globalTokenExpiresAt;
			const willDieBeforeNextAlarm =
				typeof failExpiresAt === "number" &&
				failExpiresAt - Date.now() < GLOBAL_TOKEN_REFRESH_INTERVAL_MS;
			console.error(
				`[keepwarm-debug] ${this.userKey()} refresh FAILED (consecutive=${failures}${
					willDieBeforeNextAlarm
						? ", TOKEN WILL EXPIRE BEFORE NEXT ALARM -> user will reauth"
						: ""
				}): ${tokenHealth(store)} cluster=${store.instanceUrl} err=${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			await this.state.storage.setAlarm(
				Date.now() + GLOBAL_TOKEN_REFRESH_INTERVAL_MS,
			);
		}
	}

	// Re-mint the active org token from a freshly refreshed global token, so it
	// stays as warm as the global token (both 24h). No-op if no org is active.
	// On failure, keep the existing org token and let the next 11h alarm retry;
	// never throws (the global refresh must still commit and the alarm re-arm).
	// A token that is genuinely expired only surfaces after 14 idle days, as an
	// expected 401 — there is deliberately no reactive re-mint / retry path.
	private async refreshOrgToken(
		instanceUrl: string,
		globalToken: string,
	): Promise<void> {
		const activeOrgId = await this.state.storage.get<string>(ACTIVE_ORG_KEY);
		if (!activeOrgId) {
			return;
		}
		try {
			const orgToken = await fetchOrgToken({
				instanceUrl,
				bearerToken: globalToken,
				orgId: activeOrgId,
			});
			await this.state.storage.put<string>(ORG_TOKEN_KEY, orgToken);
		} catch (error) {
			console.error(
				"Keep-warm org-token re-mint failed; keeping existing token, will retry next interval:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	async alarm(): Promise<void> {
		await this.refreshGlobalAndOrgTokens();
	}
}
