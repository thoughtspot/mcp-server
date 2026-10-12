import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DashboardTurnBusyError,
	pollDashboardTurn,
	startDashboardJob,
} from "../../src/spotterviz/dashboard-orchestrator";
import type { SpotterVizService } from "../../src/spotterviz/spotterviz-service";
import { STALE_TASK_MS } from "../../src/spotterviz/timeouts";
import type { StorageServiceClient } from "../../src/storage-service/storage-service";

const TASK_ID = "task-1";

type ServiceMock = SpotterVizService & {
	openStream: ReturnType<typeof vi.fn>;
	saveLiveboard: ReturnType<typeof vi.fn>;
};

type StorageMock = StorageServiceClient & {
	initializeConversation: ReturnType<typeof vi.fn>;
	getMetadata: ReturnType<typeof vi.fn>;
	updateMetadata: ReturnType<typeof vi.fn>;
	appendMessages: ReturnType<typeof vi.fn>;
	metadata: Record<string, unknown>;
};

function frame(eventType: string, data: Record<string, unknown>): string {
	return `event: ${eventType}\ndata: ${JSON.stringify({ data })}\n\n`;
}

const COMPLETED_FRAMES = [
	frame("control.action", {
		action: "lb_refresh",
		metadata: { new_gen_number: 5 },
	}),
	frame("message.end", { status: "completed", liveboard_updated: true }),
];

/**
 * A reader over `chunks`. When `hold` is given, the reader waits on it before yielding anything,
 * so a test can keep the job running past the deadline. With `close: false` it never ends after
 * the chunks (an Aurora socket that goes silent).
 */
