import { SpanStatusCode } from "@opentelemetry/api";
import type { MetricsRecorder } from "../metrics/runtime/metrics-recorder";
import {
	UPSTREAM_OPERATION_NAMES,
	observeUpstreamCall,
} from "../metrics/runtime/tool-metrics";
import { WithSpan, getActiveSpan } from "../metrics/tracing/tracing-utils";
import type { StorageServiceClient } from "../storage-service/storage-service";
import type { ThoughtSpotService } from "../thoughtspot/thoughtspot-service";
import type { SpotterVizClient } from "./spotterviz-client";
import { processAuroraSseStream } from "./spotterviz-sse-stream";
import type {
	AuroraSessionContext,
	AuroraSessionInitResult,
	CreateSpotterVizSessionParams,
	CreateSpotterVizSessionResult,
	GetSpotterVizUpdatesParams,
	GetSpotterVizUpdatesResult,
	SaveSpotterVizLiveboardParams,
	SaveSpotterVizLiveboardResult,
	SpotterVizEvent,
	SubmitSpotterVizQueryParams,
} from "./types";

// Adaptive poll cadence for streaming SSE updates: 2 s → 4 s → 8 s → 16 s (held).
const GET_UPDATES_WAIT_SEQUENCE_MS = [2_000, 4_000, 8_000, 16_000];

/**
 * Orchestrates a SpotterViz (Aurora) session: creation, per-turn query streaming, adaptive
 * SSE polling, and committing the liveboard. Delegates BACH/liveboard ops to ThoughtSpotService
 * and Aurora HTTP to SpotterVizClient; uses StorageServiceClient for the event log and to
 * persist the Aurora session context.
 */
export class SpotterVizService {
	constructor(
		private readonly tsService: ThoughtSpotService,
		private readonly storage: StorageServiceClient,
		private readonly client: SpotterVizClient,
		private readonly recorder?: MetricsRecorder,
	) {}

