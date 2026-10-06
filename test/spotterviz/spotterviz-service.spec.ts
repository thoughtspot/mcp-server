import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotterVizGetUpdatesOutputSchema } from "../../src/servers/tool-definitions";
import type { SpotterVizClient } from "../../src/spotterviz/spotterviz-client";
import { SpotterVizService } from "../../src/spotterviz/spotterviz-service";
import * as sseStreamModule from "../../src/spotterviz/spotterviz-sse-stream";
import type {
	AuroraSessionContext,
	SpotterVizEvent,
} from "../../src/spotterviz/types";
import type { StorageServiceClient } from "../../src/storage-service/storage-service";
import type { ThoughtSpotService } from "../../src/thoughtspot/thoughtspot-service";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SPOTTER_VIZ_SESSION_ID = "aurora-sess-1";
const BACH_SESSION = { transactionId: "txn-1", generationNumber: "1" };
const AURORA_INIT = {
	auroraSessionId: SPOTTER_VIZ_SESSION_ID,
	jwtToken: "jwt-1",
	liveboardName: "Saved LB",
};

type TsServiceMock = ThoughtSpotService & {
	createEmptyLiveboard: ReturnType<typeof vi.fn>;
	createBachPinboardSession: ReturnType<typeof vi.fn>;
	saveBachPinboard: ReturnType<typeof vi.fn>;
};

type StorageMock = StorageServiceClient & {
	getMetadata: ReturnType<typeof vi.fn>;
	updateMetadata: ReturnType<typeof vi.fn>;
	appendEvents: ReturnType<typeof vi.fn>;
	getNewEvents: ReturnType<typeof vi.fn>;
};

type ClientMock = SpotterVizClient & {
	instanceUrl: string;
	createAuroraSession: ReturnType<typeof vi.fn>;
	submitAuroraQuery: ReturnType<typeof vi.fn>;
};

function makeTsService(): TsServiceMock {
	return {
		createEmptyLiveboard: vi.fn().mockResolvedValue({ liveboardId: "lb-new" }),
		createBachPinboardSession: vi.fn().mockResolvedValue(BACH_SESSION),
		saveBachPinboard: vi.fn().mockResolvedValue(undefined),
	} as unknown as TsServiceMock;
}

function makeStorage(): StorageMock {
	return {
		getMetadata: vi.fn(),
		updateMetadata: vi.fn().mockResolvedValue({}),
		appendEvents: vi.fn().mockResolvedValue(undefined),
		getNewEvents: vi.fn(),
	} as unknown as StorageMock;
}

