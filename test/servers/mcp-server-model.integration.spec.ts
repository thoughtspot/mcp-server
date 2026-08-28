/**
 * Spotter Model (V3) tool integration tests.
 *
 * Exercises the four model tools — create_model_session / send_model_message / get_model_updates /
 * finalize_model — against a REAL ConversationStorageServerSQLite behind a real
 * StorageServiceClient, with only the upstream ThoughtSpot/Lumos calls mocked. That covers the
 * pieces unit tests can't: per-turn conversation initialization, the background stream consumer
 * writing through to storage, and the long-poll draining it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOOP_METRICS_RECORDER } from "../../src/metrics/runtime/metrics-recorder";
import { ConversationStorageServerSQLite } from "../../src/servers/conversation-storage-server";
import { MCPServer } from "../../src/servers/mcp-server";
import { StorageServiceClient } from "../../src/storage-service/storage-service";
import type { ModelSessionState } from "../../src/thoughtspot/spotter-model/spotter-model-types";
import * as thoughtspotClient from "../../src/thoughtspot/thoughtspot-client";
import { makeRequest } from "./helpers";

// ---------------------------------------------------------------------------
// Infrastructure helpers
// ---------------------------------------------------------------------------

/** In-memory DurableObjectState mirroring the real Cloudflare API surface. */
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

/** A real StorageServiceClient talking to a real DO over an in-memory stub. */
function createRealStorageClient(): StorageServiceClient {
	const { storage } = createMockDoState();
	const server = new ConversationStorageServerSQLite(
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

	return new StorageServiceClient(namespace, "token-hash");
}

const mockProps = {
	instanceUrl: "https://test.thoughtspot.cloud",
	accessToken: "test-access-token",
	clientName: {
		clientId: "test-client-id",
		clientName: "test-client",
		registrationDate: 0,
	},
};

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
	// The model tools are gated on data-modeling privileges in dispatchTool; these tests call the
	// handlers directly, but the session info still reflects a user who is allowed to use them.
	privileges: ["DATAMANAGEMENT"],
};

const CONNECTION_GUID = "e7be3b37-88ce-4459-a196-7bbb2b9e53cf";

function event(type: string, data: unknown): string {
	return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An SSE Response over the given chunks. `close: false` leaves the turn in flight. */
function sseResponse(chunks: string[], { close = true } = {}): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			if (close) controller.close();
		},
	});
	return new Response(body);
}

