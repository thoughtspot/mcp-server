import { beforeEach, describe, expect, it, vi } from "vitest";
import { StorageServiceClient } from "../../src/storage-service/storage-service";
import type {
	Message,
	StreamingMessagesState,
} from "../../src/thoughtspot/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONVERSATION_ID = "conv-abc123";
const TOKEN_HASH = "abc12345";

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
		client = new StorageServiceClient(namespaceMock, TOKEN_HASH);
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
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			await expect(
				client.initializeConversation(CONVERSATION_ID),
			).rejects.toThrow("Failed to initialize conversation (500)");
		});

		it("includes the error body in the thrown error message", async () => {
			namespaceMock = makeNamespaceMock(
				"Conversation already exists and is not marked done",
				400,
			);
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

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
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			await expect(
				client.appendMessages(CONVERSATION_ID, [textMessage]),
			).rejects.toThrow("Failed to append messages (500)");
		});

		it("includes the error body in the thrown error message", async () => {
			namespaceMock = makeNamespaceMock(
				"Cannot append messages to a conversation marked done",
				400,
			);
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

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
			namespaceMock = makeNamespaceMock({
				messages: [textMessage],
				isDone: false,
			});
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

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
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			const result = await client.getNewMessages(CONVERSATION_ID);

			expect(result).toEqual(state);
		});

		it("returns an empty messages array when there are no new messages", async () => {
			namespaceMock = makeNamespaceMock({ messages: [], isDone: false });
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			const result = await client.getNewMessages(CONVERSATION_ID);

			expect(result.messages).toHaveLength(0);
			expect(result.isDone).toBe(false);
		});

		it("throws when the server returns a non-ok status", async () => {
			namespaceMock = makeNamespaceMock("Conversation not found", 404);
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			await expect(client.getNewMessages(CONVERSATION_ID)).rejects.toThrow(
				"Failed to get messages (404)",
			);
		});

		it("includes the error body in the thrown error message", async () => {
			namespaceMock = makeNamespaceMock("Internal error", 500);
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			await expect(client.getNewMessages(CONVERSATION_ID)).rejects.toThrow(
				"Internal error",
			);
		});
	});

	// -------------------------------------------------------------------------
	// DO instance keying — accessTokenHashUrlSafe isolation
	// -------------------------------------------------------------------------

	describe("DO instance keying", () => {
		it("keys the DO on <tokenHash>:<conversationId>", async () => {
			await client.initializeConversation(CONVERSATION_ID);

			expect(namespaceMock.idFromName).toHaveBeenCalledWith(
				`${TOKEN_HASH}:${CONVERSATION_ID}`,
			);
		});

		it("two clients with different token hashes produce different DO keys for the same conversationId", async () => {
			const namespaceA = makeNamespaceMock();
			const namespaceB = makeNamespaceMock();
			const clientA = new StorageServiceClient(namespaceA, "hash-user-a");
			const clientB = new StorageServiceClient(namespaceB, "hash-user-b");

			await clientA.initializeConversation(CONVERSATION_ID);
			await clientB.initializeConversation(CONVERSATION_ID);

			expect(namespaceA.idFromName).toHaveBeenCalledWith(
				`hash-user-a:${CONVERSATION_ID}`,
			);
			expect(namespaceB.idFromName).toHaveBeenCalledWith(
				`hash-user-b:${CONVERSATION_ID}`,
			);
			// The two resulting keys must differ
			const keyA = (namespaceA.idFromName as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as string;
			const keyB = (namespaceB.idFromName as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as string;
			expect(keyA).not.toBe(keyB);
		});

		it("uses the same DO key across all operations for a given client", async () => {
			await client.initializeConversation(CONVERSATION_ID);
			await client.appendMessages(CONVERSATION_ID, [textMessage]);

			namespaceMock = makeNamespaceMock({ messages: [], isDone: false });
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);
			await client.getNewMessages(CONVERSATION_ID);

			expect(namespaceMock.idFromName).toHaveBeenCalledWith(
				`${TOKEN_HASH}:${CONVERSATION_ID}`,
			);
		});
	});
});
