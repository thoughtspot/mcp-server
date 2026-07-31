/**
 * Runs one dashboard agent turn as a single unit of work, so callers get a dashboard back instead
 * of a session to manage.
 *
 * Turns typically take 60-180s, which is longer than many MCP clients will wait. The strategy is
 * therefore hybrid: block for a bounded budget so quick turns feel synchronous, and hand back a
 * pollable task id when the budget expires. The underlying stream keeps draining into the storage
 * Durable Object either way, so nothing is lost by giving up on the wait.
 *
 * Three invariants matter here and are each easy to break:
 *
 * 1. On the timeout path we must NOT read events. Reading advances a destructive bookmark in the
 *    DO (each event is delivered exactly once), which would swallow the turn's narrative before
 *    the follow-up poll could see it.
 * 2. A poll that finds the turn still running has already consumed a batch of events, so it must
 *    fold them into persisted progress. Otherwise a clarifying question streamed early would be
 *    lost and the turn would look like a silent no-op.
 * 3. We must only commit the liveboard after the stream has closed. The BACH generation number is
 *    patched into DO metadata as `lb_refresh` events arrive, so saving mid-turn would commit a
 *    stale generation.
 */

import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { withSpan } from "../metrics/tracing/tracing-utils";
import type { StorageServiceClient } from "../storage-service/storage-service";
import type { SpotterVizService } from "./spotterviz-service";
import {
	type TurnChoice,
	type TurnProgress,
	type TurnStatus,
	accumulateProgress,
	summarizeProgress,
} from "./turn-summary";
import type { AuroraSessionContext } from "./types";

/**
 * How long to block before handing back a task id. Most turns will exceed this; the budget exists
 * to make the fast cases feel synchronous, not to win the race. Kept just under the 60s read
 * timeout common in MCP clients.
 */
export const TURN_BLOCKING_BUDGET_MS = 55_000;

/**
 * Where to resume the poll backoff after the blocking budget expires. The backoff sequence is
 * [2s, 4s, 8s, 16s]; starting a fresh poll at 2s after already waiting ~55s wastes a round trip.
 */
const POST_TIMEOUT_POLL_COUNT = 2;

/**
 * The terminal outcome of a turn, minus the task id, as stored for replay. Spelled out rather than
 * derived from DashboardTurnOutcome: deriving it collapsed the optional fields to `never`.
 */
interface StoredOutcome {
	status: TurnStatus;
	liveboardUpdated: boolean;
	text: string;
	steps: string[];
	question?: string;
	choice?: TurnChoice;
	error?: string;
	dashboardId?: string;
	dashboardUrl?: string;
}

/** Metadata slots holding a turn's state across polls. */
interface TurnMetadata extends AuroraSessionContext {
	turnProgress?: TurnProgress;
	/**
	 * The finished turn's result. Polling after a turn has completed must return the same answer
	 * rather than re-deriving it: the event log has already been drained, so a second pass would
	 * see an empty turn, report that nothing changed, and save the liveboard again.
	 */
	turnOutcome?: StoredOutcome;
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
			steps: string[];
			/** Liveness signal: how many events the turn has produced so far. */
			eventsSeen: number;
			/** Partial assistant prose, if any has streamed yet. */
			text?: string;
	  }
	| (StoredOutcome & { taskId: string });

export interface RunDashboardTurnParams {
	service: SpotterVizService;
	storage: StorageServiceClient;
	/** The agent session id, surfaced to callers as an opaque task id. */
	taskId: string;
	/** The composed prompt for this turn. */
	message: string;
	waitUntil?: (promise: Promise<unknown>) => void;
	budgetMs?: number;
}

function startTimeout(ms: number): {
	promise: Promise<"timeout">;
	cancel: () => void;
} {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ms);
	});
	return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Submit one turn and wait for it, bounded by `budgetMs`.
 *
 * @throws DashboardTurnBusyError if a turn is already in flight for this task.
 */
