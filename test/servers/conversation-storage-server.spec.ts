import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationStorageServerSQLite } from "../../src/servers/conversation-storage-server";
import type {
	Message,
	StreamingMessagesState,
} from "../../src/thoughtspot/types";

// ---------------------------------------------------------------------------
// Helpers
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
	return new ConversationStorageServerSQLite(state, {} as Env);
}

function makeRequest(
	method: string,
	operation: string,
	body?: unknown,
): Request {
	const url = `https://example.com/storage/conv-1/${operation}`;
	return new Request(url, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
}

// Sample messages
const textMessage: Message = {
	type: "text",
	text: "Hello",
	is_thinking: false,
};
const chunkMessage: Message = {
	type: "text_chunk",
	text: " world",
	is_thinking: false,
};
const answerMessage: Message = {
	type: "answer",
	answer_id: "ans-1",
	answer_title: "My Answer",
	answer_query: "SELECT 1",
	iframe_url: "https://example.com/answer/1",
	is_thinking: false,
};

// Generate an array of N simple text messages
function generateMessages(n: number): Message[] {
	return Array.from({ length: n }, (_, i) => ({
		type: "text",
		text: `Message ${i}`,
		is_thinking: false,
	}));
}

// The storage batch size used by ConversationStorageServer (must match the constant in the source)
const STORAGE_BATCH_SIZE = 127;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationStorageServerSQLite", () => {
	let mock: ReturnType<typeof createMockStorage>;
	let server: ConversationStorageServerSQLite;

	beforeEach(() => {
		mock = createMockStorage();
		server = createServer(mock);
	});

	// -------------------------------------------------------------------------
	// Routing
	// -------------------------------------------------------------------------

	describe("routing", () => {
		it("returns 404 for an unknown route", async () => {
			const res = await server.fetch(makeRequest("GET", "unknown"));
			expect(res.status).toBe(404);
		});

		it("returns 404 for a valid operation with the wrong HTTP method", async () => {
			const res = await server.fetch(makeRequest("GET", "initialize"));
			expect(res.status).toBe(404);
		});
	});

	// -------------------------------------------------------------------------
	// POST /initialize
	// -------------------------------------------------------------------------

	describe("POST /initialize", () => {
		it("responds with { ok: true } on success", async () => {
			const res = await server.fetch(makeRequest("POST", "initialize"));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		});

		it("stores empty messages and isDone=false", async () => {
			await server.fetch(makeRequest("POST", "initialize"));

			expect(mock.store.get("is-done")).toBe(false);
			// No message keys should exist yet
			expect(mock.store.has("message-0")).toBe(false);
		});

		it("sets bookmark to 0", async () => {
			await server.fetch(makeRequest("POST", "initialize"));

			// write-bookmark and read-bookmark are lazily initialised to 0
			expect(mock.store.get("write-bookmark") ?? 0).toBe(0);
			expect(mock.store.get("read-bookmark") ?? 0).toBe(0);
		});

		it("schedules a TTL alarm", async () => {
			const before = Date.now();
			await server.fetch(makeRequest("POST", "initialize"));

			expect(mock.storage.setAlarm).toHaveBeenCalledOnce();
			const scheduledTime = mock.storage.setAlarm.mock.calls[0][0] as number;
			expect(scheduledTime).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
		});

		it("returns 500 when conversation already exists and is not done", async () => {
			await server.fetch(makeRequest("POST", "initialize"));
			// Second init while not done should fail
			const res = await server.fetch(makeRequest("POST", "initialize"));
			expect(res.status).toBe(500);
		});

		it("allows re-initialization after the conversation is marked done", async () => {
			await server.fetch(makeRequest("POST", "initialize"));
			await server.fetch(
				makeRequest("POST", "append", {
					messages: [textMessage],
					isDone: true,
				}),
			);

			const res = await server.fetch(makeRequest("POST", "initialize"));
			expect(res.status).toBe(200);

			expect(mock.store.get("is-done")).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// POST /append
	// -------------------------------------------------------------------------

	describe("POST /append", () => {
		beforeEach(async () => {
			await server.fetch(makeRequest("POST", "initialize"));
			vi.clearAllMocks();
		});

		it("responds with { ok: true } on success", async () => {
			const res = await server.fetch(
				makeRequest("POST", "append", { messages: [textMessage] }),
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		});

		it("appends messages to storage", async () => {
			await server.fetch(
				makeRequest("POST", "append", { messages: [textMessage] }),
			);

			expect(mock.store.get("message-0")).toEqual(textMessage);
			expect(mock.store.get("write-bookmark")).toBe(1);
		});

		it("accumulates messages across multiple calls", async () => {
			await server.fetch(
				makeRequest("POST", "append", { messages: [textMessage] }),
			);
			await server.fetch(
				makeRequest("POST", "append", {
					messages: [chunkMessage, answerMessage],
				}),
			);

			expect(mock.store.get("message-0")).toEqual(textMessage);
			expect(mock.store.get("message-1")).toEqual(chunkMessage);
			expect(mock.store.get("message-2")).toEqual(answerMessage);
			expect(mock.store.get("write-bookmark")).toBe(3);
		});

		it("marks the conversation done when isDone is true", async () => {
			await server.fetch(
				makeRequest("POST", "append", {
					messages: [textMessage],
					isDone: true,
				}),
			);

			expect(mock.store.get("is-done")).toBe(true);
		});

		it("restarts the TTL alarm on each call", async () => {
			await server.fetch(
				makeRequest("POST", "append", { messages: [textMessage] }),
			);

			expect(mock.storage.deleteAlarm).toHaveBeenCalledOnce();
			expect(mock.storage.setAlarm).toHaveBeenCalledOnce();
		});

		it("returns 500 when the conversation does not exist", async () => {
			// Wipe the state so the conversation is gone
			mock.store.clear();

			const res = await server.fetch(
				makeRequest("POST", "append", { messages: [textMessage] }),
			);
			expect(res.status).toBe(500);
		});

		it("returns 500 when the conversation is already marked done", async () => {
			await server.fetch(
				makeRequest("POST", "append", { messages: [], isDone: true }),
			);

			const res = await server.fetch(
				makeRequest("POST", "append", { messages: [textMessage] }),
			);
			expect(res.status).toBe(500);
		});

		// -------------------------------------------------------------------
		// Batching
		// -------------------------------------------------------------------

		it("stores exactly STORAGE_BATCH_SIZE messages in a single put call", async () => {
			// STORAGE_BATCH_SIZE - 1 messages + write-bookmark = STORAGE_BATCH_SIZE entries → 1 batch
			const messages = generateMessages(STORAGE_BATCH_SIZE - 1);
			await server.fetch(makeRequest("POST", "append", { messages }));

			expect(mock.storage.put).toHaveBeenCalledOnce();
			expect(mock.store.get("write-bookmark")).toBe(STORAGE_BATCH_SIZE - 1);
			expect(mock.store.get("message-0")).toEqual(messages[0]);
			expect(mock.store.get(`message-${STORAGE_BATCH_SIZE - 2}`)).toEqual(
				messages[STORAGE_BATCH_SIZE - 2],
			);
		});

		it("splits into two put calls when messages exceed STORAGE_BATCH_SIZE", async () => {
			// STORAGE_BATCH_SIZE messages + write-bookmark = STORAGE_BATCH_SIZE + 1 entries → 2 batches
			const messages = generateMessages(STORAGE_BATCH_SIZE);
			await server.fetch(makeRequest("POST", "append", { messages }));

			expect(mock.storage.put).toHaveBeenCalledTimes(2);
			expect(mock.store.get("write-bookmark")).toBe(STORAGE_BATCH_SIZE);
			for (let i = 0; i < STORAGE_BATCH_SIZE; i++) {
				expect(mock.store.get(`message-${i}`)).toEqual(messages[i]);
			}
		});

		it("splits into two put calls when isDone adds an extra entry over the batch limit", async () => {
			// STORAGE_BATCH_SIZE messages + write-bookmark + is-done = STORAGE_BATCH_SIZE + 2 entries → 2 batches
			const messages = generateMessages(STORAGE_BATCH_SIZE);
			await server.fetch(
				makeRequest("POST", "append", { messages, isDone: true }),
			);

			expect(mock.storage.put).toHaveBeenCalledTimes(2);
			expect(mock.store.get("write-bookmark")).toBe(STORAGE_BATCH_SIZE);
			expect(mock.store.get("is-done")).toBe(true);
			for (let i = 0; i < STORAGE_BATCH_SIZE; i++) {
				expect(mock.store.get(`message-${i}`)).toEqual(messages[i]);
			}
		});

		it("correctly stores messages across three or more batches", async () => {
			const count = STORAGE_BATCH_SIZE * 2 + 10;
			const messages = generateMessages(count);
			await server.fetch(makeRequest("POST", "append", { messages }));

			expect(mock.store.get("write-bookmark")).toBe(count);
			for (let i = 0; i < count; i++) {
				expect(mock.store.get(`message-${i}`)).toEqual(messages[i]);
			}
		});
	});

	// -------------------------------------------------------------------------
	// GET /messages
	// -------------------------------------------------------------------------

	describe("GET /messages", () => {
		beforeEach(async () => {
			await server.fetch(makeRequest("POST", "initialize"));
		});

		it("returns empty messages and isDone=false on a fresh conversation", async () => {
			const res = await server.fetch(makeRequest("GET", "messages"));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ messages: [], isDone: false });
		});

		it("returns all messages appended since the last call", async () => {
			await server.fetch(
				makeRequest("POST", "append", {
					messages: [textMessage, chunkMessage],
				}),
			);

			const res = await server.fetch(makeRequest("GET", "messages"));
			const body = (await res.json()) as StreamingMessagesState;
			expect(body.messages).toEqual([textMessage, chunkMessage]);
		});

		it("advances the bookmark so subsequent calls only return new messages", async () => {
			await server.fetch(
				makeRequest("POST", "append", { messages: [textMessage] }),
			);
			// First poll — consumes textMessage
			await server.fetch(makeRequest("GET", "messages"));

			// Append another message
			await server.fetch(
				makeRequest("POST", "append", { messages: [chunkMessage] }),
			);

			// Second poll — should only see chunkMessage
			const res = await server.fetch(makeRequest("GET", "messages"));
			const body = (await res.json()) as StreamingMessagesState;
			expect(body.messages).toEqual([chunkMessage]);
		});

		it("returns empty messages when polled again with no new messages", async () => {
			await server.fetch(
				makeRequest("POST", "append", { messages: [textMessage] }),
			);
			await server.fetch(makeRequest("GET", "messages")); // advances bookmark

			const res = await server.fetch(makeRequest("GET", "messages"));
			const body = (await res.json()) as StreamingMessagesState;
			expect(body.messages).toHaveLength(0);
		});

		it("reflects isDone=true when the conversation has been completed", async () => {
			await server.fetch(
				makeRequest("POST", "append", {
					messages: [textMessage],
					isDone: true,
				}),
			);

			const res = await server.fetch(makeRequest("GET", "messages"));
			const body = (await res.json()) as StreamingMessagesState;
			expect(body.isDone).toBe(true);
		});

		it("returns 500 when the conversation does not exist", async () => {
			mock.store.clear();

			const res = await server.fetch(makeRequest("GET", "messages"));
			expect(res.status).toBe(500);
		});

		// -------------------------------------------------------------------
		// Batching
		// -------------------------------------------------------------------

		it("retrieves exactly STORAGE_BATCH_SIZE messages in a single get call", async () => {
			const messages = generateMessages(STORAGE_BATCH_SIZE);
			await server.fetch(makeRequest("POST", "append", { messages }));
			vi.clearAllMocks();

			const res = await server.fetch(makeRequest("GET", "messages"));
			const body = (await res.json()) as StreamingMessagesState;

			// 1 get for getIsDoneAndReadWriteBookmarks + 1 get for the STORAGE_BATCH_SIZE message keys
			expect(mock.storage.get).toHaveBeenCalledTimes(2);
			expect(body.messages).toHaveLength(STORAGE_BATCH_SIZE);
			expect(body.messages).toEqual(messages);
		});

		it("splits into two get calls when fetching more than STORAGE_BATCH_SIZE messages", async () => {
			const count = STORAGE_BATCH_SIZE + 1;
			const messages = generateMessages(count);
			await server.fetch(makeRequest("POST", "append", { messages }));
			vi.clearAllMocks();

			const res = await server.fetch(makeRequest("GET", "messages"));
			const body = (await res.json()) as StreamingMessagesState;

			// 1 get for getIsDoneAndReadWriteBookmarks + 2 get batches for the message keys
			expect(mock.storage.get).toHaveBeenCalledTimes(3);
			expect(body.messages).toHaveLength(count);
			expect(body.messages).toEqual(messages);
		});

		it("correctly retrieves messages across three or more get batches", async () => {
			const count = STORAGE_BATCH_SIZE * 2 + 10;
			const messages = generateMessages(count);
			await server.fetch(makeRequest("POST", "append", { messages }));
			vi.clearAllMocks();

			const res = await server.fetch(makeRequest("GET", "messages"));
			const body = (await res.json()) as StreamingMessagesState;

			expect(body.messages).toHaveLength(count);
			expect(body.messages).toEqual(messages);
		});

		it("only fetches new messages across batches after bookmark advances", async () => {
			const firstBatch = generateMessages(STORAGE_BATCH_SIZE + 5);
			await server.fetch(
				makeRequest("POST", "append", { messages: firstBatch }),
			);
			// Consume first batch
			await server.fetch(makeRequest("GET", "messages"));

			const secondBatch = generateMessages(STORAGE_BATCH_SIZE + 3);
			await server.fetch(
				makeRequest("POST", "append", { messages: secondBatch }),
			);
			vi.clearAllMocks();

			const res = await server.fetch(makeRequest("GET", "messages"));
			const body = (await res.json()) as StreamingMessagesState;

			expect(body.messages).toHaveLength(secondBatch.length);
			expect(body.messages).toEqual(secondBatch);
		});
	});

	// -------------------------------------------------------------------------
	// alarm()
	// -------------------------------------------------------------------------

	describe("alarm()", () => {
		beforeEach(async () => {
			await server.fetch(makeRequest("POST", "initialize"));
			await server.fetch(
				makeRequest("POST", "append", { messages: [textMessage] }),
			);
		});

		it("deletes the conversation state and bookmark", async () => {
			await server.alarm();

			expect(mock.store.has("is-done")).toBe(false);
			expect(mock.store.has("message-0")).toBe(false);
			expect(mock.store.has("write-bookmark")).toBe(false);
			expect(mock.store.has("read-bookmark")).toBe(false);
		});

		it("causes subsequent append to return 500", async () => {
			await server.alarm();

			const res = await server.fetch(
				makeRequest("POST", "append", { messages: [chunkMessage] }),
			);
			expect(res.status).toBe(500);
		});

		it("causes subsequent GET /messages to return 500", async () => {
			await server.alarm();

			const res = await server.fetch(makeRequest("GET", "messages"));
			expect(res.status).toBe(500);
		});

		it("allows re-initialization after the alarm fires", async () => {
			await server.alarm();

			const res = await server.fetch(makeRequest("POST", "initialize"));
			expect(res.status).toBe(200);
		});
	});

	// -------------------------------------------------------------------------
	// Keep-warm token store + idle-session lifecycle
	// -------------------------------------------------------------------------

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

	// -------------------------------------------------------------------------
	// active-org token clear (used by the org-token 401 re-mint path)
	// -------------------------------------------------------------------------

	describe("POST /active-org-token clear", () => {
		it("deletes the stored org token when given an empty/null token", async () => {
			// Seed a token via active-org, then clear it with a null token.
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
});
