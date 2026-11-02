/**
 * The work behind the dashboard tools (create_dashboard, modify_dashboard, get_dashboard_status),
 * kept out of the MCP server so the server holds only the tool handlers. Everything here returns a
 * plain result; the handlers turn it into an MCP response.
 */

import type { Answer } from "../services/types";
import type { StorageServiceClient } from "../storage-service/storage-service";
import {
	DashboardTurnBusyError,
	type DashboardTurnOutcome,
	startDashboardJob,
} from "./dashboard-orchestrator";
import type { SpotterVizService } from "./spotterviz-service";
import { STALE_TASK_MS } from "./timeouts";

/** What a dashboard tool returns: structured content on success, or a message for an error. */
export type DashboardToolResult =
	| { ok: true; content: Record<string, unknown>; summary: string }
	| { ok: false; userMessage: string; logNote: string };

/**
 * Turn the `answer_id` values returned by get_session_updates into the answers TML export needs.
 * Returns undefined if any id is malformed.
 */
export function parseAnswerIds(
	answers: { answer_id: string; title: string }[],
): Answer[] | undefined {
	try {
		return answers.map((answer) => {
			const { session_id, gen_no } = JSON.parse(answer.answer_id);
			if (session_id === undefined || gen_no === undefined) {
				throw new Error("missing session_id or gen_no");
			}
			return {
				title: answer.title,
				session_identifier: session_id,
				generation_number: gen_no,
			};
		});
	} catch {
		return undefined;
	}
}

export function invalidAnswerIdResult(
	answers: { answer_id: string }[],
): DashboardToolResult {
	return {
		ok: false,
		userMessage:
			'Invalid answer_id format. Please provide the value returned from the "get_session_updates" tool.',
		logNote: `Error creating dashboard: invalid answer_id in ${JSON.stringify(answers.map((a) => a.answer_id))}`,
	};
}

/**
 * Check that a task handle belongs to the dashboard the caller named. Returns an error result when
 * it does not, or when the task can no longer be resolved at all.
 */
export async function findTaskDashboardMismatch(
	storage: StorageServiceClient,
	taskId: string,
	dashboardId: string,
): Promise<DashboardToolResult | undefined> {
	let taskDashboardId: string | undefined;
	try {
		const metadata = await storage.getMetadata<{ liveboardId?: string }>(
			taskId,
		);
		taskDashboardId = metadata.liveboardId;
	} catch (error) {
		console.error("Error resolving dashboard task:", error);
		return {
			ok: false,
			userMessage:
				"That `task_id` could not be found. It may have expired. Call `modify_dashboard` again with just `dashboard_id` and your full instruction to start a fresh change.",
			logNote: `Failed to resolve task ${taskId}: ${error}`,
		};
	}

	if (!taskDashboardId) {
		return {
			ok: false,
			userMessage:
				"That `task_id` is no longer available, most likely because it expired. Call `modify_dashboard` again with just `dashboard_id` and your full instruction to start a fresh change.",
			logNote: `Task ${taskId} has no liveboardId in metadata`,
		};
	}

	if (taskDashboardId !== dashboardId) {
		return {
			ok: false,
			userMessage: `That \`task_id\` belongs to a different dashboard (${taskDashboardId}), not ${dashboardId}. Pass the \`dashboard_id\` the task was started against, or omit \`task_id\` to start a fresh change on ${dashboardId}.`,
			logNote: `Task ${taskId} is bound to ${taskDashboardId}, caller passed ${dashboardId}`,
		};
	}

	return undefined;
}

/**
 * Resolve the dashboard a task was opened on, for continuing it. Returns an error result when the
 * task is unknown or has expired.
 */
export async function resolveTaskDashboard(
	storage: StorageServiceClient,
	taskId: string,
): Promise<{ liveboardId: string } | DashboardToolResult> {
	try {
		const metadata = await storage.getMetadata<{ liveboardId?: string }>(
			taskId,
		);
		if (metadata.liveboardId) {
			return { liveboardId: metadata.liveboardId };
		}
	} catch (error) {
		console.error("Error resolving dashboard task:", error);
	}
	return {
		ok: false,
		userMessage:
			"That `task_id` was not found. It may have expired. Call `create_dashboard` again with a `title` and the user's request to start over.",
		logNote: `Task ${taskId} could not be resolved`,
	};
}

/** Storage key recording which task last started work on a dashboard. */
const dashboardLockKey = (liveboardId: string) =>
	`dashboard-lock:${liveboardId}`;

/**
 * The id of another task still working on this dashboard, if any. Two designer turns on one
 * dashboard would each edit and save it, and the second save silently drops the first one's
 * changes, so only one may run at a time. A task counts as running until it stores an outcome, or
 * its heartbeat goes stale.
 */
