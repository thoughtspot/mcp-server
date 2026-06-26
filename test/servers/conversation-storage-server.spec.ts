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
			delete: vi.fn(async (keys: string[]): Promise<void> => {
				for (const key of keys) {
					store.delete(key);
				}
			}),
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
});
