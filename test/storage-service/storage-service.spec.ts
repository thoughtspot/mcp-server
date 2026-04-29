import { describe, it, expect, vi, beforeEach } from "vitest";
import { StorageServiceClient } from "../../src/storage-service/storage-service";
import type {
	Message,
	StreamingMessagesState,
} from "../../src/thoughtspot/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Captured request from the stub's last fetch call
let lastStubRequest: Request | undefined;

function makeNamespaceMock(
	responseBody: unknown = { ok: true },
	status = 200,
): DurableObjectNamespace {
	lastStubRequest = undefined;
	const stub = {
		fetch: vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			lastStubRequest = new Request(input, init);
			const body =
				typeof responseBody === "string"
					? responseBody
					: JSON.stringify(responseBody);
			return new Response(body, {
				status,
				headers: { "Content-Type": "application/json" },
			});
		}),
	} as unknown as DurableObjectStub;

	return {
		idFromName: vi.fn(() => ({ toString: () => "stub-id" }) as DurableObjectId),
		get: vi.fn(() => stub),
	} as unknown as DurableObjectNamespace;
}

function lastRequest(): Request {
	if (!lastStubRequest) throw new Error("No stub request recorded");
	return lastStubRequest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StorageServiceClient", () => {
	let client: StorageServiceClient;
	let namespaceMock: DurableObjectNamespace;

	beforeEach(() => {
		vi.restoreAllMocks();
		namespaceMock = makeNamespaceMock();
		client = new StorageServiceClient(namespaceMock);
	});

	// -------------------------------------------------------------------------
	// initializeConversation
	// -------------------------------------------------------------------------

	describe("initializeConversation", () => {
		it("sends POST to /storage/<id>/initialize", async () => {
			await client.initializeConversation(CONVERSATION_ID);

			const req = lastRequest();
			expect(req.url).toBe(
				`https://internal/storage/${CONVERSATION_ID}/initialize`,
			);
			expect(req.method).toBe("POST");
		});

		it("URL-encodes the conversation ID", async () => {
			await client.initializeConversation("conv with spaces/and-slash");

			const req = lastRequest();
			expect(req.url).toBe(
				"https://internal/storage/conv%20with%20spaces%2Fand-slash/initialize",
			);
		});

		it("resolves without error on a 200 response", async () => {
			await expect(
				client.initializeConversation(CONVERSATION_ID),
			).resolves.toBeUndefined();
		});

		it("throws when the server returns a non-ok status", async () => {
			namespaceMock = makeNamespaceMock("Something went wrong", 500);
			client = new StorageServiceClient(namespaceMock);

			await expect(
				client.initializeConversation(CONVERSATION_ID),
			).rejects.toThrow("Failed to initialize conversation (500)");
		});

		it("includes the error body in the thrown error message", async () => {
			namespaceMock = makeNamespaceMock(
				"Conversation already exists and is not marked done",
				400,
			);
			client = new StorageServiceClient(namespaceMock);

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
			await client.appendMessages(CONVERSATION_ID, [textMessage]);

			const req = lastRequest();
			expect(req.url).toBe(
				`https://internal/storage/${CONVERSATION_ID}/append`,
			);
			expect(req.method).toBe("POST");
		});

		it("sends messages and isDone=false in the request body by default", async () => {
			await client.appendMessages(CONVERSATION_ID, [textMessage, chunkMessage]);

			const body = (await lastRequest().json()) as StreamingMessagesState;
			expect(body.messages).toEqual([textMessage, chunkMessage]);
			expect(body.isDone).toBe(false);
		});

		it("sends isDone=true when specified", async () => {
			await client.appendMessages(CONVERSATION_ID, [answerMessage], true);

			const body = (await lastRequest().json()) as StreamingMessagesState;
			expect(body.isDone).toBe(true);
		});

		it("sends Content-Type: application/json", async () => {
			await client.appendMessages(CONVERSATION_ID, []);

			expect(lastRequest().headers.get("Content-Type")).toBe(
				"application/json",
			);
		});

		it("resolves without error on a 200 response", async () => {
			await expect(
				client.appendMessages(CONVERSATION_ID, [textMessage]),
			).resolves.toBeUndefined();
		});

		it("throws when the server returns a non-ok status", async () => {
			namespaceMock = makeNamespaceMock("Conversation not found", 500);
			client = new StorageServiceClient(namespaceMock);

			await expect(
				client.appendMessages(CONVERSATION_ID, [textMessage]),
			).rejects.toThrow("Failed to append messages (500)");
		});

		it("includes the error body in the thrown error message", async () => {
			namespaceMock = makeNamespaceMock(
				"Cannot append messages to a conversation marked done",
				400,
			);
			client = new StorageServiceClient(namespaceMock);

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
			namespaceMock = makeNamespaceMock({ messages: [textMessage], isDone: false });
			client = new StorageServiceClient(namespaceMock);

			await client.getNewMessages(CONVERSATION_ID);

			const req = lastRequest();
			expect(req.url).toBe(
				`https://internal/storage/${CONVERSATION_ID}/messages`,
			);
			expect(req.method).toBe("GET");
		});

		it("returns the parsed StreamingMessagesState", async () => {
			const state: StreamingMessagesState = {
				messages: [textMessage, answerMessage],
				isDone: true,
			};
			namespaceMock = makeNamespaceMock(state);
			client = new StorageServiceClient(namespaceMock);

			const result = await client.getNewMessages(CONVERSATION_ID);

			expect(result).toEqual(state);
		});

		it("returns an empty messages array when there are no new messages", async () => {
			namespaceMock = makeNamespaceMock({ messages: [], isDone: false });
			client = new StorageServiceClient(namespaceMock);

			const result = await client.getNewMessages(CONVERSATION_ID);

			expect(result.messages).toHaveLength(0);
			expect(result.isDone).toBe(false);
		});

		it("throws when the server returns a non-ok status", async () => {
			namespaceMock = makeNamespaceMock("Conversation not found", 404);
			client = new StorageServiceClient(namespaceMock);

			await expect(client.getNewMessages(CONVERSATION_ID)).rejects.toThrow(
				"Failed to get messages (404)",
			);
		});

		it("includes the error body in the thrown error message", async () => {
			namespaceMock = makeNamespaceMock("Internal error", 500);
			client = new StorageServiceClient(namespaceMock);

			await expect(client.getNewMessages(CONVERSATION_ID)).rejects.toThrow(
				"Internal error",
			);
		});
	});
});
