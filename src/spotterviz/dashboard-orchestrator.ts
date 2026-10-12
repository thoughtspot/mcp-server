/**
 * Runs one dashboard agent turn as a single background job, so callers get a dashboard back instead
 * of a session to manage.
 *
 * A job is: set up (build the liveboard from answers, open the SpotterViz session), stream the
 * turn, save the liveboard, and store the outcome. It runs to completion whether or not anyone is
 * waiting on it. Tool calls only ever wait on it for a bounded time:
 *
 * - create/modify race the job against HANDLER_DEADLINE_MS and return `in_progress` with the task
 *   id when it is not done.
 * - get_dashboard_status never touches Aurora or ThoughtSpot. It reads the stored outcome, waiting
 *   up to POLL_WAIT_MS for one to appear.
 *
 * Invariants:
 * 1. The job alone saves the liveboard, exactly once, after the turn's last event. A client that
 *    stops polling still gets its dashboard saved, and concurrent polls cannot double-save.
 * 2. The generation committed is the one this turn's own `lb_refresh` events reported, tracked in
 *    the job's memory rather than read back from shared metadata.
 * 3. The task lock (the storage DO's is-done flag) is released on every exit path, and a status
 *    call fails a task whose job has gone silent, so a task can never stay busy forever.
 */

import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { withSpan } from "../metrics/tracing/tracing-utils";
import type { StorageServiceClient } from "../storage-service/storage-service";
import type { SpotterVizService } from "./spotterviz-service";
import { generationFromEvent, readAuroraStream } from "./spotterviz-sse-stream";
import {
	HANDLER_DEADLINE_MS,
	HEARTBEAT_INTERVAL_MS,
	POLL_INTERVAL_MS,
	POLL_WAIT_MS,
	STALE_TASK_MS,
	STREAM_IDLE_TIMEOUT_MS,
	sleep,
} from "./timeouts";
import {
	type TurnChoice,
	type TurnProgress,
	type TurnStatus,
	accumulateProgress,
	summarizeProgress,
} from "./turn-summary";
import type { AuroraSessionContext, SpotterVizEvent } from "./types";

/**
 * The terminal outcome of a turn, minus the task id, as stored for replay. Spelled out rather than
 * derived from DashboardTurnOutcome: deriving it collapsed the optional fields to `never`.
 */
interface StoredOutcome {
	status: TurnStatus;
	liveboardUpdated: boolean;
	text: string;
	question?: string;
	choice?: TurnChoice;
	error?: string;
	dashboardId?: string;
	dashboardUrl?: string;
}

/** Metadata slots holding a task's state. */
interface TurnMetadata extends Partial<AuroraSessionContext> {
	turnProgress?: TurnProgress | null;
	/** The finished turn's result, written once by the job. */
	turnOutcome?: StoredOutcome | null;
	/** Epoch ms of the job's last sign of life. */
	turnHeartbeatAt?: number | null;
}

/** Raised when a turn is already in flight for this task. Callers map it to a friendly message. */
export class DashboardTurnBusyError extends Error {
	constructor(taskId: string) {
		super(`A dashboard task is already running for ${taskId}`);
		this.name = "DashboardTurnBusyError";
	}
}

export type DashboardTurnOutcome =
	| {
			status: "in_progress";
			taskId: string;
			/** Latest assistant prose, if any has streamed yet. */
			text?: string;
	  }
	| (StoredOutcome & { taskId: string });

export interface StartDashboardJobParams {
	service: SpotterVizService;
	storage: StorageServiceClient;
	/** Opaque task id; also the storage key for the task's state. */
	taskId: string;
	/**
	 * Work to do before the turn: build the liveboard, open the SpotterViz session. Runs inside
	 * the job, so it is covered by the handler deadline like everything else.
	 */
	setup: () => Promise<void>;
	/** Builds the prompt for this turn. */
	buildMessage: () => string;
	waitUntil?: (promise: Promise<unknown>) => void;
	deadlineMs?: number;
	idleMs?: number;
}

/**
 * Start a job for `taskId` and wait for it up to `deadlineMs`.
 *
 * @throws DashboardTurnBusyError if a turn is already in flight for this task.
 */