/** A completed build turn: progress, a generation bump, and a final message. */
const buildTurnChunks = [
	event("META_TODO", {
		meta_todo: { tasks: [{ id: "1", title: "Tables", status: "COMPLETED" }] },
	}),
	event("META_MODEL_STATE", { meta_model_state: { generation_no: "2" } }),
	event("NOTIFICATION", { notification: { title: "Adding joins to model" } }),
	event("MESSAGE_DELTA", {
		message_delta: { content: "Built the sales model." },
	}),
	event("MESSAGE_END", { message_end: { status: "completed" } }),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Spotter Model tools + real storage integration", () => {
	let server: MCPServer;
	let storage: StorageServiceClient;
	let upstream: Record<string, ReturnType<typeof vi.fn>>;

	beforeEach(async () => {
		vi.clearAllMocks();

		vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue({
			getSessionInfo: vi.fn().mockResolvedValue(mockSessionInfoResponse),
			instanceUrl: "https://test.thoughtspot.cloud",
		} as any);

		server = new MCPServer({ props: mockProps } as any);
		storage = createRealStorageClient();
		vi.spyOn(server as any, "getStorageService").mockReturnValue(storage);

		await server.init();

		upstream = {
			createModelSession: vi.fn().mockResolvedValue({
				conversation_id: "conv-1",
				transaction_id: "txn-1",
				generation_no: "1",
			}),
			mintSessionCookie: vi.fn().mockResolvedValue("JSESSIONID=abc"),
			sendModelMessageStreaming: vi
				.fn()
				.mockResolvedValue(sseResponse(buildTurnChunks)),
			saveModel: vi.fn().mockResolvedValue({
				model_identifier: "model-guid",
				url: "https://test.thoughtspot.cloud/#/data/tables/model-guid",
			}),
			fetchWorksheetModel: vi.fn().mockResolvedValue({
				data: {
					Worksheet__operation: {
						worksheetModel: {
							schemaGraphProto: {
								schemaTables: [{ userDefinedName: "ORDERS" }],
							},
							schemaJoins: [],
							columnGroup: [{ worksheetColumn: [{}, {}] }],
						},
					},
				},
			}),
		};
		vi.spyOn(server as any, "getThoughtSpotService").mockReturnValue(upstream);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Start a session and return its id.
	async function createSession(
		args: Record<string, unknown> = { connection_identifier: CONNECTION_GUID },
	): Promise<string> {
		const result = await server.callCreateModelSession(
			makeRequest("create_model_session", args),
			NOOP_METRICS_RECORDER,
		);
		expect(result.isError).toBeUndefined();
		return (result.structuredContent as any).model_session_id;
	}

	// -------------------------------------------------------------------------
	// create_model_session
	// -------------------------------------------------------------------------

	describe("create_model_session", () => {
		it("creates a session on a connection and persists its state", async () => {
			const sessionId = await createSession();

			expect(sessionId).toBe("conv-1");
			expect(upstream.createModelSession).toHaveBeenCalledWith(
				CONNECTION_GUID,
				undefined,
			);

			const state = await storage.getSessionState<ModelSessionState>(sessionId);
			expect(state).toMatchObject({
				transactionId: "txn-1",
				// Upstream sends generations as strings; stored as a number.
				generationNo: 1,
				genNoWorkingSet: [],
				sessionCookie: "JSESSIONID=abc",
			});
		});

		it("opens an existing model for editing", async () => {
			await createSession({ model_identifier: "model-guid" });

			expect(upstream.createModelSession).toHaveBeenCalledWith(
				undefined,
				"model-guid",
			);
		});

		it("rejects a call with neither a connection nor a model", async () => {
			const result = await server.callCreateModelSession(
				makeRequest("create_model_session", {}),
				NOOP_METRICS_RECORDER,
			);

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toContain(
				"MUST ask the user which",
			);
			expect(upstream.createModelSession).not.toHaveBeenCalled();
		});

		it("still creates the session when the session cookie cannot be minted", async () => {
			upstream.mintSessionCookie.mockRejectedValue(new Error("login refused"));

			const sessionId = await createSession();

			const state = await storage.getSessionState<ModelSessionState>(sessionId);
			expect(state?.sessionCookie).toBeUndefined();
		});

		it("reports a connection failure for a new model", async () => {
			upstream.createModelSession.mockRejectedValue(
				new Error("bad connection"),
			);

			const result = await server.callCreateModelSession(
				makeRequest("create_model_session", {
					connection_identifier: CONNECTION_GUID,
				}),
				NOOP_METRICS_RECORDER,
			);

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toContain(
				"Could not start a model session",
			);
		});

		it("reports an open failure when editing an existing model", async () => {
			upstream.createModelSession.mockRejectedValue(new Error("no such model"));

			const result = await server.callCreateModelSession(
				makeRequest("create_model_session", { model_identifier: "nope" }),
				NOOP_METRICS_RECORDER,
			);

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toContain(
				"Could not open that model for editing",
			);
		});
	});

	// -------------------------------------------------------------------------
	// send_model_message → get_model_updates
	// -------------------------------------------------------------------------

	describe("send_model_message and get_model_updates", () => {
		it("streams a build turn into storage and drains it on the next call", async () => {
			const sessionId = await createSession();

			const sendResult = await server.callSendModelMessage(
				makeRequest("send_model_message", {
					model_session_id: sessionId,
					message: "create a model for sales",
				}),
				NOOP_METRICS_RECORDER,
			);
			expect(sendResult.isError).toBeUndefined();
			expect((sendResult.structuredContent as any).success).toBe(true);

			const updatesResult = await server.callGetModelUpdates(
				makeRequest("get_model_updates", { model_session_id: sessionId }),
			);
			expect(updatesResult.isError).toBeUndefined();
			const content = updatesResult.structuredContent as any;
			expect(content.is_done).toBe(true);
			expect(content.updates.map((u: any) => u.type)).toEqual([
				"todo",
				"model_state",
				"notification",
				"text",
				"message_end",
			]);
			expect(content.updates.find((u: any) => u.type === "text").text).toBe(
				"Built the sales model.",
			);

			// The generation the stream reported was folded into the saved session state.
			const state = await storage.getSessionState<ModelSessionState>(sessionId);
			expect(state).toMatchObject({ generationNo: 2, genNoWorkingSet: [2] });
		});

		it("forwards the session's generation working set upstream", async () => {
			const sessionId = await createSession();

			await server.callSendModelMessage(
				makeRequest("send_model_message", {
					model_session_id: sessionId,
					message: "first",
				}),
				NOOP_METRICS_RECORDER,
			);
			await server.callGetModelUpdates(
				makeRequest("get_model_updates", { model_session_id: sessionId }),
			);

			// Second turn must pin the generations accumulated by the first.
			upstream.sendModelMessageStreaming.mockResolvedValue(
				sseResponse([event("MESSAGE_END", { message_end: {} })]),
			);
			await server.callSendModelMessage(
				makeRequest("send_model_message", {
					model_session_id: sessionId,
					message: "second",
				}),
				NOOP_METRICS_RECORDER,
			);

			expect(upstream.sendModelMessageStreaming).toHaveBeenLastCalledWith(
				expect.objectContaining({
					conversation_identifier: sessionId,
					transaction_id: "txn-1",
					generation_no: 2,
					gen_no_working_set: [2],
					session_cookie: "JSESSIONID=abc",
					message: "second",
				}),
			);
		});

		it("answers a pending clarification with the user's selection", async () => {
			const sessionId = await createSession();
			// A turn that ends by asking which fact table to use.
			upstream.sendModelMessageStreaming.mockResolvedValue(
				sseResponse([
					event("META_CHOICE", {
						meta_choice: {
							choice: {
								title: "Which fact table?",
								choice_options: [
									{ table_option: { id: "1", is_selected: false } },
									{ table_option: { id: "2", is_selected: false } },
								],
							},
						},
					}),
					event("MESSAGE_END", { message_end: { status: "completed" } }),
				]),
			);

			await server.callSendModelMessage(
				makeRequest("send_model_message", {
					model_session_id: sessionId,
					message: "build it",
				}),
				NOOP_METRICS_RECORDER,
			);
			const updates = await server.callGetModelUpdates(
				makeRequest("get_model_updates", { model_session_id: sessionId }),
			);
			expect(
				(updates.structuredContent as any).updates.some(
					(u: any) => u.type === "choice",
				),
			).toBe(true);

			upstream.sendModelMessageStreaming.mockResolvedValue(
				sseResponse([event("MESSAGE_END", { message_end: {} })]),
			);
			await server.callSendModelMessage(
				makeRequest("send_model_message", {
					model_session_id: sessionId,
					selected_option_ids: ["2"],
				}),
				NOOP_METRICS_RECORDER,
			);

			// The whole choice envelope is echoed back with the selection applied.
			const sent = upstream.sendModelMessageStreaming.mock.calls.at(-1)[0];
			expect(sent.choice.choice_options).toEqual([
				{ table_option: { id: "1", is_selected: false } },
				{ table_option: { id: "2", is_selected: true } },
			]);
			expect(sent.message).toBe("");

			// Answering consumes the clarification.
			const state = await storage.getSessionState<ModelSessionState>(sessionId);
			expect(state?.pendingChoice).toBeNull();
		});

		it("rejects a call with neither a message nor a selection", async () => {
			const sessionId = await createSession();

			const result = await server.callSendModelMessage(
				makeRequest("send_model_message", { model_session_id: sessionId }),
				NOOP_METRICS_RECORDER,
			);

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toContain("Nothing to send");
			expect(upstream.sendModelMessageStreaming).not.toHaveBeenCalled();
		});

		it("rejects an unknown model_session_id", async () => {
			const result = await server.callSendModelMessage(
				makeRequest("send_model_message", {
					model_session_id: "does-not-exist",
					message: "hello",
				}),
				NOOP_METRICS_RECORDER,
			);

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toContain(
				"Unknown model_session_id",
			);
		});

		it("rejects a second instruction while the first is still streaming", async () => {
			const sessionId = await createSession();
			// A stream that never closes keeps the turn in flight.
			upstream.sendModelMessageStreaming.mockResolvedValue(
				sseResponse(
					[event("NOTIFICATION", { notification: { title: "Working" } })],
					{ close: false },
				),
			);

			const first = await server.callSendModelMessage(
				makeRequest("send_model_message", {
					model_session_id: sessionId,
					message: "build it",
				}),
				NOOP_METRICS_RECORDER,
			);
			expect(first.isError).toBeUndefined();

			const second = await server.callSendModelMessage(
				makeRequest("send_model_message", {
					model_session_id: sessionId,
					message: "too early",
				}),
				NOOP_METRICS_RECORDER,
			);

			expect(second.isError).toBe(true);
			expect((second.content as any[])[0].text).toContain(
				"still working on the previous instruction",
			);
		});

		it("marks the turn done when the upstream stream cannot be opened", async () => {
			const sessionId = await createSession();
			upstream.sendModelMessageStreaming.mockRejectedValue(
				new Error("stream refused"),
			);

			const sendResult = await server.callSendModelMessage(
				makeRequest("send_model_message", {
					model_session_id: sessionId,
					message: "build it",
				}),
				NOOP_METRICS_RECORDER,
			);
			expect(sendResult.isError).toBe(true);
			expect((sendResult.content as any[])[0].text).toContain(
				"error while updating the model",
			);

			// Crucially the poller must not hang waiting for a turn that never started.
			const updatesResult = await server.callGetModelUpdates(
				makeRequest("get_model_updates", { model_session_id: sessionId }),
			);
			expect((updatesResult.structuredContent as any).is_done).toBe(true);
		});

		it("surfaces a mid-stream upstream error as an update", async () => {
			const sessionId = await createSession();
			upstream.sendModelMessageStreaming.mockResolvedValue(
				sseResponse([
					event("META_ERROR", {
						meta_error: { error_response: { message: "formula failed" } },
					}),
					event("MESSAGE_END", { message_end: { status: "completed" } }),
				]),
			);

			await server.callSendModelMessage(
				makeRequest("send_model_message", {
					model_session_id: sessionId,
					message: "add a formula",
				}),
				NOOP_METRICS_RECORDER,
			);
			const updatesResult = await server.callGetModelUpdates(
				makeRequest("get_model_updates", { model_session_id: sessionId }),
			);

			const content = updatesResult.structuredContent as any;
			expect(content.updates[0]).toEqual({
				type: "text",
				text: "Error: formula failed",
			});
		});

		it("returns a distinct error when polled before anything was sent", async () => {
			const sessionId = await createSession();

			const result = await server.callGetModelUpdates(
				makeRequest("get_model_updates", { model_session_id: sessionId }),
			);

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toContain(
				"no updates for this model session yet",
			);
		});

		it("only returns updates not already delivered", async () => {
			const sessionId = await createSession();
			await server.callSendModelMessage(
				makeRequest("send_model_message", {
					model_session_id: sessionId,
					message: "build it",
				}),
				NOOP_METRICS_RECORDER,
			);

			const first = await server.callGetModelUpdates(
				makeRequest("get_model_updates", { model_session_id: sessionId }),
			);
			expect((first.structuredContent as any).updates.length).toBeGreaterThan(
				0,
			);

			// The turn is done and its updates were consumed, so a repeat poll is empty.
			const second = await server.callGetModelUpdates(
				makeRequest("get_model_updates", { model_session_id: sessionId }),
			);
			expect((second.structuredContent as any).updates).toEqual([]);
			expect((second.structuredContent as any).is_done).toBe(true);
		});

		it("returns partial updates with is_done=false when the turn outruns the window", async () => {
			const sessionId = await createSession();
			// Standing in for a build longer than the ~60s poll window.
			vi.spyOn(server as any, "pollModelUpdates").mockResolvedValue({
				updates: [{ type: "notification", text: "Adding joins" }],
				isDone: false,
			});

			const result = await server.callGetModelUpdates(
				makeRequest("get_model_updates", { model_session_id: sessionId }),
			);

			// is_done is the only signal the client gets that another poll is needed — the status
			// message goes to the trace span, not the response.
			expect(result.isError).toBeUndefined();
			expect(result.structuredContent).toEqual({
				updates: [{ type: "notification", text: "Adding joins" }],
				is_done: false,
			});
		});
	});

	// -------------------------------------------------------------------------
	// finalize_model
	// -------------------------------------------------------------------------

	describe("finalize_model", () => {
		it("returns a structured summary for review without saving", async () => {
			const sessionId = await createSession();

			const result = await server.callFinalizeModel(
				makeRequest("finalize_model", { model_session_id: sessionId }),
				NOOP_METRICS_RECORDER,
			);

			const content = result.structuredContent as any;
			expect(content.saved).toBe(false);
			expect(content.summary).toBe(
				"The model is ready to save. It contains 1 tables (ORDERS), 0 joins, 2 columns.",
			);
			expect(upstream.saveModel).not.toHaveBeenCalled();
		});

		it("falls back to a generic summary when the model cannot be fetched", async () => {
			const sessionId = await createSession();
			upstream.fetchWorksheetModel.mockRejectedValue(new Error("bach down"));

			const result = await server.callFinalizeModel(
				makeRequest("finalize_model", { model_session_id: sessionId }),
				NOOP_METRICS_RECORDER,
			);

			expect((result.structuredContent as any).summary).toBe(
				"The model is ready to review before saving.",
			);
			expect((result.structuredContent as any).saved).toBe(false);
		});

		it("saves and returns the model link when confirmed", async () => {
			const sessionId = await createSession();

			const result = await server.callFinalizeModel(
				makeRequest("finalize_model", {
					model_session_id: sessionId,
					name: "Sales",
					description: "Sales model",
					confirm: true,
				}),
				NOOP_METRICS_RECORDER,
			);

			expect(result.structuredContent).toEqual({
				saved: true,
				model_identifier: "model-guid",
				url: "https://test.thoughtspot.cloud/#/data/tables/model-guid",
			});
			expect(upstream.saveModel).toHaveBeenCalledWith(
				expect.objectContaining({
					transaction_id: "txn-1",
					name: "Sales",
					description: "Sales model",
				}),
			);
		});

		it("reports a save failure", async () => {
			const sessionId = await createSession();
			upstream.saveModel.mockRejectedValue(new Error("code 13130"));

			const result = await server.callFinalizeModel(
				makeRequest("finalize_model", {
					model_session_id: sessionId,
					name: "Sales",
					confirm: true,
				}),
				NOOP_METRICS_RECORDER,
			);

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toContain(
				"error while saving the model",
			);
		});

		it("rejects an unknown model_session_id", async () => {
			const result = await server.callFinalizeModel(
				makeRequest("finalize_model", { model_session_id: "nope" }),
				NOOP_METRICS_RECORDER,
			);

			expect(result.isError).toBe(true);
			expect((result.content as any[])[0].text).toContain(
				"Unknown model_session_id",
			);
		});
	});
});