function makeClient(): ClientMock {
	return {
		instanceUrl: "https://ts.example.com",
		createAuroraSession: vi.fn().mockResolvedValue(AURORA_INIT),
		submitAuroraQuery: vi.fn(),
	} as unknown as ClientMock;
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe("SpotterVizService.createSession", () => {
	let ts: TsServiceMock;
	let storage: StorageMock;
	let client: ClientMock;
	let svc: SpotterVizService;

	beforeEach(() => {
		ts = makeTsService();
		storage = makeStorage();
		client = makeClient();
		svc = new SpotterVizService(ts, storage, client);
	});

	it("creates a new liveboard when newLiveboardName is provided", async () => {
		const result = await svc.createSession({ newLiveboardName: "My LB" });

		expect(ts.createEmptyLiveboard).toHaveBeenCalledWith("My LB");
		expect(ts.createBachPinboardSession).toHaveBeenCalledWith("lb-new");
		expect(client.createAuroraSession).toHaveBeenCalledWith(BACH_SESSION);
		expect(result.spotterVizSessionId).toBe(SPOTTER_VIZ_SESSION_ID);
		expect(result.liveboardId).toBe("lb-new");
	});

	it("reuses existingLiveboardId without creating a new liveboard", async () => {
		const result = await svc.createSession({
			existingLiveboardId: "lb-existing",
		});

		expect(ts.createEmptyLiveboard).not.toHaveBeenCalled();
		expect(ts.createBachPinboardSession).toHaveBeenCalledWith("lb-existing");
		expect(result.liveboardId).toBe("lb-existing");
	});

	it("throws when neither newLiveboardName nor existingLiveboardId is provided", async () => {
		await expect(svc.createSession({})).rejects.toThrow(
			"Could not resolve a liveboard id",
		);
	});

	it("persists the Aurora session context under the aurora session id", async () => {
		await svc.createSession({ newLiveboardName: "My LB" });

		expect(storage.updateMetadata).toHaveBeenCalledWith(
			SPOTTER_VIZ_SESSION_ID,
			expect.objectContaining({
				auroraSessionId: SPOTTER_VIZ_SESSION_ID,
				auroraJwtToken: "jwt-1",
				transactionId: BACH_SESSION.transactionId,
				generationNumber: BACH_SESSION.generationNumber,
				liveboardId: "lb-new",
				liveboardName: "Saved LB",
			}),
		);
	});

	it("falls back to newLiveboardName when aurora response omits liveboardName", async () => {
		client.createAuroraSession.mockResolvedValueOnce({
			auroraSessionId: SPOTTER_VIZ_SESSION_ID,
			jwtToken: "jwt-1",
		});

		const result = await svc.createSession({ newLiveboardName: "Caller LB" });

		expect(result.liveboardName).toBe("Caller LB");
		const persistedCtx = storage.updateMetadata.mock
			.calls[0][1] as AuroraSessionContext;
		expect(persistedCtx.liveboardName).toBe("Caller LB");
	});

	it("propagates errors from createBachPinboardSession", async () => {
		ts.createBachPinboardSession.mockRejectedValueOnce(new Error("bach down"));

		await expect(svc.createSession({ newLiveboardName: "x" })).rejects.toThrow(
			"bach down",
		);
		expect(client.createAuroraSession).not.toHaveBeenCalled();
	});

	it("propagates errors from the Aurora client", async () => {
		client.createAuroraSession.mockRejectedValueOnce(new Error("aurora 500"));

		await expect(svc.createSession({ newLiveboardName: "x" })).rejects.toThrow(
			"aurora 500",
		);
		expect(storage.updateMetadata).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// submitQuery
// ---------------------------------------------------------------------------

describe("SpotterVizService.submitQuery", () => {
	let ts: TsServiceMock;
	let storage: StorageMock;
	let client: ClientMock;
	let svc: SpotterVizService;

	const baseCtx: AuroraSessionContext = {
		auroraSessionId: SPOTTER_VIZ_SESSION_ID,
		auroraJwtToken: "jwt-1",
		transactionId: "txn-1",
		generationNumber: "1",
		liveboardId: "lb-1",
		pollCount: 3,
	};

	beforeEach(() => {
		ts = makeTsService();
		storage = makeStorage();
		client = makeClient();
		svc = new SpotterVizService(ts, storage, client);
		storage.getMetadata.mockResolvedValue(baseCtx);
		// Make the SSE drain a no-op to keep these tests deterministic.
		vi.spyOn(sseStreamModule, "processAuroraSseStream").mockResolvedValue(
			undefined,
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeMockResponseWithReader(): Response {
		return {
			body: {
				getReader: () =>
					({
						read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
					}) as unknown as ReadableStreamDefaultReader<Uint8Array>,
			},
		} as unknown as Response;
	}

	it("loads the stored context, resets pollCount, and submits the Aurora query", async () => {
		client.submitAuroraQuery.mockResolvedValue(makeMockResponseWithReader());

		const { streamPromise } = await svc.submitQuery({
			spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
			message: "Show me revenue",
		});
		await streamPromise;

		expect(storage.getMetadata).toHaveBeenCalledWith(SPOTTER_VIZ_SESSION_ID);
		expect(storage.updateMetadata).toHaveBeenCalledWith(
			SPOTTER_VIZ_SESSION_ID,
			{ pollCount: 0 },
		);
		expect(client.submitAuroraQuery).toHaveBeenCalledWith(
			baseCtx,
			"Show me revenue",
		);
	});

	it("returns a streamPromise that wraps processAuroraSseStream", async () => {
		client.submitAuroraQuery.mockResolvedValue(makeMockResponseWithReader());

		const { streamPromise } = await svc.submitQuery({
			spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
			message: "x",
		});
		await streamPromise;

		expect(sseStreamModule.processAuroraSseStream).toHaveBeenCalledTimes(1);
		expect(
			(sseStreamModule.processAuroraSseStream as any).mock.calls[0][0],
		).toBe(SPOTTER_VIZ_SESSION_ID);
	});

	it("throws and best-effort marks the session done when the response has no body", async () => {
		client.submitAuroraQuery.mockResolvedValue({ body: null } as Response);

		await expect(
			svc.submitQuery({
				spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
				message: "x",
			}),
		).rejects.toThrow("Aurora /chat/stream returned no response body");

		// Best-effort mark-done: appendEvents called with empty array + true.
		expect(storage.appendEvents).toHaveBeenCalledWith(
			SPOTTER_VIZ_SESSION_ID,
			[],
			true,
		);
	});

	it("throws and best-effort marks the session done when submitAuroraQuery fails", async () => {
		client.submitAuroraQuery.mockRejectedValueOnce(new Error("aurora 500"));

		await expect(
			svc.submitQuery({
				spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
				message: "x",
			}),
		).rejects.toThrow("aurora 500");

		expect(storage.appendEvents).toHaveBeenCalledWith(
			SPOTTER_VIZ_SESSION_ID,
			[],
			true,
		);
	});

	it("swallows secondary errors from the best-effort mark-done", async () => {
		client.submitAuroraQuery.mockRejectedValueOnce(new Error("aurora 500"));
		storage.appendEvents.mockRejectedValueOnce(new Error("mark-done failed"));

		// The original error must still surface; mark-done failure must not mask it.
		await expect(
			svc.submitQuery({
				spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
				message: "x",
			}),
		).rejects.toThrow("aurora 500");
	});
});

// ---------------------------------------------------------------------------
// Output schema null tolerance
// ---------------------------------------------------------------------------

describe("SpotterVizGetUpdatesOutputSchema", () => {
	it("accepts events where optional metadata fields are explicit null", () => {
		// Aurora emits `tool_id: null` (and similar) for events where the field
		// doesn't apply — the schema must accept null, not just undefined, or the
		// host will reject the tool response.
		const sampleResponse = {
			updates: [
				{
					event_type: "meta.progress",
					data: {
						stage: "working",
						message: null,
						card_type: null,
					},
					message_id: "msg-1",
					idx: 1,
					timestamp: "2026-06-09T11:12:19Z",
					tool_id: null,
					group_id: "grp-1",
					heading: "Understanding user's prompt",
				},
			],
			is_done: false,
		};

		const result = SpotterVizGetUpdatesOutputSchema.safeParse(sampleResponse);
		expect(result.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// saveLiveboard
// ---------------------------------------------------------------------------

describe("SpotterVizService.saveLiveboard", () => {
	let ts: TsServiceMock;
	let storage: StorageMock;
	let client: ClientMock;
	let svc: SpotterVizService;

	beforeEach(() => {
		ts = makeTsService();
		storage = makeStorage();
		client = makeClient();
		svc = new SpotterVizService(ts, storage, client);
	});

	it("commits the BACH session and returns a usable liveboard URL", async () => {
		storage.getMetadata.mockResolvedValueOnce({
			auroraSessionId: SPOTTER_VIZ_SESSION_ID,
			auroraJwtToken: "jwt-1",
			transactionId: "txn-9",
			generationNumber: "4",
			liveboardId: "lb-7",
		} as AuroraSessionContext);

		const result = await svc.saveLiveboard({
			spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
		});

		expect(ts.saveBachPinboard).toHaveBeenCalledWith("txn-9", "4");
		expect(result.liveboardId).toBe("lb-7");
		expect(result.liveboardUrl).toBe("https://ts.example.com/#/pinboard/lb-7");
	});

	it("throws when the stored context has no liveboardId", async () => {
		storage.getMetadata.mockResolvedValueOnce({
			auroraSessionId: SPOTTER_VIZ_SESSION_ID,
			auroraJwtToken: "jwt-1",
			transactionId: "txn-9",
			generationNumber: "4",
		} as AuroraSessionContext);

		await expect(
			svc.saveLiveboard({ spotterVizSessionId: SPOTTER_VIZ_SESSION_ID }),
		).rejects.toThrow("missing a liveboardId");
		expect(ts.saveBachPinboard).not.toHaveBeenCalled();
	});

	it("propagates errors from saveBachPinboard", async () => {
		storage.getMetadata.mockResolvedValueOnce({
			auroraSessionId: SPOTTER_VIZ_SESSION_ID,
			auroraJwtToken: "jwt-1",
			transactionId: "t",
			generationNumber: "g",
			liveboardId: "lb-1",
		} as AuroraSessionContext);
		ts.saveBachPinboard.mockRejectedValueOnce(new Error("bach save failed"));

		await expect(
			svc.saveLiveboard({ spotterVizSessionId: SPOTTER_VIZ_SESSION_ID }),
		).rejects.toThrow("bach save failed");
	});
});

// ---------------------------------------------------------------------------
// getUpdates
// ---------------------------------------------------------------------------

describe("SpotterVizService.getUpdates", () => {
	let ts: TsServiceMock;
	let storage: StorageMock;
	let client: ClientMock;
	let svc: SpotterVizService;

	beforeEach(() => {
		vi.useFakeTimers();
		ts = makeTsService();
		storage = makeStorage();
		client = makeClient();
		svc = new SpotterVizService(ts, storage, client);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const ev = (event_type: string): SpotterVizEvent => ({
		event_type,
		data: {},
	});

	it("fast-returns without sleeping when the initial peek shows the turn is done", async () => {
		storage.getNewEvents.mockResolvedValueOnce({
			messages: [ev("text.delta")],
			isDone: true,
		});

		const promise = svc.getUpdates({
			spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
		});
		// No timer advance needed — initial peek is the only call.
		const result = await promise;

		expect(result.isDone).toBe(true);
		expect(result.updates).toHaveLength(1);
		expect(storage.getNewEvents).toHaveBeenCalledTimes(1);
		// pollCount reset on done.
		expect(storage.updateMetadata).toHaveBeenCalledWith(
			SPOTTER_VIZ_SESSION_ID,
			{ pollCount: 0 },
		);
	});

	it("sleeps the first backoff step (2s) when no prior poll has been recorded", async () => {
		storage.getNewEvents.mockResolvedValueOnce({ messages: [], isDone: false });
		storage.getNewEvents.mockResolvedValueOnce({
			messages: [ev("text.delta")],
			isDone: false,
		});
		storage.getMetadata.mockResolvedValueOnce({} as AuroraSessionContext);

		const promise = svc.getUpdates({
			spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
		});

		// Drive past the first backoff step.
		await vi.advanceTimersByTimeAsync(2000);
		const result = await promise;

		expect(result.isDone).toBe(false);
		expect(result.updates).toHaveLength(1);
		// pollCount advanced 0 -> 1.
		expect(storage.updateMetadata).toHaveBeenCalledWith(
			SPOTTER_VIZ_SESSION_ID,
			{ pollCount: 1 },
		);
	});

	it("uses the backoff sequence step indexed by the stored pollCount", async () => {
		storage.getNewEvents.mockResolvedValueOnce({ messages: [], isDone: false });
		storage.getNewEvents.mockResolvedValueOnce({ messages: [], isDone: false });
		// pollCount=2 -> wait sequence index 2 -> 8s.
		storage.getMetadata.mockResolvedValueOnce({
			pollCount: 2,
		} as AuroraSessionContext);

		const promise = svc.getUpdates({
			spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
		});

		// Advance less than 8s — promise should not yet resolve.
		await vi.advanceTimersByTimeAsync(7999);
		// Just past the boundary.
		await vi.advanceTimersByTimeAsync(2);

		await promise;

		expect(storage.updateMetadata).toHaveBeenCalledWith(
			SPOTTER_VIZ_SESSION_ID,
			{ pollCount: 3 },
		);
	});

	it("clamps the wait time to the last backoff step (16s) once pollCount exceeds the sequence", async () => {
		storage.getNewEvents.mockResolvedValueOnce({ messages: [], isDone: false });
		storage.getNewEvents.mockResolvedValueOnce({ messages: [], isDone: false });
		// pollCount=99 -> still uses the last index (16s).
		storage.getMetadata.mockResolvedValueOnce({
			pollCount: 99,
		} as AuroraSessionContext);

		const promise = svc.getUpdates({
			spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
		});
		await vi.advanceTimersByTimeAsync(16_000);
		await promise;

		// pollCount keeps incrementing — important for span attributes / observability.
		expect(storage.updateMetadata).toHaveBeenCalledWith(
			SPOTTER_VIZ_SESSION_ID,
			{ pollCount: 100 },
		);
	});

	it("merges events from both peek and the followup poll", async () => {
		storage.getNewEvents.mockResolvedValueOnce({
			messages: [ev("a")],
			isDone: false,
		});
		storage.getNewEvents.mockResolvedValueOnce({
			messages: [ev("b"), ev("c")],
			isDone: false,
		});
		storage.getMetadata.mockResolvedValueOnce({} as AuroraSessionContext);

		const promise = svc.getUpdates({
			spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
		});
		await vi.advanceTimersByTimeAsync(2000);
		const result = await promise;

		expect(result.updates.map((u) => u.event_type)).toEqual(["a", "b", "c"]);
	});

	it("resets pollCount when the followup poll reports the turn is done", async () => {
		storage.getNewEvents.mockResolvedValueOnce({ messages: [], isDone: false });
		storage.getNewEvents.mockResolvedValueOnce({
			messages: [ev("done")],
			isDone: true,
		});
		storage.getMetadata.mockResolvedValueOnce({
			pollCount: 1,
		} as AuroraSessionContext);

		const promise = svc.getUpdates({
			spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
		});
		await vi.advanceTimersByTimeAsync(4000);
		const result = await promise;

		expect(result.isDone).toBe(true);
		const patches = storage.updateMetadata.mock.calls.map((c) => c[1]);
		// One advance (1 -> 2), then a reset back to 0.
		expect(patches).toEqual(
			expect.arrayContaining([{ pollCount: 2 }, { pollCount: 0 }]),
		);
	});

	it("treats missing pollCount in metadata as 0", async () => {
		storage.getNewEvents.mockResolvedValueOnce({ messages: [], isDone: false });
		storage.getNewEvents.mockResolvedValueOnce({ messages: [], isDone: false });
		storage.getMetadata.mockResolvedValueOnce({
			// pollCount absent
		} as AuroraSessionContext);

		const promise = svc.getUpdates({
			spotterVizSessionId: SPOTTER_VIZ_SESSION_ID,
		});
		await vi.advanceTimersByTimeAsync(2000);
		await promise;

		expect(storage.updateMetadata).toHaveBeenCalledWith(
			SPOTTER_VIZ_SESSION_ID,
			{ pollCount: 1 },
		);
	});

	it("swallows errors from the pollCount reset so already-drained events are not lost", async () => {
		storage.getNewEvents.mockResolvedValueOnce({
			messages: [ev("done")],
			isDone: true,
		});
		storage.updateMetadata.mockRejectedValueOnce(new Error("reset failed"));

		await expect(
			svc.getUpdates({ spotterVizSessionId: SPOTTER_VIZ_SESSION_ID }),
		).resolves.toEqual({
			updates: [{ event_type: "done", data: {} }],
			isDone: true,
		});
	});
});