async function otherTaskOnDashboard(
	storage: StorageServiceClient,
	liveboardId: string,
	taskId: string,
): Promise<string | undefined> {
	const lock = await storage
		.getSessionState<{ taskId?: string }>(dashboardLockKey(liveboardId))
		.catch(() => null);
	if (!lock?.taskId || lock.taskId === taskId) {
		return undefined;
	}
	const other = await storage
		.getSessionState<{
			turnOutcome?: unknown;
			turnHeartbeatAt?: number | null;
		}>(lock.taskId)
		.catch(() => null);
	const running =
		other &&
		!other.turnOutcome &&
		typeof other.turnHeartbeatAt === "number" &&
		Date.now() - other.turnHeartbeatAt < STALE_TASK_MS;
	return running ? lock.taskId : undefined;
}

/**
 * Shared path for create and modify: open or continue a designer task, run one turn under the
 * handler deadline, and map the outcome onto the tool result contract.
 */
export async function runDashboardWork(params: {
	service: SpotterVizService;
	storage: StorageServiceClient;
	/** Where the turn's liveboard comes from. Runs inside the job, under its time limits. */
	resolveLiveboard: () => Promise<{
		existingLiveboardId?: string;
		newLiveboardName?: string;
	}>;
	existingTaskId?: string;
	/** The dashboard this work changes, when known up front; one change runs per dashboard. */
	liveboardId?: string;
	buildMessage: () => string;
	waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<DashboardToolResult> {
	const { service, storage, existingTaskId, liveboardId } = params;

	// Minted here rather than taken from Aurora, so the caller gets a handle even when setup is
	// what runs past the deadline.
	const taskId = existingTaskId ?? crypto.randomUUID();

	if (liveboardId) {
		const other = await otherTaskOnDashboard(storage, liveboardId, taskId);
		if (other) {
			return {
				ok: false,
				userMessage: `This dashboard is already being changed by another request (task_id ${other}). Wait for it with \`get_dashboard_status\` until it reports a final status, then try again.`,
				logNote: `Dashboard ${liveboardId} busy with task ${other}`,
			};
		}
		await storage
			.putSessionState(dashboardLockKey(liveboardId), { taskId })
			.catch((error) =>
				console.warn(`Failed to record task for ${liveboardId}:`, error),
			);
	}

	try {
		const outcome = await startDashboardJob({
			service,
			storage,
			taskId,
			// Continuing a task keeps the designer's prior context, which is what makes answering
			// its question work.
			setup: existingTaskId
				? async () => {}
				: async () => {
						const target = await params.resolveLiveboard();
						await service.createSession({ taskId, ...target });
					},
			buildMessage: params.buildMessage,
			waitUntil: params.waitUntil,
		});
		return dashboardOutcomeResult(outcome);
	} catch (error) {
		if (error instanceof DashboardTurnBusyError) {
			return {
				ok: false,
				userMessage:
					"This dashboard is still being worked on. Call `get_dashboard_status` with the `task_id` you were given until it reports a final status, then try again.",
				logNote: `Dashboard turn already in flight: ${error.message}`,
			};
		}
		console.error("Error running dashboard work:", error);
		return {
			ok: false,
			userMessage: `Failed to build the dashboard: ${(error as Error).message}`,
			logNote: "Dashboard work failed",
		};
	}
}

/** Map an orchestrator outcome onto the result contract shared by the dashboard tools. */
export function dashboardOutcomeResult(
	outcome: DashboardTurnOutcome,
): DashboardToolResult {
	if (outcome.status === "in_progress") {
		return {
			ok: true,
			content: {
				status: outcome.status,
				task_id: outcome.taskId,
				...(outcome.text ? { message: outcome.text } : {}),
			},
			summary: "Dashboard work still in progress",
		};
	}

	const base = {
		status: outcome.status,
		task_id: outcome.taskId,
		changes_applied: outcome.liveboardUpdated,
		...(outcome.dashboardId ? { dashboard_id: outcome.dashboardId } : {}),
	};

	if (outcome.status === "needs_input") {
		const message = outcome.question ?? outcome.text;
		return {
			ok: true,
			content: {
				...base,
				...(message ? { message } : {}),
				...(outcome.choice ? { choices: outcome.choice.choices } : {}),
			},
			summary: "Dashboard work needs more input",
		};
	}

	if (outcome.status === "failed") {
		return {
			ok: true,
			content: { ...base, message: outcome.error ?? outcome.text },
			summary: "Dashboard work failed",
		};
	}

	return {
		ok: true,
		content: {
			...base,
			...(outcome.dashboardUrl ? { dashboard_url: outcome.dashboardUrl } : {}),
			...(outcome.text ? { message: outcome.text } : {}),
		},
		summary: "Dashboard ready",
	};
}