function makeReader(
	chunks: string[],
	opts: { hold?: Promise<void>; close?: boolean } = {},
): ReadableStreamDefaultReader<Uint8Array> {
	const encoder = new TextEncoder();
	const queue = [...chunks];
	return {
		read: vi.fn(async () => {
			await opts.hold;
			if (queue.length === 0) {
				if (opts.close === false) {
					return new Promise(() => {});
				}
				return { done: true, value: undefined };
			}
			return { done: false, value: encoder.encode(queue.shift() as string) };
		}),
		cancel: vi.fn().mockResolvedValue(undefined),
	} as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

function makeService(
	reader: ReadableStreamDefaultReader<Uint8Array> = makeReader(
		COMPLETED_FRAMES,
	),
): ServiceMock {
	return {
		openStream: vi.fn().mockResolvedValue(reader),
		saveLiveboard: vi.fn().mockResolvedValue({
			liveboardId: "lb-1",
			liveboardUrl: "https://ts.example.com/#/pinboard/lb-1",
		}),
	} as unknown as ServiceMock;
}

/** In-memory storage: metadata is merged on update, like the Durable Object does. */
function makeStorage(initial: Record<string, unknown> = {}): StorageMock {
	const storage = {
		metadata: { liveboardId: "lb-1", generationNumber: "1", ...initial },
	} as StorageMock;
	storage.initializeConversation = vi.fn().mockResolvedValue(undefined);
	storage.getMetadata = vi.fn(async () => ({ ...storage.metadata }));
	storage.updateMetadata = vi.fn(async (_id, values) => {
		Object.assign(storage.metadata, values);
		return { ...storage.metadata };
	});
	storage.appendMessages = vi.fn().mockResolvedValue(undefined);
	return storage;
}

function releasedLock(storage: StorageMock): boolean {
	return storage.appendMessages.mock.calls.some(
		([id, events, done]) =>
			id === TASK_ID && Array.isArray(events) && events.length === 0 && done,
	);
}

describe("startDashboardJob", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns the completed outcome, saving once with the streamed generation", async () => {
		const service = makeService();
		const storage = makeStorage();
		const setup = vi.fn().mockResolvedValue(undefined);

		const outcome = await startDashboardJob({
			service,
			storage,
			taskId: TASK_ID,
			setup,
			buildMessage: () => "do the thing",
			deadlineMs: 1_000,
		});

		expect(setup).toHaveBeenCalledTimes(1);
		expect(service.openStream).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: TASK_ID, message: "do the thing" }),
		);
		expect(outcome).toMatchObject({
			status: "completed",
			taskId: TASK_ID,
			dashboardId: "lb-1",
			dashboardUrl: "https://ts.example.com/#/pinboard/lb-1",
		});
		expect(service.saveLiveboard).toHaveBeenCalledTimes(1);
		expect(service.saveLiveboard).toHaveBeenCalledWith({
			spotterVizSessionId: TASK_ID,
			generationNumber: "5",
		});
		expect(storage.metadata.generationNumber).toBe("5");
		expect(storage.metadata.turnOutcome).toMatchObject({ status: "completed" });
		expect(releasedLock(storage)).toBe(true);
	});

	it("saves the generation from the stream even if stored metadata changes mid-turn", async () => {
		const storage = makeStorage();
		const service = makeService();
		// A concurrent writer bumps the stored generation; the job must not pick it up.
		storage.getMetadata.mockImplementation(async () => ({
			...storage.metadata,
			generationNumber: "99",
		}));

		await startDashboardJob({
			service,
			storage,
			taskId: TASK_ID,
			setup: async () => {},
			buildMessage: () => "m",
			deadlineMs: 1_000,
		});

		expect(service.saveLiveboard).toHaveBeenCalledWith({
			spotterVizSessionId: TASK_ID,
			generationNumber: "5",
		});
	});

	it("returns in_progress at the deadline while the job keeps running and later stores the outcome", async () => {
		let release: () => void = () => {};
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const service = makeService(makeReader(COMPLETED_FRAMES, { hold }));
		const storage = makeStorage();
		const waitUntil = vi.fn();

		const pending = startDashboardJob({
			service,
			storage,
			taskId: TASK_ID,
			setup: async () => {},
			buildMessage: () => "m",
			waitUntil,
			deadlineMs: 1_000,
		});
		await vi.advanceTimersByTimeAsync(1_000);

		await expect(pending).resolves.toEqual({
			status: "in_progress",
			taskId: TASK_ID,
		});
		expect(waitUntil).toHaveBeenCalledTimes(1);
		expect(service.saveLiveboard).not.toHaveBeenCalled();
		expect(releasedLock(storage)).toBe(false);

		release();
		await waitUntil.mock.calls[0][0];

		expect(service.saveLiveboard).toHaveBeenCalledTimes(1);
		expect(storage.metadata.turnOutcome).toMatchObject({ status: "completed" });
		expect(releasedLock(storage)).toBe(true);
	});

	it("fails without saving when the stream goes idle", async () => {
		const service = makeService(
			makeReader([frame("text.delta", { text: "working" })], { close: false }),
		);
		const storage = makeStorage();

		const pending = startDashboardJob({
			service,
			storage,
			taskId: TASK_ID,
			setup: async () => {},
			buildMessage: () => "m",
			deadlineMs: 10_000,
			idleMs: 500,
		});
		await vi.advanceTimersByTimeAsync(500);

		const outcome = await pending;
		expect(outcome).toMatchObject({
			status: "failed",
			liveboardUpdated: false,
			dashboardId: "lb-1",
		});
		expect(outcome.status === "failed" && outcome.error).toMatch(
			/stopped sending updates/,
		);
		expect(service.saveLiveboard).not.toHaveBeenCalled();
		expect(releasedLock(storage)).toBe(true);
	});

	it("returns a failed outcome (not a throw) when setup throws", async () => {
		const service = makeService();
		const storage = makeStorage();

		const outcome = await startDashboardJob({
			service,
			storage,
			taskId: TASK_ID,
			setup: vi.fn().mockRejectedValue(new Error("no such answer")),
			buildMessage: () => "m",
			deadlineMs: 1_000,
		});

		expect(outcome).toMatchObject({ status: "failed", taskId: TASK_ID });
		expect(outcome.status === "failed" && outcome.error).toContain(
			"no such answer",
		);
		expect(service.openStream).not.toHaveBeenCalled();
		expect(service.saveLiveboard).not.toHaveBeenCalled();
		expect(releasedLock(storage)).toBe(true);
	});

	it("reports failure and releases the lock when the save fails", async () => {
		const service = makeService();
		service.saveLiveboard.mockRejectedValueOnce(new Error("commit refused"));
		const storage = makeStorage();

		const outcome = await startDashboardJob({
			service,
			storage,
			taskId: TASK_ID,
			setup: async () => {},
			buildMessage: () => "m",
			deadlineMs: 1_000,
		});

		expect(outcome).toMatchObject({ status: "failed", dashboardId: "lb-1" });
		expect(outcome.status === "failed" && outcome.error).toContain(
			"commit refused",
		);
		expect(releasedLock(storage)).toBe(true);
	});

	it("does not save when the turn asks a question", async () => {
		const service = makeService(
			makeReader([
				frame("message.delta", { content: "Which data source?" }),
				frame("message.end", { status: "completed", liveboard_updated: false }),
			]),
		);
		const storage = makeStorage();

		const outcome = await startDashboardJob({
			service,
			storage,
			taskId: TASK_ID,
			setup: async () => {},
			buildMessage: () => "m",
			deadlineMs: 1_000,
		});

		expect(outcome.status).toBe("needs_input");
		expect(service.saveLiveboard).not.toHaveBeenCalled();
		expect(releasedLock(storage)).toBe(true);
	});

	it("clears the previous turn's stored outcome before running", async () => {
		const storage = makeStorage({
			turnOutcome: { status: "completed", text: "old" },
		});

		await startDashboardJob({
			service: makeService(),
			storage,
			taskId: TASK_ID,
			setup: async () => {},
			buildMessage: () => "m",
			deadlineMs: 1_000,
		});

		expect(storage.updateMetadata.mock.calls[0][1]).toMatchObject({
			turnOutcome: null,
			turnProgress: null,
		});
	});

	it("throws DashboardTurnBusyError when the task is locked", async () => {
		const service = makeService();
		const storage = makeStorage();
		storage.initializeConversation.mockRejectedValueOnce(new Error("409"));

		await expect(
			startDashboardJob({
				service,
				storage,
				taskId: TASK_ID,
				setup: async () => {},
				buildMessage: () => "m",
			}),
		).rejects.toBeInstanceOf(DashboardTurnBusyError);
		expect(service.openStream).not.toHaveBeenCalled();
		expect(storage.appendMessages).not.toHaveBeenCalled();
	});
});