export async function startDashboardJob(
	params: StartDashboardJobParams,
): Promise<DashboardTurnOutcome> {
	const {
		storage,
		taskId,
		waitUntil,
		deadlineMs = HANDLER_DEADLINE_MS,
	} = params;

	// Compare-and-set on the DO's is-done key: the task lock.
	try {
		await storage.initializeConversation(taskId);
	} catch {
		throw new DashboardTurnBusyError(taskId);
	}

	// Clear the previous turn's slots, or a status call would replay its outcome.
	await patch(storage, taskId, {
		turnProgress: null,
		turnOutcome: null,
		turnHeartbeatAt: Date.now(),
	});

	const job = withSpan("dashboard-job", (span) => runJob(params, span));
	waitUntil?.(job);

	const outcome = await raceDeadline(job, deadlineMs);
	if (outcome) {
		return { ...outcome, taskId };
	}
	return { status: "in_progress", taskId };
}

/**
 * Report a task's state, waiting up to `waitMs` for it to finish. Reads stored state only.
 */
export async function pollDashboardTurn(
	storage: StorageServiceClient,
	taskId: string,
	waitMs = POLL_WAIT_MS,
): Promise<DashboardTurnOutcome> {
	return withSpan("dashboard-turn-poll", async (span) => {
		span?.setAttribute("dashboard_task_id", taskId);
		const waitUntilTime = Date.now() + waitMs;

		while (true) {
			const metadata = await storage
				.getMetadata<TurnMetadata>(taskId)
				.catch((error: Error) => {
					throw /No session state stored/.test(error.message)
						? new Error(
								"That task_id was not found. It may have expired; start the change again.",
							)
						: error;
				});
			if (metadata.turnOutcome) {
				return { ...metadata.turnOutcome, taskId };
			}

			const heartbeat = metadata.turnHeartbeatAt;
			if (typeof heartbeat !== "number") {
				throw new Error(
					"That task_id was not found. It may have expired; start the change again.",
				);
			}
			if (Date.now() - heartbeat > STALE_TASK_MS) {
				// The job's worker is gone. Fail the task so it does not stay busy forever.
				const outcome: StoredOutcome = {
					status: "failed",
					liveboardUpdated: false,
					text: metadata.turnProgress?.text ?? "",
					error:
						"The dashboard task stopped responding before it finished. Its changes were not saved. Try the request again.",
					...(metadata.liveboardId
						? { dashboardId: metadata.liveboardId }
						: {}),
				};
				await finish(storage, taskId, outcome);
				return { ...outcome, taskId };
			}

			if (Date.now() + POLL_INTERVAL_MS > waitUntilTime) {
				const text = metadata.turnProgress?.text;
				return { status: "in_progress", taskId, ...(text ? { text } : {}) };
			}
			await sleep(POLL_INTERVAL_MS);
		}
	});
}

async function runJob(
	params: StartDashboardJobParams,
	span: Span,
): Promise<StoredOutcome> {
	const {
		service,
		storage,
		taskId,
		setup,
		buildMessage,
		idleMs = STREAM_IDLE_TIMEOUT_MS,
	} = params;
	span?.setAttribute("dashboard_task_id", taskId);

	let progress: TurnProgress | undefined;
	let outcome: StoredOutcome;
	const controller = new AbortController();

	try {
		await setup();
		await heartbeat(storage, taskId, progress);

		const reader = await service.openStream({
			taskId,
			message: buildMessage(),
			signal: controller.signal,
		});

		let generation: string | undefined;
		let lastBeat = Date.now();
		const end = await readAuroraStream(
			reader,
			async (events: SpotterVizEvent[]) => {
				progress = accumulateProgress(progress, events);
				for (const event of events) {
					generation = generationFromEvent(event) ?? generation;
				}
				await heartbeat(storage, taskId, progress);
			},
			idleMs,
			async () => {
				if (Date.now() - lastBeat < HEARTBEAT_INTERVAL_MS) {
					return;
				}
				lastBeat = Date.now();
				await heartbeat(storage, taskId, progress);
			},
		);
		span?.setAttribute("stream_end", end);

		if (generation !== undefined) {
			// Persist for the next turn on this task, which must address the latest generation.
			await patch(storage, taskId, { generationNumber: generation });
		}

		outcome = await finalize(
			service,
			storage,
			taskId,
			progress,
			end,
			generation,
		);
	} catch (error) {
		controller.abort();
		console.error(`Dashboard task ${taskId} failed:`, error);
		outcome = {
			status: "failed",
			liveboardUpdated: false,
			text: progress?.text ?? "",
			error: `The dashboard could not be built: ${(error as Error).message}`,
			...(await readDashboardId(storage, taskId)),
		};
	}

	span?.setAttribute("dashboard_status", outcome.status);
	if (outcome.status === "failed") {
		span?.setStatus({ code: SpanStatusCode.ERROR, message: outcome.error });
	}
	await finish(storage, taskId, outcome);
	return outcome;
}

