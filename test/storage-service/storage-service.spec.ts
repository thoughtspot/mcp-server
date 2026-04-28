import { describe, it, expect, vi, beforeEach } from "vitest";
import { StorageServiceClient } from "../../src/storage-service/storage-service";
import type {
	Message,
	StreamingMessagesState,
} from "../../src/thoughtspot/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://example.com";
const AUTH_TOKEN = "test-token";
const CONVERSATION_ID = "conv-abc123";

const textMessage: Message = { type: "text", text: "Hello" };
const chunkMessage: Message = { type: "text_chunk", text: " world" };
const answerMessage: Message = {
	type: "answer",
	answer_id: "ans-1",
	answer_title: "My Answer",
	answer_query: "SELECT 1",
	iframe_url: "https://example.com/answer/1",
};

function mockFetchOk(body: unknown = { ok: true }): void {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		),
	);
}

function mockFetchError(status: number, body: string): void {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(new Response(body, { status })),
	);
}

function lastFetchCall(): { url: string; init: RequestInit } {
	const mockFn = vi.mocked(fetch);
	const [url, init] = mockFn.mock.calls[mockFn.mock.calls.length - 1] as [
		string,
		RequestInit,
	];
	return { url, init };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StorageServiceClient", () => {
	let client: StorageServiceClient;

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		client = new StorageServiceClient(BASE_URL, AUTH_TOKEN);
	});

	// -------------------------------------------------------------------------
	// initializeConversation
	// -------------------------------------------------------------------------

	describe("initializeConversation", () => {
		it("sends POST to /storage/<id>/initialize", async () => {
			mockFetchOk();

			await client.initializeConversation(CONVERSATION_ID);

			const { url, init } = lastFetchCall();
			expect(url).toBe(`${BASE_URL}/storage/${CONVERSATION_ID}/initialize`);
			expect(init.method).toBe("POST");
		});

		it("sends the Authorization header", async () => {
			mockFetchOk();

			await client.initializeConversation(CONVERSATION_ID);

			const { init } = lastFetchCall();
			expect((init.headers as Record<string, string>).Authorization).toBe(
				`Bearer ${AUTH_TOKEN}`,
			);
		});

		it("URL-encodes the conversation ID", async () => {
			mockFetchOk();

			await client.initializeConversation("conv with spaces/and-slash");

			const { url } = lastFetchCall();
			expect(url).toBe(
				`${BASE_URL}/storage/conv%20with%20spaces%2Fand-slash/initialize`,
			);
		});

		it("resolves without error on a 200 response", async () => {
			mockFetchOk();
			await expect(
				client.initializeConversation(CONVERSATION_ID),
			).resolves.toBeUndefined();
		});

		it("throws when the server returns a non-ok status", async () => {
			mockFetchError(500, "Something went wrong");

			await expect(
				client.initializeConversation(CONVERSATION_ID),
			).rejects.toThrow("Failed to initialize conversation (500)");
		});

		it("includes the error body in the thrown error message", async () => {
			mockFetchError(400, "Conversation already exists and is not marked done");

			await expect(
				client.initializeConversation(CONVERSATION_ID),
			).rejects.toThrow("Conversation already exists and is not marked done");
		});
	});

	// -------------------------------------------------------------------------
	// appendMessages
	// -------------------------------------------------------------------------

	describe("appendMessages", () => {
		it("sends POST to /storage/<id>/append", async () => {
			mockFetchOk();

			await client.appendMessages(CONVERSATION_ID, [textMessage]);

			const { url, init } = lastFetchCall();
			expect(url).toBe(`${BASE_URL}/storage/${CONVERSATION_ID}/append`);
			expect(init.method).toBe("POST");
		});

		it("sends messages and isDone=false in the request body by default", async () => {
			mockFetchOk();

			await client.appendMessages(CONVERSATION_ID, [textMessage, chunkMessage]);

			const { init } = lastFetchCall();
			const body = JSON.parse(init.body as string) as StreamingMessagesState;
			expect(body.messages).toEqual([textMessage, chunkMessage]);
			expect(body.isDone).toBe(false);
		});

		it("sends isDone=true when specified", async () => {
			mockFetchOk();

			await client.appendMessages(CONVERSATION_ID, [answerMessage], true);

			const { init } = lastFetchCall();
			const body = JSON.parse(init.body as string) as StreamingMessagesState;
			expect(body.isDone).toBe(true);
		});

		it("sends the Authorization header", async () => {
			mockFetchOk();

			await client.appendMessages(CONVERSATION_ID, []);

			const { init } = lastFetchCall();
			expect((init.headers as Record<string, string>).Authorization).toBe(
				`Bearer ${AUTH_TOKEN}`,
			);
		});

		it("sends Content-Type: application/json", async () => {
			mockFetchOk();

			await client.appendMessages(CONVERSATION_ID, []);

			const { init } = lastFetchCall();
			expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
				"application/json",
			);
		});

		it("resolves without error on a 200 response", async () => {
			mockFetchOk();
			await expect(
				client.appendMessages(CONVERSATION_ID, [textMessage]),
			).resolves.toBeUndefined();
		});

		it("throws when the server returns a non-ok status", async () => {
			mockFetchError(500, "Conversation not found");

			await expect(
				client.appendMessages(CONVERSATION_ID, [textMessage]),
			).rejects.toThrow("Failed to append messages (500)");
		});

		it("includes the error body in the thrown error message", async () => {
			mockFetchError(
				400,
				"Cannot append messages to a conversation marked done",
			);

			await expect(
				client.appendMessages(CONVERSATION_ID, [textMessage]),
			).rejects.toThrow("Cannot append messages to a conversation marked done");
		});
	});

	// -------------------------------------------------------------------------
	// getNewMessages
	// -------------------------------------------------------------------------

	describe("getNewMessages", () => {
		it("sends GET to /storage/<id>/messages", async () => {
			const state: StreamingMessagesState = {
				messages: [textMessage],
				isDone: false,
			};
			mockFetchOk(state);

			await client.getNewMessages(CONVERSATION_ID);

			const { url, init } = lastFetchCall();
			expect(url).toBe(`${BASE_URL}/storage/${CONVERSATION_ID}/messages`);
			expect(init.method).toBe("GET");
		});

		it("sends the Authorization header", async () => {
			mockFetchOk({ messages: [], isDone: false });

			await client.getNewMessages(CONVERSATION_ID);

			const { init } = lastFetchCall();
			expect((init.headers as Record<string, string>).Authorization).toBe(
				`Bearer ${AUTH_TOKEN}`,
			);
		});

		it("returns the parsed StreamingMessagesState", async () => {
			const state: StreamingMessagesState = {
				messages: [textMessage, answerMessage],
				isDone: true,
			};
			mockFetchOk(state);

			const result = await client.getNewMessages(CONVERSATION_ID);

			expect(result).toEqual(state);
		});

		it("returns an empty messages array when there are no new messages", async () => {
			mockFetchOk({ messages: [], isDone: false });

			const result = await client.getNewMessages(CONVERSATION_ID);

			expect(result.messages).toHaveLength(0);
			expect(result.isDone).toBe(false);
		});

		it("throws when the server returns a non-ok status", async () => {
			mockFetchError(404, "Conversation not found");

			await expect(client.getNewMessages(CONVERSATION_ID)).rejects.toThrow(
				"Failed to get messages (404)",
			);
		});

		it("includes the error body in the thrown error message", async () => {
			mockFetchError(500, "Internal error");

			await expect(client.getNewMessages(CONVERSATION_ID)).rejects.toThrow(
				"Internal error",
			);
		});
	});
});
