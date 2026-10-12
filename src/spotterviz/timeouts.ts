/**
 * Time limits for the dashboard tools. Every wait on another service has an upper bound, because
 * an MCP client keeps a stuck call open (the transport pings every 30s) until it gives up on its
 * own, which in Claude Desktop is four minutes of silence.
 */

/** Longest a create or modify call blocks before handing back a task id. */
export const HANDLER_DEADLINE_MS = 50_000;

/** Longest a status call waits for the task to finish before reporting it is still running. */
export const POLL_WAIT_MS = 15_000;

/** How often a status call re-reads the stored task state while it waits. */
export const POLL_INTERVAL_MS = 2_000;

/** Single request to ThoughtSpot or Aurora (session setup, save, TML import). */
export const UPSTREAM_CALL_TIMEOUT_MS = 20_000;

/** Single call to the storage Durable Object. */
export const STORAGE_CALL_TIMEOUT_MS = 10_000;

/** Aurora must start answering the chat stream within this long. */
export const STREAM_HEADERS_TIMEOUT_MS = 30_000;

/**
 * A turn that sends nothing at all, not even a keepalive, for this long is treated as dead. Above
 * Aurora's own 300s limit on a single tool call, so a slow but live tool call is never cut off.
 */
export const STREAM_IDLE_TIMEOUT_MS = 330_000;

/** Least time between heartbeat writes while bytes keep arriving. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * A running task whose heartbeat is older than this has lost its worker (for example the Durable
 * Object was evicted mid-turn), so a status call fails it instead of reporting it as running.
 */
export const STALE_TASK_MS = STREAM_IDLE_TIMEOUT_MS + 60_000;

export class TimeoutError extends Error {
	constructor(label: string, ms: number) {
		super(`${label} did not respond within ${Math.round(ms / 1000)}s`);
		this.name = "TimeoutError";
	}
}

/** Reject with a TimeoutError if `promise` has not settled within `ms`. */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
