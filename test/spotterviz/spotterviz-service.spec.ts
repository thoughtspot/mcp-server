import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpotterVizClient } from "../../src/spotterviz/spotterviz-client";
import { SpotterVizService } from "../../src/spotterviz/spotterviz-service";
import {
	STREAM_HEADERS_TIMEOUT_MS,
	UPSTREAM_CALL_TIMEOUT_MS,
} from "../../src/spotterviz/timeouts";
import type { AuroraSessionContext } from "../../src/spotterviz/types";
import type { StorageServiceClient } from "../../src/storage-service/storage-service";
import type { ThoughtSpotService } from "../../src/thoughtspot/thoughtspot-service";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TASK_ID = "task-1";
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
		const result = await svc.createSession({
			taskId: TASK_ID,
			newLiveboardName: "My LB",
		});

		expect(ts.createEmptyLiveboard).toHaveBeenCalledWith("My LB");
		expect(ts.createBachPinboardSession).toHaveBeenCalledWith("lb-new");
		expect(client.createAuroraSession).toHaveBeenCalledWith(BACH_SESSION);
		expect(result.spotterVizSessionId).toBe(TASK_ID);
		expect(result.liveboardId).toBe("lb-new");
	});

	it("reuses existingLiveboardId without creating a new liveboard", async () => {
		const result = await svc.createSession({
			taskId: TASK_ID,
			existingLiveboardId: "lb-existing",
		});

		expect(ts.createEmptyLiveboard).not.toHaveBeenCalled();
		expect(ts.createBachPinboardSession).toHaveBeenCalledWith("lb-existing");
		expect(result.liveboardId).toBe("lb-existing");
	});

	it("throws when neither newLiveboardName nor existingLiveboardId is provided", async () => {
		await expect(svc.createSession({ taskId: TASK_ID })).rejects.toThrow(
			"Could not resolve a liveboard id",
		);
	});

	it("persists the Aurora session context under the task id", async () => {
		await svc.createSession({ taskId: TASK_ID, newLiveboardName: "My LB" });

		expect(storage.updateMetadata).toHaveBeenCalledWith(
			TASK_ID,
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

		const result = await svc.createSession({
			taskId: TASK_ID,
			newLiveboardName: "Caller LB",
		});

		expect(result.liveboardName).toBe("Caller LB");
		const persistedCtx = storage.updateMetadata.mock.calls.at(
			-1,
		)?.[1] as AuroraSessionContext;
		expect(persistedCtx.liveboardName).toBe("Caller LB");
	});

	it("propagates errors from createBachPinboardSession", async () => {
		ts.createBachPinboardSession.mockRejectedValueOnce(new Error("bach down"));

		await expect(
			svc.createSession({ taskId: TASK_ID, newLiveboardName: "x" }),
		).rejects.toThrow("bach down");
		expect(client.createAuroraSession).not.toHaveBeenCalled();
	});

	it("propagates errors from the Aurora client", async () => {
		client.createAuroraSession.mockRejectedValueOnce(new Error("aurora 500"));

		await expect(
			svc.createSession({ taskId: TASK_ID, newLiveboardName: "x" }),
		).rejects.toThrow("aurora 500");
		// Only the early liveboardId record was written, not the session context.
		expect(storage.updateMetadata).toHaveBeenCalledTimes(1);
		expect(storage.updateMetadata).toHaveBeenCalledWith(TASK_ID, {
			liveboardId: "lb-new",
		});
	});

	it("times out a hung BACH session call", async () => {
		vi.useFakeTimers();
		ts.createBachPinboardSession.mockReturnValueOnce(new Promise(() => {}));

		const pending = svc.createSession({
			taskId: TASK_ID,
			newLiveboardName: "x",
		});
		const assertion = expect(pending).rejects.toThrow("did not respond");
		await vi.advanceTimersByTimeAsync(UPSTREAM_CALL_TIMEOUT_MS);
		await assertion;
		vi.useRealTimers();
	});
});

