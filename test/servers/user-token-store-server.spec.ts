import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserTokenStoreSQLite } from "../../src/servers/user-token-store-server";

// ---------------------------------------------------------------------------
// Helpers (mirror the conversation-storage mock; this DO uses the same
// DurableObjectState storage + alarm surface).
// ---------------------------------------------------------------------------

function createMockStorage() {
	const store = new Map<string, unknown>();
	let alarm: number | null = null;

	return {
		store,
		get alarm() {
			return alarm;
		},
		storage: {
			get: vi.fn(
				async <T>(
					keyOrKeys: string | string[],
				): Promise<T | undefined | Map<string, T>> => {
					if (Array.isArray(keyOrKeys)) {
						const result = new Map<string, T>();
						for (const key of keyOrKeys) {
							if (store.has(key)) {
								result.set(key, store.get(key) as T);
							}
						}
						return result;
					}
					return store.get(keyOrKeys) as T | undefined;
				},
			),
			put: vi.fn(
				async (
					keyOrEntries: string | Record<string, unknown>,
					value?: unknown,
				): Promise<void> => {
					if (typeof keyOrEntries === "string") {
						store.set(keyOrEntries, value);
					} else {
						for (const [k, v] of Object.entries(keyOrEntries)) {
							store.set(k, v);
						}
					}
				},
			),
			delete: vi.fn(async (keyOrKeys: string | string[]): Promise<void> => {
				const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
				for (const key of keys) {
					store.delete(key);
				}
			}),
			getAlarm: vi.fn(async (): Promise<number | null> => alarm),
			setAlarm: vi.fn(async (scheduledTime: number): Promise<void> => {
				alarm = scheduledTime;
			}),
			deleteAlarm: vi.fn(async (): Promise<void> => {
				alarm = null;
			}),
			deleteAll: vi.fn(async (): Promise<void> => {
				store.clear();
			}),
		},
	};
}

function createServer(mock: ReturnType<typeof createMockStorage>) {
	const state = {
		storage: mock.storage,
		id: { toString: () => "test-do-id-000000" },
	} as unknown as DurableObjectState;
	return new UserTokenStoreSQLite(state, {} as Env);
}

