import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DashboardTurnBusyError,
	pollDashboardTurn,
	runDashboardTurn,
} from "../../src/spotterviz/dashboard-orchestrator";
import type { SpotterVizService } from "../../src/spotterviz/spotterviz-service";
import type { SpotterVizEvent } from "../../src/spotterviz/types";
import type { StorageServiceClient } from "../../src/storage-service/storage-service";

const TASK_ID = "task-1";

type ServiceMock = SpotterVizService & {
	submitQuery: ReturnType<typeof vi.fn>;
	getUpdates: ReturnType<typeof vi.fn>;
	saveLiveboard: ReturnType<typeof vi.fn>;
};

type StorageMock = StorageServiceClient & {
	initializeConversation: ReturnType<typeof vi.fn>;
	getMetadata: ReturnType<typeof vi.fn>;
	updateMetadata: ReturnType<typeof vi.fn>;
};

function event(
	event_type: string,
	data: Record<string, unknown>,
): SpotterVizEvent {
	return { event_type, data };
}

const DONE_EVENTS = [
	event("control.action", { action: "lb_refresh", metadata: {} }),
	event("message.end", { status: "completed", liveboard_updated: true }),
];

function makeService(streamPromise: Promise<void>): ServiceMock {
	return {
		submitQuery: vi.fn().mockResolvedValue({ streamPromise }),
		getUpdates: vi
			.fn()
			.mockResolvedValue({ updates: DONE_EVENTS, isDone: true }),
		saveLiveboard: vi.fn().mockResolvedValue({
			liveboardId: "lb-1",
			liveboardUrl: "https://ts.example.com/#/pinboard/lb-1",
		}),
	} as unknown as ServiceMock;
}

function makeStorage(): StorageMock {
	return {
		initializeConversation: vi.fn().mockResolvedValue(undefined),
		getMetadata: vi.fn().mockResolvedValue({ liveboardId: "lb-1" }),
		updateMetadata: vi.fn().mockResolvedValue({}),
	} as unknown as StorageMock;
}