async function finalize(
	service: SpotterVizService,
	storage: StorageServiceClient,
	taskId: string,
	progress: TurnProgress | undefined,
	end: "message_end" | "closed" | "idle",
	generation: string | undefined,
): Promise<StoredOutcome> {
	const { status, ...rest } = summarizeProgress(
		progress ?? accumulateProgress(undefined, []),
	);

	if (end === "idle") {
		// Aurora's publish may already be in the edit session, but a stalled turn is not trusted
		// enough to commit.
		return {
			...rest,
			status: "failed",
			liveboardUpdated: false,
			error:
				"SpotterViz stopped sending updates before the turn finished, so the changes were not saved. Try the request again.",
			...(await readDashboardId(storage, taskId)),
		};
	}

	if (status !== "completed") {
		// The liveboard exists even when the turn did not change it, so the caller can still act
		// on it (for example to retry with more detail).
		return { status, ...rest, ...(await readDashboardId(storage, taskId)) };
	}

	try {
		const saved = await service.saveLiveboard({
			spotterVizSessionId: taskId,
			generationNumber: generation,
		});
		return {
			status: "completed",
			...rest,
			dashboardId: saved.liveboardId,
			dashboardUrl: saved.liveboardUrl,
		};
	} catch (error) {
		// Committing is load-bearing: the designer's own "publish" writes to the edit session, and
		// this save is what promotes it to the saved dashboard.
		return {
			status: "failed",
			...rest,
			...(await readDashboardId(storage, taskId)),
			error: `The changes could not be saved, so they are not visible on the dashboard: ${(error as Error).message}`,
		};
	}
}

/** Store the outcome and release the task lock. Best effort on both: callers are finishing. */
async function finish(
	storage: StorageServiceClient,
	taskId: string,
	outcome: StoredOutcome,
): Promise<void> {
	await patch(storage, taskId, { turnOutcome: outcome, turnHeartbeatAt: null });
	try {
		await storage.appendMessages(taskId, [], true);
	} catch (error) {
		console.error(`Failed to release dashboard task ${taskId}:`, error);
	}
}

async function heartbeat(
	storage: StorageServiceClient,
	taskId: string,
	progress: TurnProgress | undefined,
): Promise<void> {
	await patch(storage, taskId, {
		turnHeartbeatAt: Date.now(),
		...(progress ? { turnProgress: progress } : {}),
	});
}

/** Metadata writes are JSON; null (not undefined) is what clears a slot. */
async function patch(
	storage: StorageServiceClient,
	taskId: string,
	values: TurnMetadata,
): Promise<void> {
	try {
		await storage.updateMetadata<TurnMetadata>(taskId, values);
	} catch (error) {
		console.warn(`Failed to update dashboard task ${taskId}:`, error);
	}
}

async function readDashboardId(
	storage: StorageServiceClient,
	taskId: string,
): Promise<{ dashboardId?: string }> {
	try {
		const metadata = await storage.getMetadata<TurnMetadata>(taskId);
		return metadata.liveboardId ? { dashboardId: metadata.liveboardId } : {};
	} catch {
		return {};
	}
}

async function raceDeadline<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		clearTimeout(timer);
	}
}
