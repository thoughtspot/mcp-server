/**
 * Integration tests for the V2 API of the MCP server.
 *
 * Each test group wires real components together without mocking the interfaces
 * between them:
 *
 *   Group 1 — StorageServiceClient ↔ ConversationStorageServer
 *     Tests the HTTP contract between the client and the Durable Object.
 *     Catches URL-encoding mismatches, JSON shape incompatibilities, or bookmark
 *     logic bugs that would be invisible when both sides are independently mocked.
 *
 *   Group 2 — MCPServer V2 tools + real storage pipeline
 *     send_session_message / get_session_updates with a real StorageServiceClient
 *     backed by a real ConversationStorageServer.  Only the ThoughtSpot API client
 *     (external network boundary) is mocked.
 *
 *   Group 3 — Streaming parser + real storage
 *     processSendAgentConversationMessageStreamingResponse writes parsed messages
 *     into a real ConversationStorageServer via a real StorageServiceClient.
 *     Verifies that SSE bytes produce the correct DO state end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationStorageServer } from "../../src/servers/conversation-storage-server";
import { MCPServer } from "../../src/servers/mcp-server";
import { StorageServiceClient } from "../../src/storage-service/storage-service";
import { StreamingMessagesStorageWithTtl } from "../../src/streaming-message-storage-with-ttl/streaming-message-storage-with-ttl";
import { processSendAgentConversationMessageStreamingResponse } from "../../src/streaming-utils";
import * as thoughtspotClient from "../../src/thoughtspot/thoughtspot-client";
import type { Message } from "../../src/thoughtspot/types";
import { makeRequest } from "./helpers";

vi.mock("../../src/metrics/mixpanel/mixpanel", () => ({
	MixpanelTracker: class {
		track() {}
	},
}));

// ---------------------------------------------------------------------------
// Infrastructure helpers
// ---------------------------------------------------------------------------

/** In-memory DurableObjectState that mirrors the real Cloudflare API surface. */
function createMockDoState() {
	const store = new Map<string, unknown>();

	const storage = {
		get: vi.fn(
			async <T>(
				keyOrKeys: string | string[],
			): Promise<T | undefined | Map<string, T>> => {
				if (Array.isArray(keyOrKeys)) {
					const result = new Map<string, T>();
					for (const key of keyOrKeys) {
						if (store.has(key)) result.set(key, store.get(key) as T);
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
			for (const key of keys) store.delete(key);
		}),
		setAlarm: vi.fn(async (): Promise<void> => {}),
		deleteAlarm: vi.fn(async (): Promise<void> => {}),
		deleteAll: vi.fn(async (): Promise<void> => {
			store.clear();
		}),
	};

	return { store, storage };
}

/**
 * Creates a real ConversationStorageServer backed by in-memory state, then wraps
 * it in a mock DurableObjectNamespace so that a real StorageServiceClient can call
 * it directly without going through the Cloudflare runtime.
 */
function createRealStorageClient(): StorageServiceClient {
	const { storage } = createMockDoState();
	const server = new ConversationStorageServer(
		{ storage } as unknown as DurableObjectState,
		{} as Env,
	);

	const stub = {
		fetch: (input: RequestInfo, init?: RequestInit) =>
			server.fetch(new Request(input, init)),
	} as unknown as DurableObjectStub;

	const namespace = {
		idFromName: vi.fn(() => ({ toString: () => "stub-id" }) as DurableObjectId),
		get: vi.fn(() => stub),
	} as unknown as DurableObjectNamespace;

	return new StorageServiceClient(namespace);
}

/** Minimal mock props for MCPServer construction. */
const mockProps = {
	instanceUrl: "https://test.thoughtspot.cloud",
	accessToken: "test-access-token",
	clientName: {
		clientId: "test-client-id",
		clientName: "test-client",
		registrationDate: Date.now(),
	},
};

/** Minimal getSessionInfo response that satisfies BaseMCPServer.init(). */
const mockSessionInfoResponse = {
	clusterId: "test-cluster-123",
	clusterName: "test-cluster",
	releaseVersion: "10.13.0.cl-110",
	userGUID: "test-user-123",
	configInfo: {
		mixpanelConfig: {
			devSdkKey: "test-dev-token",
			prodSdkKey: "test-prod-token",
			production: false,
		},
		selfClusterName: "test-cluster",
		selfClusterId: "test-cluster-123",
		enableSpotterDataSourceDiscovery: true,
	},
	userName: "test-user",
	currentOrgId: "test-org",
	privileges: [],
};

/** Helper to build a ReadableStreamDefaultReader from SSE line chunks. */
function makeReader(chunks: string[]): ReadableStreamDefaultReader {
	let index = 0;
	return {
		read: vi.fn(async () => {
			if (index < chunks.length) {
				const value = new TextEncoder().encode(chunks[index++]);
				return { done: false, value };
			}
			return { done: true, value: undefined };
		}),
		cancel: vi.fn(),
		releaseLock: vi.fn(),
	} as unknown as ReadableStreamDefaultReader;
}

// ---------------------------------------------------------------------------
// Group 1 — StorageServiceClient ↔ ConversationStorageServer
// ---------------------------------------------------------------------------

describe("V2 Storage Layer Integration (StorageServiceClient ↔ ConversationStorageServer)", () => {
	it("initialize → append → getNewMessages returns messages in insertion order", async () => {
		const client = createRealStorageClient();
		const msg1: Message = {
			type: "text",
			text: "Thinking…",
			is_thinking: true,
		};
		const msg2: Message = {
			type: "answer",
			answer_id: JSON.stringify({ session_id: "s1", gen_no: 1 }),
			answer_title: "Revenue Chart",
			answer_query: "revenue by region",
			iframe_url: "https://test.thoughtspot.cloud/?tsmcp=true#/embed/1",
			is_thinking: false,
		};

		await client.initializeConversation("conv-1");
		await client.appendMessages("conv-1", [msg1]);
		await client.appendMessages("conv-1", [msg2]);

		const state = await client.getNewMessages("conv-1");

		expect(state.messages).toEqual([msg1, msg2]);
		expect(state.isDone).toBe(false);
	});

	it("bookmark advances on each getNewMessages call — subsequent calls only return new messages", async () => {
		const client = createRealStorageClient();
		const msg1: Message = { type: "text", text: "First", is_thinking: false };
		const msg2: Message = { type: "text", text: "Second", is_thinking: false };

		await client.initializeConversation("conv-2");
		await client.appendMessages("conv-2", [msg1]);

		// First poll: consumes msg1, advances bookmark
		const first = await client.getNewMessages("conv-2");
		expect(first.messages).toEqual([msg1]);

		await client.appendMessages("conv-2", [msg2]);

		// Second poll: only msg2 (bookmark did not reset)
		const second = await client.getNewMessages("conv-2");
		expect(second.messages).toEqual([msg2]);

		// Third poll: no new messages
		const third = await client.getNewMessages("conv-2");
		expect(third.messages).toHaveLength(0);
	});

	it("isDone is propagated from append → getNewMessages", async () => {
		const client = createRealStorageClient();
		const msg: Message = { type: "text", text: "Done.", is_thinking: false };

		await client.initializeConversation("conv-3");
		await client.appendMessages("conv-3", [msg], true);

		const state = await client.getNewMessages("conv-3");
		expect(state.isDone).toBe(true);
	});

	it("re-initialize after done resets the conversation for a follow-up", async () => {
		const client = createRealStorageClient();
		const msg1: Message = {
			type: "text",
			text: "First answer.",
			is_thinking: false,
		};
		const msg2: Message = {
			type: "text",
			text: "Follow-up answer.",
			is_thinking: false,
		};

		await client.initializeConversation("conv-4");
		await client.appendMessages("conv-4", [msg1], true /* isDone */);
		// Consume so the bookmark is at the end of the first turn
		await client.getNewMessages("conv-4");

		// Re-initialize for a follow-up
		await client.initializeConversation("conv-4");
		await client.appendMessages("conv-4", [msg2], true);

		const state = await client.getNewMessages("conv-4");
		expect(state.messages).toEqual([msg2]);
		expect(state.isDone).toBe(true);
	});

	it("initializeConversation throws when the conversation is already ongoing", async () => {
		const client = createRealStorageClient();

		await client.initializeConversation("conv-5");
		// Not yet marked done — second initialize must fail

		await expect(client.initializeConversation("conv-5")).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Group 2 — MCPServer V2 tools + real storage pipeline
// ---------------------------------------------------------------------------

describe("V2 MCPServer + Real Storage Integration", () => {
	let testServer: MCPServer;
	let realStorage: StorageServiceClient;

	beforeEach(async () => {
		vi.clearAllMocks();

		// Mock the external ThoughtSpot API client (network boundary)
		vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
			getSessionInfo: vi.fn().mockResolvedValue(mockSessionInfoResponse),
			instanceUrl: "https://test.thoughtspot.cloud",
		} as any);

		testServer = new MCPServer(
			{ props: mockProps },
			new StreamingMessagesStorageWithTtl(null as any, vi.fn(), vi.fn()),
		);

		realStorage = createRealStorageClient();
		vi.spyOn(testServer as any, "getStorageService").mockReturnValue(
			realStorage,
		);

		await testServer.init();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("send_session_message stores messages in real storage; get_session_updates retrieves them", async () => {
		const expectedMessages: Message[] = [
			{ type: "text", text: "Analyzing data…", is_thinking: true },
			{ type: "text", text: "Revenue is $5M.", is_thinking: false },
		];

		// After init(), spy getThoughtSpotService so tool calls get our controlled streaming mock
		vi.spyOn(testServer as any, "getThoughtSpotService").mockReturnValue({
			sendAgentConversationMessageStreaming: vi
				.fn()
				.mockImplementation(
					async (
						convId: string,
						_msg: string,
						appendFn: typeof realStorage.appendMessages,
					) => {
						await appendFn(convId, [expectedMessages[0]]);
						await appendFn(convId, [expectedMessages[1]], true /* isDone */);
					},
				),
		});

		const sendResult = await testServer.callSendSessionMessage(
			makeRequest("send_session_message", {
				analytical_session_id: "session-int-1",
				message: "What is the total revenue?",
			}),
		);
		expect(sendResult.isError).toBeUndefined();
		expect((sendResult.structuredContent as any).success).toBe(true);

		const updatesResult = await testServer.callGetSessionUpdates(
			makeRequest("get_session_updates", {
				analytical_session_id: "session-int-1",
			}),
		);
		expect(updatesResult.isError).toBeUndefined();
		const content = updatesResult.structuredContent as any;
		expect(content.is_done).toBe(true);
		expect(content.session_updates).toEqual(expectedMessages);
	});

	it("second send_session_message fails when first session response is still ongoing", async () => {
		// First send: streaming mock does NOT mark the conversation done
		vi.spyOn(testServer as any, "getThoughtSpotService").mockReturnValue({
			sendAgentConversationMessageStreaming: vi
				.fn()
				.mockImplementation(
					async (
						convId: string,
						_msg: string,
						appendFn: typeof realStorage.appendMessages,
					) => {
						// Append but leave isDone = false
						await appendFn(convId, [
							{ type: "text", text: "Still thinking…", is_thinking: true },
						]);
					},
				),
		});

		// First send succeeds
		const first = await testServer.callSendSessionMessage(
			makeRequest("send_session_message", {
				analytical_session_id: "session-int-2",
				message: "How many orders?",
			}),
		);
		expect(first.isError).toBeUndefined();

		// Second send on the same session before it's done must be rejected
		const second = await testServer.callSendSessionMessage(
			makeRequest("send_session_message", {
				analytical_session_id: "session-int-2",
				message: "Follow-up too early",
			}),
		);
		expect(second.isError).toBe(true);
		expect((second.content as any[])[0].text).toContain(
			"ongoing response to the previous message",
		);
	});

	it("get_session_updates reflects real bookmark — second poll after re-init returns only new messages", async () => {
		const msg1: Message = {
			type: "text",
			text: "First answer.",
			is_thinking: false,
		};
		const msg2: Message = {
			type: "text",
			text: "Follow-up answer.",
			is_thinking: false,
		};

		// First turn: mark isDone=true so the poll loop exits immediately (no 3s wait)
		vi.spyOn(testServer as any, "getThoughtSpotService").mockReturnValue({
			sendAgentConversationMessageStreaming: vi
				.fn()
				.mockImplementation(
					async (
						convId: string,
						_msg: string,
						appendFn: typeof realStorage.appendMessages,
					) => {
						await appendFn(convId, [msg1], true /* isDone */);
					},
				),
		});

		await testServer.callSendSessionMessage(
			makeRequest("send_session_message", {
				analytical_session_id: "session-int-3",
				message: "First question",
			}),
		);

		// First poll: sees msg1 + isDone=true, exits immediately; bookmark advances past msg1
		const firstPoll = await testServer.callGetSessionUpdates(
			makeRequest("get_session_updates", {
				analytical_session_id: "session-int-3",
			}),
		);
		expect((firstPoll.structuredContent as any).session_updates).toEqual([
			msg1,
		]);
		expect((firstPoll.structuredContent as any).is_done).toBe(true);

		// Second turn: re-initialize the same session id and send a follow-up
		vi.spyOn(testServer as any, "getThoughtSpotService").mockReturnValue({
			sendAgentConversationMessageStreaming: vi
				.fn()
				.mockImplementation(
					async (
						convId: string,
						_msg: string,
						appendFn: typeof realStorage.appendMessages,
					) => {
						await appendFn(convId, [msg2], true /* isDone */);
					},
				),
		});

		await testServer.callSendSessionMessage(
			makeRequest("send_session_message", {
				analytical_session_id: "session-int-3",
				message: "Follow-up question",
			}),
		);

		// Second poll: must return ONLY msg2 — bookmark was advanced by the first poll
		const secondPoll = await testServer.callGetSessionUpdates(
			makeRequest("get_session_updates", {
				analytical_session_id: "session-int-3",
			}),
		);
		expect((secondPoll.structuredContent as any).session_updates).toEqual([
			msg2,
		]);
		expect((secondPoll.structuredContent as any).is_done).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Group 3 — Streaming parser + real storage
// ---------------------------------------------------------------------------

describe("V2 Streaming Parser + Real Storage Integration", () => {
	const INSTANCE_URL = "https://test.thoughtspot.cloud";

	it("SSE text events are parsed and stored in real DO, then retrievable via getNewMessages", async () => {
		const client = createRealStorageClient();
		await client.initializeConversation("stream-conv-1");

		const reader = makeReader([
			`data: [{"type":"text","content":"Revenue is $5M","metadata":{}}]\n`,
		]);

		await processSendAgentConversationMessageStreamingResponse(
			"stream-conv-1",
			reader,
			client.appendMessages.bind(client),
			INSTANCE_URL,
		);

		const state = await client.getNewMessages("stream-conv-1");
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toEqual({
			type: "text",
			text: "Revenue is $5M",
			is_thinking: false,
		});
		expect(state.isDone).toBe(true);
	});

	it("SSE answer event produces correct answer_id and iframe_url format in real DO", async () => {
		const client = createRealStorageClient();
		await client.initializeConversation("stream-conv-2");

		const answerEvent = {
			type: "answer",
			metadata: {
				session_id: "sess-abc",
				gen_no: 3,
				transaction_id: "txn-xyz",
				generation_number: 2,
				title: "Revenue by Region",
				sage_query: "revenue by region",
				type: null,
			},
		};
		const reader = makeReader([`data: ${JSON.stringify([answerEvent])}\n`]);

		await processSendAgentConversationMessageStreamingResponse(
			"stream-conv-2",
			reader,
			client.appendMessages.bind(client),
			INSTANCE_URL,
		);

		const state = await client.getNewMessages("stream-conv-2");
		expect(state.messages).toHaveLength(1);
		const msg = state.messages[0] as any;
		expect(msg.type).toBe("answer");
		expect(msg.answer_id).toBe(
			JSON.stringify({ session_id: "sess-abc", gen_no: 3 }),
		);
		expect(msg.iframe_url).toContain("sessionId=sess-abc");
		expect(msg.iframe_url).toContain("genNo=3");
		expect(msg.answer_title).toBe("Revenue by Region");
	});

	it("mixed stream (text + answer + thinking) stores all parsed messages and marks done", async () => {
		const client = createRealStorageClient();
		await client.initializeConversation("stream-conv-3");

		const thinkingLine = `data: [{"type":"text","content":"Let me analyze...","metadata":{"type":"thinking"}}]\n`;
		const answerLine = `data: [{"type":"answer","metadata":{"session_id":"s1","gen_no":1,"transaction_id":"t1","generation_number":1,"title":"Chart","sage_query":"select *","type":null}}]\n`;
		const textLine = `data: [{"type":"text","content":"Here is your answer.","metadata":{}}]\n`;

		const reader = makeReader([thinkingLine, answerLine, textLine]);

		await processSendAgentConversationMessageStreamingResponse(
			"stream-conv-3",
			reader,
			client.appendMessages.bind(client),
			INSTANCE_URL,
		);

		const state = await client.getNewMessages("stream-conv-3");
		expect(state.isDone).toBe(true);
		expect(state.messages).toHaveLength(3);
		expect(state.messages[0]).toMatchObject({
			type: "text",
			is_thinking: true,
		});
		expect(state.messages[1]).toMatchObject({ type: "answer" });
		expect(state.messages[2]).toMatchObject({
			type: "text",
			text: "Here is your answer.",
			is_thinking: false,
		});
	});
});
