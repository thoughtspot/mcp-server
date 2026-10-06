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
	// getMetadata
	// -------------------------------------------------------------------------

	// getMetadata / updateMetadata sit on the shared `/state` slot (putSessionState /
	// getSessionState) rather than a dedicated route, so these assert that contract.

	/**
	 * Stateful stub: GET /state returns whatever was last POSTed (or `initial`), and every request
	 * is recorded. The shared mock only remembers one canned body, which cannot express the
	 * read-then-write that updateMetadata does.
	 */
	function makeStateStub(initial: unknown = null, failStatus?: number) {
		let stored: unknown = initial;
		const requests: { method: string; url: string; body: unknown }[] = [];
		const stub = {
			fetch: vi.fn(async (input: RequestInfo, init?: RequestInit) => {
				const req = new Request(input, init);
				const text = req.method === "GET" ? "" : await req.text();
				requests.push({
					method: req.method,
					url: req.url,
					body: text ? JSON.parse(text) : undefined,
				});
				if (failStatus) {
					return new Response("Conversation not found", { status: failStatus });
				}
				if (req.method === "POST") {
					stored = JSON.parse(text);
					return Response.json({ ok: true });
				}
				return Response.json(stored);
			}),
		} as unknown as DurableObjectStub;
		const ns = {
			idFromName: vi.fn(
				() => ({ toString: () => "stub-id" }) as DurableObjectId,
			),
			get: vi.fn(() => stub),
		} as unknown as DurableObjectNamespace;
		return {
			client: new StorageServiceClient(ns, TOKEN_HASH),
			requests,
			stored: () => stored,
		};
	}

	const STATE_URL = `https://internal/storage/${CONVERSATION_ID}/state`;

	describe("getMetadata", () => {
		it("reads the session's /state slot", async () => {
			const { client, requests } = makeStateStub({ foo: "bar" });

			await client.getMetadata(CONVERSATION_ID);

			expect(requests).toHaveLength(1);
			expect(requests[0].method).toBe("GET");
			expect(requests[0].url).toBe(STATE_URL);
		});

		it("returns the stored state", async () => {
			const state = { foo: "bar", count: 7, nested: { a: 1 } };
			const { client } = makeStateStub(state);

			expect(await client.getMetadata(CONVERSATION_ID)).toEqual(state);
		});

		it("throws when no state has been stored", async () => {
			// Callers treat a missing session as an error (e.g. submitting to an expired task), so an
			// empty slot must not come back as a silently empty object.
			const { client } = makeStateStub(null);

			await expect(client.getMetadata(CONVERSATION_ID)).rejects.toThrow(
				`No session state stored for ${CONVERSATION_ID}`,
			);
		});

		it("throws with status and body when the server returns a non-ok status", async () => {
			const { client } = makeStateStub(null, 404);

			await expect(client.getMetadata(CONVERSATION_ID)).rejects.toThrow(
				/Failed to get session state \(404\).*Conversation not found/,
			);
		});
	});

	describe("updateMetadata", () => {
		it("reads the current state, then writes the shallow-merged result", async () => {
			const { client, requests } = makeStateStub({ existing: 1, count: 2 });

			await client.updateMetadata(CONVERSATION_ID, {
				count: 5,
				status: "active",
			});

			expect(requests.map((r) => r.method)).toEqual(["GET", "POST"]);
			expect(requests.every((r) => r.url === STATE_URL)).toBe(true);
			expect(requests[1].body).toEqual({
				existing: 1,
				count: 5,
				status: "active",
			});
		});

		it("returns the merged state", async () => {
			const { client } = makeStateStub({ existing: 1 });

			const result = await client.updateMetadata(CONVERSATION_ID, { count: 5 });

			expect(result).toEqual({ existing: 1, count: 5 });
		});

		it("starts from an empty object when nothing is stored yet", async () => {
			const { client, stored } = makeStateStub(null);

			await client.updateMetadata(CONVERSATION_ID, { first: true });

			expect(stored()).toEqual({ first: true });
		});

		it("preserves keys it was not asked to change across successive patches", async () => {
			// The SSE drain patches generationNumber while the orchestrator patches turn state on
			// the same session; sequential patches must not clobber each other's keys.
			const { client, stored } = makeStateStub({ liveboardId: "lb-1" });

			await client.updateMetadata(CONVERSATION_ID, { generationNumber: "7" });
			await client.updateMetadata(CONVERSATION_ID, { pollCount: 2 });

			expect(stored()).toEqual({
				liveboardId: "lb-1",
				generationNumber: "7",
				pollCount: 2,
			});
		});

		it("throws when the server returns a non-ok status", async () => {
			const { client } = makeStateStub(null, 404);

			await expect(
				client.updateMetadata(CONVERSATION_ID, { foo: "bar" }),
			).rejects.toThrow("Failed to get session state (404)");
		});
	});

	// -------------------------------------------------------------------------
	// appendEvents / getNewEvents — generic SpotterViz path
	// -------------------------------------------------------------------------

	describe("appendEvents (generic)", () => {
		interface CustomEvent {
			kind: string;
			payload: Record<string, unknown>;
		}

		it("sends POST to /storage/<id>/append with events under the 'messages' wire field", async () => {
			const events: CustomEvent[] = [
				{ kind: "open", payload: { id: 1 } },
				{ kind: "close", payload: { reason: "ok" } },
			];

			await client.appendEvents<CustomEvent>(CONVERSATION_ID, events);

			const req = lastRequest();
			expect(req.url).toBe(
				`https://internal/storage/${CONVERSATION_ID}/append`,
			);
			expect(req.method).toBe("POST");
			const body = (await req.json()) as {
				messages: CustomEvent[];
				isDone: boolean;
			};
			expect(body.messages).toEqual(events);
			expect(body.isDone).toBe(false);
		});

		it("sends isDone=true when specified", async () => {
			await client.appendEvents<CustomEvent>(CONVERSATION_ID, [], true);

			const body = (await lastRequest().json()) as { isDone: boolean };
			expect(body.isDone).toBe(true);
		});

		it("supports empty event arrays (used to mark done-only)", async () => {
			await client.appendEvents<CustomEvent>(CONVERSATION_ID, [], true);

			const body = (await lastRequest().json()) as {
				messages: CustomEvent[];
				isDone: boolean;
			};
			expect(body.messages).toEqual([]);
			expect(body.isDone).toBe(true);
		});

		it("throws when the server returns a non-ok status", async () => {
			namespaceMock = makeNamespaceMock("Cannot append", 400);
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			await expect(
				client.appendEvents<CustomEvent>(CONVERSATION_ID, [
					{ kind: "x", payload: {} },
				]),
			).rejects.toThrow("Failed to append events (400)");
		});
	});

	describe("getNewEvents (generic)", () => {
		interface CustomEvent {
			kind: string;
		}

		it("sends GET to /storage/<id>/messages", async () => {
			namespaceMock = makeNamespaceMock({ messages: [], isDone: false });
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			await client.getNewEvents<CustomEvent>(CONVERSATION_ID);

			const req = lastRequest();
			expect(req.url).toBe(
				`https://internal/storage/${CONVERSATION_ID}/messages`,
			);
			expect(req.method).toBe("GET");
		});

		it("returns the parsed { messages, isDone } payload typed to the caller's T", async () => {
			const payload = {
				messages: [{ kind: "a" }, { kind: "b" }] as CustomEvent[],
				isDone: true,
			};
			namespaceMock = makeNamespaceMock(payload);
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			const result = await client.getNewEvents<CustomEvent>(CONVERSATION_ID);

			expect(result).toEqual(payload);
			expect(result.messages[0].kind).toBe("a");
		});

		it("throws when the server returns a non-ok status", async () => {
			namespaceMock = makeNamespaceMock("Conversation not found", 404);
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			await expect(
				client.getNewEvents<CustomEvent>(CONVERSATION_ID),
			).rejects.toThrow("Failed to get events (404)");
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

	// -------------------------------------------------------------------------
	// putSessionState
	// -------------------------------------------------------------------------

	describe("putSessionState", () => {
		// Shaped like a Spotter Model session; the client is generic over the payload.
		const state = { transactionId: "txn-1", generationNo: 3 };

		it("sends POST to /storage/<id>/state with the state as the body", async () => {
			await client.putSessionState(CONVERSATION_ID, state);

			const req = lastRequest();
			expect(req.url).toBe(`https://internal/storage/${CONVERSATION_ID}/state`);
			expect(req.method).toBe("POST");
			expect(await req.json()).toEqual(state);
		});

		it("URL-encodes the conversation ID", async () => {
			await client.putSessionState("conv with spaces/and-slash", state);

			expect(lastRequest().url).toBe(
				"https://internal/storage/conv%20with%20spaces%2Fand-slash/state",
			);
		});

		it("resolves without error on a 200 response", async () => {
			await expect(
				client.putSessionState(CONVERSATION_ID, state),
			).resolves.toBeUndefined();
		});

		it("throws with the status and body on a failure response", async () => {
			namespaceMock = makeNamespaceMock("boom", 500);
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			await expect(
				client.putSessionState(CONVERSATION_ID, state),
			).rejects.toThrow("Failed to put session state (500): boom");
		});

		it("routes to the per-user DO key", async () => {
			await client.putSessionState(CONVERSATION_ID, state);

			expect(namespaceMock.idFromName).toHaveBeenCalledWith(
				`${TOKEN_HASH}:${CONVERSATION_ID}`,
			);
		});
	});

	// -------------------------------------------------------------------------
	// getSessionState
	// -------------------------------------------------------------------------

	describe("getSessionState", () => {
		it("sends GET to /storage/<id>/state and returns the parsed state", async () => {
			const state = { transactionId: "txn-1", genNoWorkingSet: [2, 3] };
			namespaceMock = makeNamespaceMock(state);
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			const result =
				await client.getSessionState<typeof state>(CONVERSATION_ID);

			expect(lastRequest().url).toBe(
				`https://internal/storage/${CONVERSATION_ID}/state`,
			);
			expect(lastRequest().method).toBe("GET");
			expect(result).toEqual(state);
		});

		it("returns null when no state has been stored", async () => {
			namespaceMock = makeNamespaceMock(null);
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			expect(await client.getSessionState(CONVERSATION_ID)).toBeNull();
		});

		it("throws with the status and body on a failure response", async () => {
			namespaceMock = makeNamespaceMock("nope", 500);
			client = new StorageServiceClient(namespaceMock, TOKEN_HASH);

			await expect(client.getSessionState(CONVERSATION_ID)).rejects.toThrow(
				"Failed to get session state (500): nope",
			);
		});
	});
});
