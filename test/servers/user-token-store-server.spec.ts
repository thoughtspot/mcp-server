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
	const state = { storage: mock.storage } as unknown as DurableObjectState;
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
			const res = await server.fetch(makeRequest("DELETE", "token-store"));
			expect(res.status).toBe(404);
		});
	});

	describe("active-org", () => {
		it("returns nulls when nothing is set", async () => {
			const res = await server.fetch(makeRequest("GET", "active-org"));
			expect(await res.json()).toEqual({ activeOrgId: null, orgToken: null });
		});

		it("sets the active org and (optional) token", async () => {
			await server.fetch(
				makeRequest("POST", "active-org", {
					activeOrgId: "101",
					orgToken: "org-tok",
				}),
			);
			const res = await server.fetch(makeRequest("GET", "active-org"));
			expect(await res.json()).toEqual({
				activeOrgId: "101",
				orgToken: "org-tok",
			});
		});

		it("clears the stored token when set without one (org change)", async () => {
			await server.fetch(
				makeRequest("POST", "active-org", {
					activeOrgId: "101",
					orgToken: "org-tok",
				}),
			);
			// Re-set the active org with no token -> token must be cleared.
			await server.fetch(
				makeRequest("POST", "active-org", { activeOrgId: "202" }),
			);
			expect(mock.store.has("active-org-token")).toBe(false);
			expect(mock.store.get("active-org")).toBe("202");
		});
	});

	describe("POST /active-org-token clear", () => {
		it("deletes the stored org token when given an empty/null token", async () => {
			await server.fetch(
				makeRequest("POST", "active-org", {
					activeOrgId: "101",
					orgToken: "org-tok",
				}),
			);
			expect(mock.store.get("active-org-token")).toBe("org-tok");

			await server.fetch(
				makeRequest("POST", "active-org-token", { orgToken: null }),
			);
			expect(mock.store.has("active-org-token")).toBe(false);
			// The active org id itself is untouched.
			expect(mock.store.get("active-org")).toBe("101");
		});

		it("stores the org token when given a non-empty value", async () => {
			await server.fetch(
				makeRequest("POST", "active-org-token", { orgToken: "fresh-tok" }),
			);
			expect(mock.store.get("active-org-token")).toBe("fresh-tok");
		});
	});

	describe("keep-warm token store", () => {
		const ELEVEN_HOURS_MS = 11 * 60 * 60 * 1000;
		const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

		function seedBody(overrides: Record<string, unknown> = {}) {
			return {
				accessToken: "access-1",
				refreshToken: "refresh-1",
				instanceUrl: "https://ts.cloud",
				...overrides,
			};
		}

		it("seeds the store and arms an ~11h refresh alarm", async () => {
			const before = Date.now();
			const res = await server.fetch(
				makeRequest("POST", "token-store", seedBody()),
			);
			expect(res.status).toBe(200);
			expect(mock.alarm).not.toBeNull();
			const delay = (mock.alarm as number) - before;
			expect(delay).toBeGreaterThan(ELEVEN_HOURS_MS - 60_000);
			expect(delay).toBeLessThan(ELEVEN_HOURS_MS + 60_000);
		});

		it("stamps lastSeenAt when seeding", async () => {
			await server.fetch(makeRequest("POST", "token-store", seedBody()));
			const stored = mock.store.get("token-store") as { lastSeenAt?: number };
			expect(typeof stored.lastSeenAt).toBe("number");
		});

		it("refreshes the token and re-arms ~11h on success", async () => {
			await server.fetch(makeRequest("POST", "token-store", seedBody()));
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					new Response(
						JSON.stringify({ token: "access-2", refreshToken: "refresh-1" }),
						{ status: 200 },
					),
				);
			const before = Date.now();
			await server.alarm();
			fetchSpy.mockRestore();

			const stored = mock.store.get("token-store") as { accessToken: string };
			expect(stored.accessToken).toBe("access-2");
			const delay = (mock.alarm as number) - before;
			expect(delay).toBeGreaterThan(ELEVEN_HOURS_MS - 60_000);
			expect(delay).toBeLessThan(ELEVEN_HOURS_MS + 60_000);
		});

		it("re-arms (does NOT stop) when a refresh fails, leaving the old token", async () => {
			await server.fetch(makeRequest("POST", "token-store", seedBody()));
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response("nope", { status: 503 }));
			const before = Date.now();
			await server.alarm();
			fetchSpy.mockRestore();

			// Old token kept (reads still work), and the alarm is re-armed for ~11h
			// so the next regular tick (<24h) retries.
			const stored = mock.store.get("token-store") as { accessToken: string };
			expect(stored.accessToken).toBe("access-1");
			expect(mock.alarm).not.toBeNull();
			const delay = (mock.alarm as number) - before;
			expect(delay).toBeGreaterThan(ELEVEN_HOURS_MS - 60_000);
			expect(delay).toBeLessThan(ELEVEN_HOURS_MS + 60_000);
		});

		it("abandons the session (deletes token + active-org, no re-arm) after 14 idle days", async () => {
			// Seed, then also set active-org state and back-date lastSeenAt past the TTL.
			await server.fetch(makeRequest("POST", "token-store", seedBody()));
			await server.fetch(
				makeRequest("POST", "active-org", {
					activeOrgId: "101",
					orgToken: "org-tok",
				}),
			);
			const stored = mock.store.get("token-store") as Record<string, unknown>;
			mock.store.set("token-store", {
				...stored,
				lastSeenAt: Date.now() - FOURTEEN_DAYS_MS - 1000,
			});
			mock.storage.setAlarm.mockClear();
			const fetchSpy = vi.spyOn(globalThis, "fetch");

			await server.alarm();

			// Token + active-org state deleted; refresh NOT attempted; alarm NOT re-armed.
			expect(mock.store.has("token-store")).toBe(false);
			expect(mock.store.has("active-org")).toBe(false);
			expect(mock.store.has("active-org-token")).toBe(false);
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(mock.storage.setAlarm).not.toHaveBeenCalled();
			fetchSpy.mockRestore();
		});

		it("POST /touch records activity, throttled to ~1/hour", async () => {
			await server.fetch(makeRequest("POST", "token-store", seedBody()));
			// Back-date lastSeenAt > 1h so the next touch writes.
			const stored = mock.store.get("token-store") as Record<string, unknown>;
			const oldSeen = Date.now() - 2 * 60 * 60 * 1000;
			mock.store.set("token-store", { ...stored, lastSeenAt: oldSeen });

			await server.fetch(makeRequest("POST", "touch"));
			const afterFirst = (
				mock.store.get("token-store") as { lastSeenAt: number }
			).lastSeenAt;
			expect(afterFirst).toBeGreaterThan(oldSeen);

			// A second immediate touch is within the throttle window -> no change.
			await server.fetch(makeRequest("POST", "touch"));
			const afterSecond = (
				mock.store.get("token-store") as { lastSeenAt: number }
			).lastSeenAt;
			expect(afterSecond).toBe(afterFirst);
		});

		it("POST /touch is a no-op when no token store exists", async () => {
			const res = await server.fetch(makeRequest("POST", "touch"));
			expect(res.status).toBe(200);
			expect(mock.store.has("token-store")).toBe(false);
		});

		it("POST /touch writes immediately when there is no prior lastSeenAt", async () => {
			// Write a token store WITHOUT lastSeenAt directly (legacy / never-touched).
			mock.store.set("token-store", {
				accessToken: "access-1",
				refreshToken: "refresh-1",
				instanceUrl: "https://ts.cloud",
			});

			await server.fetch(makeRequest("POST", "touch"));
			const after = mock.store.get("token-store") as { lastSeenAt?: number };
			expect(typeof after.lastSeenAt).toBe("number");
		});

		it("refreshes (does NOT abandon) when idle is just under the 14-day TTL", async () => {
			await server.fetch(makeRequest("POST", "token-store", seedBody()));
			const stored = mock.store.get("token-store") as Record<string, unknown>;
			// One hour short of the TTL — must still refresh, not delete.
			mock.store.set("token-store", {
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

			expect(mock.store.has("token-store")).toBe(true);
			const after = mock.store.get("token-store") as { accessToken: string };
			expect(after.accessToken).toBe("access-2");
			expect(mock.alarm).not.toBeNull();
		});

		it("recovers on the next interval: failure then success re-arms cleanly", async () => {
			await server.fetch(makeRequest("POST", "token-store", seedBody()));

			// First alarm: refresh fails -> old token kept, alarm re-armed.
			const failSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response("err", { status: 503 }));
			await server.alarm();
			failSpy.mockRestore();
			expect(
				(mock.store.get("token-store") as { accessToken: string }).accessToken,
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
				(mock.store.get("token-store") as { accessToken: string }).accessToken,
			).toBe("access-2");
			expect(mock.alarm).not.toBeNull();
		});

		it("preserves lastSeenAt across a successful refresh", async () => {
			await server.fetch(makeRequest("POST", "token-store", seedBody()));
			const seen = Date.now() - 3 * 60 * 60 * 1000;
			const stored = mock.store.get("token-store") as Record<string, unknown>;
			mock.store.set("token-store", { ...stored, lastSeenAt: seen });
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					new Response(JSON.stringify({ token: "access-2" }), { status: 200 }),
				);

			await server.alarm();
			fetchSpy.mockRestore();

			const after = mock.store.get("token-store") as {
				accessToken: string;
				lastSeenAt: number;
			};
			expect(after.accessToken).toBe("access-2");
			expect(after.lastSeenAt).toBe(seen); // activity tracking survives refresh
		});

		it("seeding twice does not stack alarms (idempotent arm)", async () => {
			await server.fetch(makeRequest("POST", "token-store", seedBody()));
			mock.storage.setAlarm.mockClear();
			// Re-seed (e.g. a later connect) — alarm already armed, must not re-arm.
			await server.fetch(makeRequest("POST", "token-store", seedBody()));
			expect(mock.storage.setAlarm).not.toHaveBeenCalled();
		});
	});
});