function makeRequest(
	method: string,
	operation: string,
	body?: unknown,
): Request {
	const url = `https://example.com/storage/__active_org__/${operation}`;
	return new Request(url, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserTokenStoreSQLite", () => {
	let mock: ReturnType<typeof createMockStorage>;
	let server: UserTokenStoreSQLite;

	beforeEach(() => {
		mock = createMockStorage();
		server = createServer(mock);
	});

	describe("routing", () => {
		it("returns 404 for an unknown route", async () => {
			const res = await server.fetch(makeRequest("GET", "unknown"));
			expect(res.status).toBe(404);
		});

		it("returns 404 for a valid operation with the wrong HTTP method", async () => {
			const res = await server.fetch(
				makeRequest("DELETE", "global-token-data"),
			);
			expect(res.status).toBe(404);
		});
	});

	describe("active-org-id-and-token", () => {
		it("returns nulls when nothing is set", async () => {
			const res = await server.fetch(
				makeRequest("GET", "active-org-id-and-token"),
			);
			expect(await res.json()).toEqual({
				activeOrgId: null,
				activeOrgToken: null,
			});
		});

		it("sets the active org and (optional) token", async () => {
			await server.fetch(
				makeRequest("POST", "active-org-id-and-token", {
					activeOrgId: "101",
					activeOrgToken: "org-tok",
				}),
			);
			const res = await server.fetch(
				makeRequest("GET", "active-org-id-and-token"),
			);
			expect(await res.json()).toEqual({
				activeOrgId: "101",
				activeOrgToken: "org-tok",
			});
		});

		it("clears the stored token when set without one (org change)", async () => {
			await server.fetch(
				makeRequest("POST", "active-org-id-and-token", {
					activeOrgId: "101",
					activeOrgToken: "org-tok",
				}),
			);
			// Re-set the active org with no token -> token must be cleared.
			await server.fetch(
				makeRequest("POST", "active-org-id-and-token", { activeOrgId: "202" }),
			);
			expect(mock.store.has("active-org-token")).toBe(false);
			expect(mock.store.get("active-org-id")).toBe("202");
		});

		it("PRESERVES the stored token when re-setting the SAME org id (fan-out safety)", async () => {
			await server.fetch(
				makeRequest("POST", "active-org-id-and-token", {
					activeOrgId: "101",
					activeOrgToken: "org-tok",
				}),
			);
			// A concurrent/cold-start sibling re-asserts the same active org with no
			// token (postInit default path). The token another session just minted
			// must NOT be deleted, or the fan-out would thrash re-minting.
			await server.fetch(
				makeRequest("POST", "active-org-id-and-token", { activeOrgId: "101" }),
			);
			expect(mock.store.get("active-org-token")).toBe("org-tok");
			expect(mock.store.get("active-org-id")).toBe("101");
		});
	});

	describe("keep-warm token store", () => {
		const ELEVEN_HOURS_MS = 11 * 60 * 60 * 1000;
		const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

		function seedBody(overrides: Record<string, unknown> = {}) {
			return {
				globalToken: "access-1",
				globalRefreshToken: "refresh-1",
				instanceUrl: "https://ts.cloud",
				...overrides,
			};
		}

		it("seeds the store and arms an ~11h refresh alarm", async () => {
			const before = Date.now();
			const res = await server.fetch(
				makeRequest("POST", "global-token-data", seedBody()),
			);
			expect(res.status).toBe(200);
			expect(mock.alarm).not.toBeNull();
			const delay = (mock.alarm as number) - before;
			expect(delay).toBeGreaterThan(ELEVEN_HOURS_MS - 60_000);
			expect(delay).toBeLessThan(ELEVEN_HOURS_MS + 60_000);
		});

		it("stamps lastSeenAt on first seed but preserves it on re-seeds", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			const after1 = mock.store.get("global-token-details") as {
				lastSeenAt?: number;
			};
			expect(typeof after1.lastSeenAt).toBe("number");
			const first = after1.lastSeenAt;
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			const after2 = mock.store.get("global-token-details") as {
				lastSeenAt?: number;
			};
			expect(after2.lastSeenAt).toBe(first);
		});

		it("refreshes the token and re-arms ~11h on success", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(
					JSON.stringify({
						token: "access-2",
						globalRefreshToken: "refresh-1",
					}),
					{ status: 200 },
				),
			);
			const before = Date.now();
			await server.alarm();
			fetchSpy.mockRestore();

			const stored = mock.store.get("global-token-details") as {
				globalToken: string;
			};
			expect(stored.globalToken).toBe("access-2");
			const delay = (mock.alarm as number) - before;
			expect(delay).toBeGreaterThan(ELEVEN_HOURS_MS - 60_000);
			expect(delay).toBeLessThan(ELEVEN_HOURS_MS + 60_000);
		});

		it("re-arms (does NOT stop) when a refresh fails, leaving the old token", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response("nope", { status: 503 }));
			const before = Date.now();
			await server.alarm();
			fetchSpy.mockRestore();

			// Old token kept (reads still work), and the alarm is re-armed for ~11h
			// so the next regular tick (<24h) retries.
			const stored = mock.store.get("global-token-details") as {
				globalToken: string;
			};
			expect(stored.globalToken).toBe("access-1");
			expect(mock.alarm).not.toBeNull();
			const delay = (mock.alarm as number) - before;
			expect(delay).toBeGreaterThan(ELEVEN_HOURS_MS - 60_000);
			expect(delay).toBeLessThan(ELEVEN_HOURS_MS + 60_000);
		});

		it("abandons the session (deletes token + active-org, no re-arm) after 14 idle days", async () => {
			// Seed, then also set active-org state and back-date lastSeenAt past the TTL.
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			await server.fetch(
				makeRequest("POST", "active-org-id-and-token", {
					activeOrgId: "101",
					activeOrgToken: "org-tok",
				}),
			);
			const stored = mock.store.get("global-token-details") as Record<
				string,
				unknown
			>;
			mock.store.set("global-token-details", {
				...stored,
				lastSeenAt: Date.now() - FOURTEEN_DAYS_MS - 1000,
			});
			mock.storage.setAlarm.mockClear();
			const fetchSpy = vi.spyOn(globalThis, "fetch");

			await server.alarm();

			// Token + active-org state deleted; refresh NOT attempted; alarm NOT re-armed.
			expect(mock.store.has("global-token-details")).toBe(false);
			expect(mock.store.has("active-org-id")).toBe(false);
			expect(mock.store.has("active-org-token")).toBe(false);
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(mock.storage.setAlarm).not.toHaveBeenCalled();
			fetchSpy.mockRestore();
		});

		it("POST /touch records activity, throttled to ~1/hour", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			// Back-date lastSeenAt > 1h so the next touch writes.
			const stored = mock.store.get("global-token-details") as Record<
				string,
				unknown
			>;
			const oldSeen = Date.now() - 2 * 60 * 60 * 1000;
			mock.store.set("global-token-details", {
				...stored,
				lastSeenAt: oldSeen,
			});

			await server.fetch(makeRequest("POST", "last-seen"));
			const afterFirst = (
				mock.store.get("global-token-details") as { lastSeenAt: number }
			).lastSeenAt;
			expect(afterFirst).toBeGreaterThan(oldSeen);

			// A second immediate touch is within the throttle window -> no change.
			await server.fetch(makeRequest("POST", "last-seen"));
			const afterSecond = (
				mock.store.get("global-token-details") as { lastSeenAt: number }
			).lastSeenAt;
			expect(afterSecond).toBe(afterFirst);
		});

		it("POST /touch is a no-op when no token store exists", async () => {
			const res = await server.fetch(makeRequest("POST", "last-seen"));
			expect(res.status).toBe(200);
			expect(mock.store.has("global-token-details")).toBe(false);
		});

		it("POST /touch writes immediately when there is no prior lastSeenAt", async () => {
			// Write a token store WITHOUT lastSeenAt directly (legacy / never-touched).
			mock.store.set("global-token-details", {
				globalToken: "access-1",
				globalRefreshToken: "refresh-1",
				instanceUrl: "https://ts.cloud",
			});

			await server.fetch(makeRequest("POST", "last-seen"));
			const after = mock.store.get("global-token-details") as {
				lastSeenAt?: number;
			};
			expect(typeof after.lastSeenAt).toBe("number");
		});

		it("refreshes (does NOT abandon) when idle is just under the 14-day TTL", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			const stored = mock.store.get("global-token-details") as Record<
				string,
				unknown
			>;
			// One hour short of the TTL — must still refresh, not delete.
			mock.store.set("global-token-details", {
				...stored,
				lastSeenAt: Date.now() - (FOURTEEN_DAYS_MS - 60 * 60 * 1000),
			});
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					new Response(JSON.stringify({ token: "access-2" }), { status: 200 }),
				);

			await server.alarm();
			fetchSpy.mockRestore();

			expect(mock.store.has("global-token-details")).toBe(true);
			const after = mock.store.get("global-token-details") as {
				globalToken: string;
			};
			expect(after.globalToken).toBe("access-2");
			expect(mock.alarm).not.toBeNull();
		});

		it("recovers on the next interval: failure then success re-arms cleanly", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));

			// First alarm: refresh fails -> old token kept, alarm re-armed.
			const failSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response("err", { status: 503 }));
			await server.alarm();
			failSpy.mockRestore();
			expect(
				(mock.store.get("global-token-details") as { globalToken: string })
					.globalToken,
			).toBe("access-1");
			expect(mock.alarm).not.toBeNull();

			// Second alarm: refresh succeeds -> token updated, still armed.
			const okSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					new Response(JSON.stringify({ token: "access-2" }), { status: 200 }),
				);
			await server.alarm();
			okSpy.mockRestore();
			expect(
				(mock.store.get("global-token-details") as { globalToken: string })
					.globalToken,
			).toBe("access-2");
			expect(mock.alarm).not.toBeNull();
		});

		it("preserves lastSeenAt across a successful refresh", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			const seen = Date.now() - 3 * 60 * 60 * 1000;
			const stored = mock.store.get("global-token-details") as Record<
				string,
				unknown
			>;
			mock.store.set("global-token-details", { ...stored, lastSeenAt: seen });
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					new Response(JSON.stringify({ token: "access-2" }), { status: 200 }),
				);

			await server.alarm();
			fetchSpy.mockRestore();

			const after = mock.store.get("global-token-details") as {
				globalToken: string;
				lastSeenAt: number;
			};
			expect(after.globalToken).toBe("access-2");
			expect(after.lastSeenAt).toBe(seen); // activity tracking survives refresh
		});

		it("keeps the prior globalTokenExpiresAt when the refresh response omits one", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			const priorExpiry = Date.now() + 24 * 60 * 60 * 1000;
			const stored = mock.store.get("global-token-details") as Record<
				string,
				unknown
			>;
			mock.store.set("global-token-details", {
				...stored,
				globalTokenExpiresAt: priorExpiry,
			});
			// Refresh response has a token but NO tokenExpiryDuration.
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					new Response(JSON.stringify({ token: "access-2" }), { status: 200 }),
				);

			await server.alarm();
			fetchSpy.mockRestore();

			const after = mock.store.get("global-token-details") as {
				globalToken: string;
				globalTokenExpiresAt?: number;
			};
			expect(after.globalToken).toBe("access-2");
			// Expiry tracking preserved (not dropped to undefined), so reconnect
			// self-heal still works.
			expect(after.globalTokenExpiresAt).toBe(priorExpiry);
		});

		it("seeding twice does not stack alarms (idempotent arm)", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			mock.storage.setAlarm.mockClear();
			// Re-seed (e.g. a later connect) — alarm already armed, must not re-arm.
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			expect(mock.storage.setAlarm).not.toHaveBeenCalled();
		});

		// Route a keep-warm fetch by URL: the org-token mint hits auth/token/fetch,
		// everything else is the global gettoken?refresh refresh.
		const routeKeepWarm = (opts: {
			global: Response;
			orgToken?: string;
			orgStatus?: number;
		}) =>
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
				const url = typeof input === "string" ? input : input.url;
				if (url.includes("auth/token/fetch")) {
					if ((opts.orgStatus ?? 200) !== 200) {
						return new Response("nope", { status: opts.orgStatus });
					}
					return new Response(
						JSON.stringify({ data: { token: opts.orgToken ?? "org-2" } }),
						{ status: 200 },
					);
				}
				return opts.global.clone();
			});

		it("re-mints the active org token from the fresh global token on refresh", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			await server.fetch(
				makeRequest("POST", "active-org-id-and-token", {
					activeOrgId: "101",
					activeOrgToken: "org-1",
				}),
			);
			const spy = routeKeepWarm({
				global: new Response(JSON.stringify({ token: "access-2" }), {
					status: 200,
				}),
				orgToken: "org-2",
			});
			await server.alarm();

			// Org token overwritten with the freshly minted one; mint used the new
			// global token and the 24h validity, with no org header.
			expect(mock.store.get("active-org-token")).toBe("org-2");
			const mintCall = spy.mock.calls.find((c) =>
				String(c[0]).includes("auth/token/fetch"),
			);
			expect(mintCall).toBeDefined();
			const [mintUrl, mintInit] = mintCall as [string, any];
			expect(mintUrl).toContain("org_identifier=101");
			expect(mintUrl).toContain(`validity_time_in_sec=${24 * 60 * 60}`);
			expect(mintInit.headers.Authorization).toBe("Bearer access-2");
			spy.mockRestore();
		});

		it("does NOT mint an org token when no org is active", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			const spy = routeKeepWarm({
				global: new Response(JSON.stringify({ token: "access-2" }), {
					status: 200,
				}),
			});
			await server.alarm();

			const minted = spy.mock.calls.some((c) =>
				String(c[0]).includes("auth/token/fetch"),
			);
			expect(minted).toBe(false);
			spy.mockRestore();
		});

		it("keeps the old global token when the refresh returns 200 but no token", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			// 200 with an empty body — no token field — must be treated as a failure.
			const spy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
			await server.alarm();

			expect(
				(mock.store.get("global-token-details") as { globalToken: string })
					.globalToken,
			).toBe("access-1");
			expect(mock.alarm).not.toBeNull();
			spy.mockRestore();
		});

		it("keeps the existing org token when the mint returns 200 but no token", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			await server.fetch(
				makeRequest("POST", "active-org-id-and-token", {
					activeOrgId: "101",
					activeOrgToken: "org-1",
				}),
			);
			// Global refresh succeeds; the org mint returns 200 with an empty body
			// (no token) — the re-mint must fail gracefully and leave the old token.
			const spy = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async (input: any) => {
					const url = typeof input === "string" ? input : input.url;
					if (url.includes("auth/token/fetch")) {
						return new Response(JSON.stringify({ data: {} }), { status: 200 });
					}
					return new Response(JSON.stringify({ token: "access-2" }), {
						status: 200,
					});
				});
			await server.alarm();

			expect(
				(mock.store.get("global-token-details") as { globalToken: string })
					.globalToken,
			).toBe("access-2");
			expect(mock.store.get("active-org-token")).toBe("org-1");
			expect(mock.alarm).not.toBeNull();
			spy.mockRestore();
		});

		it("keeps the existing org token (no reactive re-mint) when the mint fails", async () => {
			await server.fetch(makeRequest("POST", "global-token-data", seedBody()));
			await server.fetch(
				makeRequest("POST", "active-org-id-and-token", {
					activeOrgId: "101",
					activeOrgToken: "org-1",
				}),
			);
			const spy = routeKeepWarm({
				global: new Response(JSON.stringify({ token: "access-2" }), {
					status: 200,
				}),
				orgStatus: 500,
			});
			await server.alarm();

			// Global refresh still committed; the existing org token is left intact
			// (the next 11h alarm retries the mint — no reactive re-mint path); the
			// active org is unchanged and the alarm is re-armed.
			expect(
				(mock.store.get("global-token-details") as { globalToken: string })
					.globalToken,
			).toBe("access-2");
			expect(mock.store.get("active-org-token")).toBe("org-1");
			expect(mock.store.get("active-org-id")).toBe("101");
			expect(mock.alarm).not.toBeNull();
			spy.mockRestore();
		});
	});
});
