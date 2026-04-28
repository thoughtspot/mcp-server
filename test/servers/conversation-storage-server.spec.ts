import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationStorageServer } from "../../src/servers/conversation-storage-server";
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
			get: vi.fn(async <T>(key: string): Promise<T | undefined> => {
				return store.get(key) as T | undefined;
			}),
			put: vi.fn(async (key: string, value: unknown): Promise<void> => {
				store.set(key, value);
			}),
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
		},
	};
}

function createServer(mock: ReturnType<typeof createMockStorage>) {
	const state = { storage: mock.storage } as unknown as DurableObjectState;
	return new ConversationStorageServer(state, {} as Env);
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
const textMessage: Message = { type: "text", text: "Hello" };
const chunkMessage: Message = { type: "text_chunk", text: " world" };
const answerMessage: Message = {
	type: "answer",
	answer_id: "ans-1",
	answer_title: "My Answer",
	answer_query: "SELECT 1",
	iframe_url: "https://example.com/answer/1",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationStorageServer", () => {
	let mock: ReturnType<typeof createMockStorage>;
	let server: ConversationStorageServer;

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

			const state = mock.store.get(
				"streaming-messages-state",
			) as StreamingMessagesState;
			expect(state).toMatchObject({ messages: [], isDone: false });
		});

		it("sets bookmark to 0", async () => {
			await server.fetch(makeRequest("POST", "initialize"));

			expect(mock.store.get("streaming-messages-bookmark")).toBe(0);
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

			const state = mock.store.get(
				"streaming-messages-state",
			) as StreamingMessagesState;
			expect(state).toMatchObject({ messages: [], isDone: false });
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

			const state = mock.store.get(
				"streaming-messages-state",
			) as StreamingMessagesState;
			expect(state.messages).toEqual([textMessage]);
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

			const state = mock.store.get(
				"streaming-messages-state",
			) as StreamingMessagesState;
			expect(state.messages).toEqual([
				textMessage,
				chunkMessage,
				answerMessage,
			]);
		});

		it("marks the conversation done when isDone is true", async () => {
			await server.fetch(
				makeRequest("POST", "append", {
					messages: [textMessage],
					isDone: true,
				}),
			);

			const state = mock.store.get(
				"streaming-messages-state",
			) as StreamingMessagesState;
			expect(state.isDone).toBe(true);
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

			expect(mock.store.has("streaming-messages-state")).toBe(false);
			expect(mock.store.has("streaming-messages-bookmark")).toBe(false);
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