export async function runDashboardTurn(
	params: RunDashboardTurnParams,
): Promise<DashboardTurnOutcome> {
	return withSpan("dashboard-turn-run", (span) => runTurn(params, span));
}

async function runTurn(
	params: RunDashboardTurnParams,
	span: Span,
): Promise<DashboardTurnOutcome> {
	const {
		service,
		storage,
		taskId,
		message,
		waitUntil,
		budgetMs = TURN_BLOCKING_BUDGET_MS,
	} = params;
	span?.setAttributes({ dashboard_task_id: taskId, budget_ms: budgetMs });

	// Compare-and-set on the DO's is-done key. This is the only thing preventing two concurrent
	// turns from interleaving writes into the same event log.
	try {
		await storage.initializeConversation(taskId);
	} catch {
		throw new DashboardTurnBusyError(taskId);
	}

	// Clear both carry-over slots from any previous turn on this session, or a follow-up would
	// replay the previous turn's stored answer instead of running.
	await clearTurnState(storage, taskId);

	const { streamPromise } = await service.submitQuery({
		spotterVizSessionId: taskId,
		message,
	});

	// Register before racing: if the runtime tears down the invocation when we return on the
	// timeout path, this keeps the drain alive. Registering and awaiting the same promise is safe.
	waitUntil?.(streamPromise);

	const timeout = startTimeout(budgetMs);
	let finished: boolean;
	try {
		finished =
			(await Promise.race([
				streamPromise.then(() => "done" as const),
				timeout.promise,
			])) === "done";
	} finally {
		timeout.cancel();
	}

	span?.setAttribute("finished_within_budget", finished);

	if (!finished) {
		// Deliberately read no events here so the follow-up poll still sees the whole turn.
		await biasPollBackoff(storage, taskId);
		span?.setStatus({
			code: SpanStatusCode.OK,
			message: "Dashboard turn exceeded blocking budget",
		});
		return { status: "in_progress", taskId, steps: [], eventsSeen: 0 };
	}

	return drainAndFinalize(service, storage, taskId);
}

/**
 * Poll an in-flight task. Returns `in_progress` while the turn is still running, folding whatever
 * events it consumed into persisted progress so nothing is lost.
 */
export async function pollDashboardTurn(
	service: SpotterVizService,
	storage: StorageServiceClient,
	taskId: string,
): Promise<DashboardTurnOutcome> {
	return withSpan("dashboard-turn-poll", async (span) => {
		span?.setAttribute("dashboard_task_id", taskId);
		return drainAndFinalize(service, storage, taskId);
	});
}

/**
 * Drain whatever has arrived, merge it into persisted progress, and either report the finished
 * outcome (committing the liveboard) or report that the turn is still running.
 */
async function drainAndFinalize(
	service: SpotterVizService,
	storage: StorageServiceClient,
	taskId: string,
): Promise<DashboardTurnOutcome> {
	// A turn that already finished has a stored answer. Return it verbatim so repeat polls are
	// idempotent and do not re-save the liveboard.
	const stored = await readStoredOutcome(storage, taskId);
	if (stored) {
		return { ...stored, taskId };
	}

	const { updates, isDone } = await service.getUpdates({
		spotterVizSessionId: taskId,
	});

	const prior = await readTurnProgress(storage, taskId);
	const progress = accumulateProgress(prior, updates);

	if (!isDone) {
		// Persist so the next poll does not lose this batch: the DO delivered it exactly once.
		await writeTurnProgress(storage, taskId, progress);
		return {
			status: "in_progress",
			taskId,
			steps: progress.steps,
			eventsSeen: progress.eventCount,
			...(progress.text ? { text: progress.text } : {}),
		};
	}

	const { status, ...rest } = summarizeProgress(progress);

	if (status !== "completed") {
		// The liveboard exists even when the turn did not change it, so the caller can still act
		// on it (for example to retry with more detail).
		const outcome: StoredOutcome = {
			status,
			...rest,
			...(await readLiveboardIdentity(storage, taskId)),
		};
		await writeStoredOutcome(storage, taskId, outcome);
		return { ...outcome, taskId };
	}

	// Only commit once the stream is closed, so the generation number is the freshest one.
	let outcome: StoredOutcome;
	try {
		const saved = await service.saveLiveboard({ spotterVizSessionId: taskId });
		outcome = {
			status: "completed",
			...rest,
			dashboardId: saved.liveboardId,
			dashboardUrl: saved.liveboardUrl,
		};
	} catch (error) {
		// Committing is load-bearing, not belt-and-braces: the designer's own "publish" writes to
		// the edit session, and this save is what promotes it to the saved dashboard. Verified by
		// observing a turn that reported publishing three charts, failed this save, and left the
		// saved dashboard without them. So this is a real loss, not a cosmetic warning.
		outcome = {
			status: "failed",
			...rest,
			...(await readLiveboardIdentity(storage, taskId)),
			error: `The changes could not be saved, so they are not visible on the dashboard: ${(error as Error).message}`,
		};
	}

	await writeStoredOutcome(storage, taskId, outcome);
	return { ...outcome, taskId };
}