	/**
	 * Open a SpotterViz session: provision a new empty liveboard or attach to an existing one,
	 * start a BACH pinboard session, initialize Aurora, and persist the resulting context.
	 */
	@WithSpan("spotterviz-create-session")
	async createSession(
		params: CreateSpotterVizSessionParams,
	): Promise<CreateSpotterVizSessionResult> {
		const span = getActiveSpan();
		const { newLiveboardName, existingLiveboardId } = params;

		try {
			const liveboardId = await this.resolveLiveboardId(
				newLiveboardName,
				existingLiveboardId,
			);
			span?.setAttribute("liveboard_id", liveboardId);

			const bachSession =
				await this.tsService.createBachPinboardSession(liveboardId);
			span?.setAttributes({
				bach_transaction_id: bachSession.transactionId,
				bach_generation_number: bachSession.generationNumber,
			});

			const aurora = await observeUpstreamCall(
				this.recorder,
				UPSTREAM_OPERATION_NAMES.createAuroraSession,
				() => this.client.createAuroraSession(bachSession),
			);
			span?.setAttribute("aurora_session_id", aurora.auroraSessionId);

			await this.persistAuroraContext(
				aurora,
				bachSession,
				liveboardId,
				newLiveboardName,
			);

			span?.setStatus({
				code: SpanStatusCode.OK,
				message: "SpotterViz session created",
			});
			return {
				spotterVizSessionId: aurora.auroraSessionId,
				liveboardId,
				liveboardName: aurora.liveboardName ?? newLiveboardName,
			};
		} catch (error) {
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: `Error creating SpotterViz session: ${(error as Error).message}`,
			});
			throw error;
		}
	}

	/**
	 * Begin a new turn: open the SSE stream and return a `streamPromise` for the caller to plumb
	 * through `ctx.waitUntil`. The promise drains events into the DO and marks done at stream
	 * close.
	 */
	@WithSpan("spotterviz-submit-query")
	async submitQuery(
		params: SubmitSpotterVizQueryParams,
	): Promise<{ streamPromise: Promise<void> }> {
		const span = getActiveSpan();
		const { spotterVizSessionId, message } = params;
		span?.setAttribute("spotterviz_session_id", spotterVizSessionId);
		span?.setAttribute("message_length", message.length);

		try {
			const context =
				await this.storage.getMetadata<AuroraSessionContext>(
					spotterVizSessionId,
				);

			// Defensive: the previous turn may have ended without anyone calling get_updates, which
			// would leave pollCount stale and make the first poll of this turn wait too long.
			await this.storage.updateMetadata<AuroraSessionContext>(
				spotterVizSessionId,
				{ pollCount: 0 },
			);

			const response = await observeUpstreamCall(
				this.recorder,
				UPSTREAM_OPERATION_NAMES.submitAuroraQuery,
				() => this.client.submitAuroraQuery(context, message),
			);

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error("Aurora /chat/stream returned no response body");
			}

			const streamPromise = processAuroraSseStream(
				spotterVizSessionId,
				reader,
				this.storage,
			);

			span?.setStatus({
				code: SpanStatusCode.OK,
				message: "SpotterViz turn started",
			});
			return { streamPromise };
		} catch (error) {
			// The handler primed the conversation before calling submitQuery; if we fail anywhere
			// after that, mark it done so get_updates doesn't poll a stream that will never arrive.
			await this.markSessionDoneBestEffort(spotterVizSessionId);
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: `Error submitting SpotterViz query: ${(error as Error).message}`,
			});
			throw error;
		}
	}

	/**
	 * Persist the SpotterViz session's current BACH generation to the saved liveboard. The session
	 * remains live afterwards so the user can keep iterating; only the liveboard is committed.
	 */
	@WithSpan("spotterviz-save-liveboard")
	async saveLiveboard(
		params: SaveSpotterVizLiveboardParams,
	): Promise<SaveSpotterVizLiveboardResult> {
		const span = getActiveSpan();
		const { spotterVizSessionId } = params;
		span?.setAttribute("spotterviz_session_id", spotterVizSessionId);

		try {
			const context =
				await this.storage.getMetadata<AuroraSessionContext>(
					spotterVizSessionId,
				);
			if (!context.liveboardId) {
				throw new Error(
					"SpotterViz session metadata is missing a liveboardId; cannot save.",
				);
			}
			span?.setAttributes({
				liveboard_id: context.liveboardId,
				bach_transaction_id: context.transactionId,
				bach_generation_number: context.generationNumber,
			});

			await this.tsService.saveBachPinboard(
				context.transactionId,
				context.generationNumber,
			);

			const liveboardUrl = `${this.client.instanceUrl}/#/pinboard/${context.liveboardId}`;
			span?.setStatus({
				code: SpanStatusCode.OK,
				message: "SpotterViz liveboard saved",
			});
			return { liveboardId: context.liveboardId, liveboardUrl };
		} catch (error) {
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: `Error saving SpotterViz liveboard: ${(error as Error).message}`,
			});
			throw error;
		}
	}

	/**
	 * Drain SSE events that have arrived since the caller's last poll. Fast-returns if the turn
	 * is already done; otherwise waits one step of `GET_UPDATES_WAIT_SEQUENCE_MS[pollCount]`,
	 * advances `pollCount`, and polls once more. `pollCount` resets when a turn finishes.
	 */
	@WithSpan("spotterviz-get-updates")
	async getUpdates(
		params: GetSpotterVizUpdatesParams,
	): Promise<GetSpotterVizUpdatesResult> {
		const span = getActiveSpan();
		const { spotterVizSessionId } = params;
		span?.setAttribute("spotterviz_session_id", spotterVizSessionId);

		// Initial peek — if the turn is already done, fast-return without waiting.
		const initial =
			await this.storage.getNewEvents<SpotterVizEvent>(spotterVizSessionId);
		const collected: SpotterVizEvent[] = [...initial.messages];

		if (initial.isDone) {
			await this.resetPollCount(spotterVizSessionId);
			span?.setAttributes({
				wait_time_ms: 0,
				poll_count_used: 0,
				total_session_updates: collected.length,
				is_done: true,
			});
			span?.setStatus({
				code: SpanStatusCode.OK,
				message: "SpotterViz turn already done at peek",
			});
			return { updates: collected, isDone: true };
		}

		// Load pollCount, sleep one step, advance pollCount, then poll once more.
		const pollCount = await this.readPollCount(spotterVizSessionId);
		const waitMs =
			GET_UPDATES_WAIT_SEQUENCE_MS[
				Math.min(pollCount, GET_UPDATES_WAIT_SEQUENCE_MS.length - 1)
			];
		await new Promise((resolve) => setTimeout(resolve, waitMs));
		await this.storage.updateMetadata<AuroraSessionContext>(
			spotterVizSessionId,
			{ pollCount: pollCount + 1 },
		);

		const followup =
			await this.storage.getNewEvents<SpotterVizEvent>(spotterVizSessionId);
		collected.push(...followup.messages);

		if (followup.isDone) {
			await this.resetPollCount(spotterVizSessionId);
		}

		span?.setAttributes({
			wait_time_ms: waitMs,
			poll_count_used: pollCount,
			total_session_updates: collected.length,
			is_done: followup.isDone,
		});
		span?.setStatus({
			code: SpanStatusCode.OK,
			message: "SpotterViz updates polled",
		});

		return { updates: collected, isDone: followup.isDone };
	}

	private async resolveLiveboardId(
		newLiveboardName: string | undefined,
		existingLiveboardId: string | undefined,
	): Promise<string> {
		if (newLiveboardName) {
			const created =
				await this.tsService.createEmptyLiveboard(newLiveboardName);
			return created.liveboardId;
		}
		if (existingLiveboardId) {
			return existingLiveboardId;
		}
		throw new Error(
			"Could not resolve a liveboard id for the SpotterViz session.",
		);
	}

	private async persistAuroraContext(
		aurora: AuroraSessionInitResult,
		bachSession: { transactionId: string; generationNumber: string },
		liveboardId: string,
		newLiveboardName: string | undefined,
	): Promise<void> {
		const auroraContext: AuroraSessionContext = {
			auroraSessionId: aurora.auroraSessionId,
			auroraJwtToken: aurora.jwtToken,
			transactionId: bachSession.transactionId,
			generationNumber: bachSession.generationNumber,
			liveboardId,
			liveboardName: aurora.liveboardName ?? newLiveboardName,
		};
		await this.storage.updateMetadata<AuroraSessionContext>(
			aurora.auroraSessionId,
			auroraContext,
		);
	}

	private async markSessionDoneBestEffort(
		spotterVizSessionId: string,
	): Promise<void> {
		try {
			await this.storage.appendEvents(spotterVizSessionId, [], true);
		} catch (err) {
			console.error(
				`Failed to mark SpotterViz session ${spotterVizSessionId} done:`,
				err,
			);
		}
	}

	private async readPollCount(spotterVizSessionId: string): Promise<number> {
		const metadata =
			await this.storage.getMetadata<AuroraSessionContext>(spotterVizSessionId);
		return typeof metadata.pollCount === "number" ? metadata.pollCount : 0;
	}

	private async resetPollCount(spotterVizSessionId: string): Promise<void> {
		try {
			await this.storage.updateMetadata<AuroraSessionContext>(
				spotterVizSessionId,
				{ pollCount: 0 },
			);
		} catch (err) {
			console.warn(
				`Failed to reset pollCount for ${spotterVizSessionId}:`,
				err,
			);
			// Delibrately swallow the error as the events have already been drained.
			// If this throws, the drained errors would be lost.
		}
	}
}