describe("pollDashboardTurn", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns the stored outcome", async () => {
		const storage = makeStorage({
			turnOutcome: {
				status: "completed",
				liveboardUpdated: true,
				text: "done",
				dashboardId: "lb-1",
			},
		});

		await expect(pollDashboardTurn(storage, TASK_ID, 0)).resolves.toMatchObject(
			{ status: "completed", taskId: TASK_ID, dashboardId: "lb-1" },
		);
		expect(storage.updateMetadata).not.toHaveBeenCalled();
	});

	it("returns the outcome once it is stored during the wait", async () => {
		const storage = makeStorage({ turnHeartbeatAt: Date.now() });

		const pending = pollDashboardTurn(storage, TASK_ID, 10_000);
		await vi.advanceTimersByTimeAsync(100);
		storage.metadata.turnOutcome = {
			status: "completed",
			liveboardUpdated: true,
			text: "",
		};
		await vi.advanceTimersByTimeAsync(5_000);

		await expect(pending).resolves.toMatchObject({ status: "completed" });
	});

	it("returns in_progress with the latest text after waitMs", async () => {
		const storage = makeStorage({
			turnHeartbeatAt: Date.now(),
			turnProgress: { text: "Adding charts" },
		});

		const pending = pollDashboardTurn(storage, TASK_ID, 5_000);
		await vi.advanceTimersByTimeAsync(5_000);

		await expect(pending).resolves.toEqual({
			status: "in_progress",
			taskId: TASK_ID,
			text: "Adding charts",
		});
	});

	it("fails a task whose heartbeat is older than STALE_TASK_MS and releases it", async () => {
		const storage = makeStorage({
			turnHeartbeatAt: Date.now() - STALE_TASK_MS - 1,
		});

		const outcome = await pollDashboardTurn(storage, TASK_ID, 0);

		expect(outcome).toMatchObject({
			status: "failed",
			taskId: TASK_ID,
			dashboardId: "lb-1",
		});
		expect(storage.metadata.turnOutcome).toMatchObject({ status: "failed" });
		expect(releasedLock(storage)).toBe(true);
	});

	it("errors on an unknown task", async () => {
		const storage = makeStorage();
		storage.metadata = {};

		await expect(pollDashboardTurn(storage, TASK_ID, 0)).rejects.toThrow(
			"not found",
		);
	});
});