/** Best-effort liveboard id for outcomes that did not go through a save. */
async function readLiveboardIdentity(
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

/**
 * Reset a session's per-turn carry-over state. Uses null rather than undefined because the
 * metadata write is JSON-serialised, which drops undefined and would leave the old value in place.
 */
async function clearTurnState(
	storage: StorageServiceClient,
	taskId: string,
): Promise<void> {
	try {
		await storage.updateMetadata<TurnMetadata>(taskId, {
			turnProgress: null,
			turnOutcome: null,
		} as unknown as Partial<TurnMetadata>);
	} catch (error) {
		console.warn(`Failed to clear turn state for ${taskId}:`, error);
	}
}

async function readStoredOutcome(
	storage: StorageServiceClient,
	taskId: string,
): Promise<StoredOutcome | undefined> {
	try {
		const metadata = await storage.getMetadata<TurnMetadata>(taskId);
		return metadata.turnOutcome;
	} catch (error) {
		console.warn(`Failed to read stored outcome for ${taskId}:`, error);
		return undefined;
	}
}

async function writeStoredOutcome(
	storage: StorageServiceClient,
	taskId: string,
	outcome: StoredOutcome,
): Promise<void> {
	try {
		await storage.updateMetadata<TurnMetadata>(taskId, {
			turnOutcome: outcome,
		} as Partial<TurnMetadata>);
	} catch (error) {
		// A repeat poll would re-derive the outcome instead of replaying it; not fatal.
		console.warn(`Failed to persist outcome for ${taskId}:`, error);
	}
}

async function readTurnProgress(
	storage: StorageServiceClient,
	taskId: string,
): Promise<TurnProgress | undefined> {
	try {
		const metadata = await storage.getMetadata<TurnMetadata>(taskId);
		return metadata.turnProgress;
	} catch (error) {
		console.warn(`Failed to read turn progress for ${taskId}:`, error);
		return undefined;
	}
}

async function writeTurnProgress(
	storage: StorageServiceClient,
	taskId: string,
	progress: TurnProgress | undefined,
): Promise<void> {
	try {
		await storage.updateMetadata<TurnMetadata>(taskId, {
			turnProgress: progress,
		} as Partial<TurnMetadata>);
	} catch (error) {
		console.warn(`Failed to persist turn progress for ${taskId}:`, error);
	}
}

async function biasPollBackoff(
	storage: StorageServiceClient,
	taskId: string,
): Promise<void> {
	try {
		await storage.updateMetadata<AuroraSessionContext>(taskId, {
			pollCount: POST_TIMEOUT_POLL_COUNT,
		});
	} catch (error) {
		// Only affects how long the next poll waits; not worth failing the turn over.
		console.warn(`Failed to bias poll backoff for ${taskId}:`, error);
	}
}