// ---------------------------------------------------------------------------
// submitQuery
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
			spotterVizSessionId: TASK_ID,
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
			svc.saveLiveboard({ spotterVizSessionId: TASK_ID }),
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
			svc.saveLiveboard({ spotterVizSessionId: TASK_ID }),
		).rejects.toThrow("bach save failed");
	});

	it("commits the generation passed by the caller over the stored one", async () => {
		storage.getMetadata.mockResolvedValueOnce({
			auroraSessionId: SPOTTER_VIZ_SESSION_ID,
			auroraJwtToken: "jwt-1",
			transactionId: "txn-9",
			generationNumber: "4",
			liveboardId: "lb-7",
		} as AuroraSessionContext);

		await svc.saveLiveboard({
			spotterVizSessionId: TASK_ID,
			generationNumber: "9",
		});

		expect(ts.saveBachPinboard).toHaveBeenCalledWith("txn-9", "9");
	});

	it("times out a hung save", async () => {
		vi.useFakeTimers();
		storage.getMetadata.mockResolvedValueOnce({
			auroraSessionId: SPOTTER_VIZ_SESSION_ID,
			auroraJwtToken: "jwt-1",
			transactionId: "t",
			generationNumber: "g",
			liveboardId: "lb-1",
		} as AuroraSessionContext);
		ts.saveBachPinboard.mockReturnValueOnce(new Promise(() => {}));

		const pending = svc.saveLiveboard({ spotterVizSessionId: TASK_ID });
		const assertion = expect(pending).rejects.toThrow("Saving the dashboard");
		await vi.advanceTimersByTimeAsync(UPSTREAM_CALL_TIMEOUT_MS);
		await assertion;
		vi.useRealTimers();
	});
});

// ---------------------------------------------------------------------------
// openStream
// ---------------------------------------------------------------------------

describe("SpotterVizService.openStream", () => {
	const CONTEXT = {
		auroraSessionId: SPOTTER_VIZ_SESSION_ID,
		auroraJwtToken: "jwt-1",
		transactionId: "txn-1",
		generationNumber: "1",
	} as AuroraSessionContext;

	let ts: TsServiceMock;
	let storage: StorageMock;
	let client: ClientMock;
	let svc: SpotterVizService;

	beforeEach(() => {
		ts = makeTsService();
		storage = makeStorage();
		client = makeClient();
		svc = new SpotterVizService(ts, storage, client);
		storage.getMetadata.mockResolvedValue(CONTEXT);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("submits the message with the stored context and returns the body reader", async () => {
		const body = new ReadableStream<Uint8Array>();
		client.submitAuroraQuery.mockResolvedValueOnce(new Response(body));

		const reader = await svc.openStream({
			taskId: TASK_ID,
			message: "hello",
			signal: new AbortController().signal,
		});

		expect(storage.getMetadata).toHaveBeenCalledWith(TASK_ID);
		expect(client.submitAuroraQuery).toHaveBeenCalledWith(
			CONTEXT,
			"hello",
			expect.any(AbortSignal),
		);
		expect(typeof reader.read).toBe("function");
		await reader.cancel();
	});

	it("throws when the task has no SpotterViz session", async () => {
		storage.getMetadata.mockResolvedValueOnce({});

		await expect(
			svc.openStream({
				taskId: TASK_ID,
				message: "hello",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("no SpotterViz session");
		expect(client.submitAuroraQuery).not.toHaveBeenCalled();
	});

	it("throws when the response has no body", async () => {
		client.submitAuroraQuery.mockResolvedValueOnce(new Response(null));

		await expect(
			svc.openStream({
				taskId: TASK_ID,
				message: "hello",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("no response body");
	});

	it("aborts with a TimeoutError when Aurora does not send headers in time", async () => {
		vi.useFakeTimers();
		client.submitAuroraQuery.mockImplementationOnce(
			(_ctx: unknown, _msg: string, signal: AbortSignal) =>
				new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);

		const pending = svc.openStream({
			taskId: TASK_ID,
			message: "hello",
			signal: new AbortController().signal,
		});
		const assertion = expect(pending).rejects.toMatchObject({
			name: "TimeoutError",
		});
		await vi.advanceTimersByTimeAsync(STREAM_HEADERS_TIMEOUT_MS);
		await assertion;
	});

	it("propagates the caller's abort to the request", async () => {
		let requestSignal: AbortSignal | undefined;
		client.submitAuroraQuery.mockImplementationOnce(
			(_ctx: unknown, _msg: string, signal: AbortSignal) => {
				requestSignal = signal;
				return new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				});
			},
		);
		const caller = new AbortController();

		const pending = svc.openStream({
			taskId: TASK_ID,
			message: "hello",
			signal: caller.signal,
		});
		await vi.waitFor(() => expect(requestSignal).toBeDefined());
		caller.abort(new Error("caller gave up"));

		await expect(pending).rejects.toThrow("caller gave up");
		expect(requestSignal?.aborted).toBe(true);
	});
});