describe("runDashboardTurn", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns the finished outcome and saves when the turn beats the budget", async () => {
		const service = makeService(Promise.resolve());
		const storage = makeStorage();

		const outcome = await runDashboardTurn({
			service,
			storage,
			taskId: TASK_ID,
			message: "do the thing",
			budgetMs: 1_000,
		});

		expect(outcome.status).toBe("completed");
		expect(service.saveLiveboard).toHaveBeenCalledWith({
			spotterVizSessionId: TASK_ID,
		});
		if (outcome.status === "completed") {
			expect(outcome.dashboardUrl).toContain("/#/pinboard/lb-1");
		}
	});

	it("hands back a task id without reading events when the budget expires", async () => {
		// Reading events would advance a destructive bookmark in the storage DO and swallow the
		// turn's narrative before the follow-up poll could see it.
		let resolveStream: () => void = () => {};
		const streamPromise = new Promise<void>((resolve) => {
			resolveStream = resolve;
		});
		const service = makeService(streamPromise);
		const storage = makeStorage();

		const pending = runDashboardTurn({
			service,
			storage,
			taskId: TASK_ID,
			message: "do the thing",
			budgetMs: 1_000,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		const outcome = await pending;

		expect(outcome.status).toBe("in_progress");
		expect(outcome.taskId).toBe(TASK_ID);
		expect(service.getUpdates).not.toHaveBeenCalled();
		expect(service.saveLiveboard).not.toHaveBeenCalled();

		resolveStream();
	});

	it("biases the poll backoff after giving up, so the next poll does not waste a round trip", async () => {
		const service = makeService(new Promise<void>(() => {}));
		const storage = makeStorage();

		const pending = runDashboardTurn({
			service,
			storage,
			taskId: TASK_ID,
			message: "do the thing",
			budgetMs: 1_000,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await pending;

		expect(storage.updateMetadata).toHaveBeenCalledWith(TASK_ID, {
			pollCount: 2,
		});
	});

	it("registers the drain with waitUntil before racing it", async () => {
		const streamPromise = Promise.resolve();
		const service = makeService(streamPromise);
		const storage = makeStorage();
		const waitUntil = vi.fn();

		await runDashboardTurn({
			service,
			storage,
			taskId: TASK_ID,
			message: "do the thing",
			budgetMs: 1_000,
			waitUntil,
		});

		expect(waitUntil).toHaveBeenCalledWith(streamPromise);
	});

	it("clears the previous turn's stored answer so a follow-up actually runs", async () => {
		const service = makeService(Promise.resolve());
		const storage = makeStorage();

		await runDashboardTurn({
			service,
			storage,
			taskId: TASK_ID,
			message: "follow up",
			budgetMs: 1_000,
		});

		expect(storage.updateMetadata).toHaveBeenCalledWith(TASK_ID, {
			turnProgress: null,
			turnOutcome: null,
		});
		expect(service.submitQuery).toHaveBeenCalled();
	});

	it("raises a busy error when a turn is already in flight", async () => {
		const service = makeService(Promise.resolve());
		const storage = makeStorage();
		storage.initializeConversation.mockRejectedValue(
			new Error("already exists and is not marked done"),
		);

		await expect(
			runDashboardTurn({
				service,
				storage,
				taskId: TASK_ID,
				message: "do the thing",
				budgetMs: 1_000,
			}),
		).rejects.toBeInstanceOf(DashboardTurnBusyError);
		expect(service.submitQuery).not.toHaveBeenCalled();
	});

	// Committing is load-bearing: the designer's own publish writes to the edit session, and this
	// save promotes it to the saved dashboard. A failed save means the work is not visible.
	it("reports failure when the work was done but the commit failed", async () => {
		const service = makeService(Promise.resolve());
		const storage = makeStorage();
		service.saveLiveboard.mockRejectedValue(new Error("bach exploded"));

		const outcome = await runDashboardTurn({
			service,
			storage,
			taskId: TASK_ID,
			message: "do the thing",
			budgetMs: 1_000,
		});

		expect(outcome.status).toBe("failed");
		if (outcome.status === "failed") {
			expect(outcome.error).toMatch(/not visible on the dashboard/i);
		}
	});
});

describe("pollDashboardTurn", () => {
	afterEach(() => vi.restoreAllMocks());

	it("persists progress from a batch drained while the turn is still running", async () => {
		// The DO delivers each event exactly once, so a mid-turn poll must not drop what it read.
		const service = makeService(Promise.resolve());
		const storage = makeStorage();
		service.getUpdates.mockResolvedValue({
			updates: [event("message.delta", { content: "Which data source?" })],
			isDone: false,
		});

		const outcome = await pollDashboardTurn(service, storage, TASK_ID);

		expect(outcome.status).toBe("in_progress");
		expect(storage.updateMetadata).toHaveBeenCalledWith(
			TASK_ID,
			expect.objectContaining({
				turnProgress: expect.objectContaining({
					text: "Which data source?",
				}),
			}),
		);
	});

	it("replays the stored answer once a turn has finished, without saving again", async () => {
		// The event log is drained exactly once, so re-deriving on a repeat poll would see an
		// empty turn, report that nothing changed, and save the liveboard a second time.
		const service = makeService(Promise.resolve());
		const storage = makeStorage();
		storage.getMetadata.mockResolvedValue({
			liveboardId: "lb-1",
			turnOutcome: {
				status: "completed",
				liveboardUpdated: true,
				text: "Done.",
				steps: ["Publishing"],
				dashboardId: "lb-1",
				dashboardUrl: "https://ts.example.com/#/pinboard/lb-1",
			},
		});

		const outcome = await pollDashboardTurn(service, storage, TASK_ID);

		expect(outcome.status).toBe("completed");
		if (outcome.status === "completed") {
			expect(outcome.liveboardUpdated).toBe(true);
			expect(outcome.dashboardUrl).toContain("/#/pinboard/lb-1");
		}
		expect(service.getUpdates).not.toHaveBeenCalled();
		expect(service.saveLiveboard).not.toHaveBeenCalled();
	});

	it("stores the terminal outcome so later polls can replay it", async () => {
		const service = makeService(Promise.resolve());
		const storage = makeStorage();

		await pollDashboardTurn(service, storage, TASK_ID);

		expect(storage.updateMetadata).toHaveBeenCalledWith(
			TASK_ID,
			expect.objectContaining({
				turnOutcome: expect.objectContaining({ status: "completed" }),
			}),
		);
	});

	it("merges progress from an earlier poll into the final outcome", async () => {
		const service = makeService(Promise.resolve());
		const storage = makeStorage();
		storage.getMetadata.mockResolvedValue({
			liveboardId: "lb-1",
			turnProgress: {
				text: "Which data source",
				steps: [],
				sawRefresh: false,
			},
		});
		service.getUpdates.mockResolvedValue({
			updates: [
				event("message.delta", { content: " should I use?" }),
				event("message.end", { status: "completed", liveboard_updated: false }),
			],
			isDone: true,
		});

		const outcome = await pollDashboardTurn(service, storage, TASK_ID);

		expect(outcome.status).toBe("needs_input");
		if (outcome.status === "needs_input") {
			expect(outcome.question).toBe("Which data source should I use?");
		}
		expect(service.saveLiveboard).not.toHaveBeenCalled();
	});
});
