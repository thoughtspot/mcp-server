import { SpanStatusCode } from "@opentelemetry/api";
import type { MetricsRecorder } from "../metrics/runtime/metrics-recorder";
import {
	UPSTREAM_OPERATION_NAMES,
	observeUpstreamCall,
} from "../metrics/runtime/tool-metrics";
import { WithSpan, getActiveSpan } from "../metrics/tracing/tracing-utils";
import type { ThoughtSpotService } from "../services/thoughtspot-service";
import type { StorageServiceClient } from "../storage-service/storage-service";
import type { SpotterVizClient } from "./spotterviz-client";
import {
	STREAM_HEADERS_TIMEOUT_MS,
	TimeoutError,
	UPSTREAM_CALL_TIMEOUT_MS,
	withTimeout,
} from "./timeouts";
import type {
	AuroraSessionContext,
	CreateSpotterVizSessionParams,
	CreateSpotterVizSessionResult,
	SaveSpotterVizLiveboardParams,
	SaveSpotterVizLiveboardResult,
} from "./types";

/**
 * Talks to SpotterViz (Aurora) for one dashboard task: open a session on a liveboard, start a
 * turn's event stream, and commit the liveboard. Delegates BACH/liveboard ops to
 * ThoughtSpotService and Aurora HTTP to SpotterVizClient; keeps the Aurora session context in
 * storage under the task id. Every upstream call is time-limited.
 */
export class SpotterVizService {
	constructor(
		private readonly tsService: ThoughtSpotService,
		private readonly storage: StorageServiceClient,
		private readonly client: SpotterVizClient,
		private readonly recorder?: MetricsRecorder,
	) {}

	get instanceUrl(): string {
		return this.client.instanceUrl;
	}

	/**
	 * Open a SpotterViz session for `taskId`: provision a new empty liveboard or attach to an
	 * existing one, start a BACH pinboard session, initialize Aurora, and persist the context.
	 */
	@WithSpan("spotterviz-create-session")
	async createSession(
		params: CreateSpotterVizSessionParams,
	): Promise<CreateSpotterVizSessionResult> {
		const span = getActiveSpan();
		const { taskId, newLiveboardName, existingLiveboardId } = params;
		span?.setAttribute("spotterviz_session_id", taskId);

		try {
			const liveboardId = await this.resolveLiveboardId(
				newLiveboardName,
				existingLiveboardId,
			);
			span?.setAttribute("liveboard_id", liveboardId);
			// Recorded before the slower steps so a task that fails during setup still knows its
			// dashboard.
			await this.storage.updateMetadata<Partial<AuroraSessionContext>>(taskId, {
				liveboardId,
			});

			const bachSession = await withTimeout(
				this.tsService.createBachPinboardSession(liveboardId),
				UPSTREAM_CALL_TIMEOUT_MS,
				"Opening the dashboard for editing",
			);
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

			const liveboardName = aurora.liveboardName ?? newLiveboardName;
			await this.storage.updateMetadata<AuroraSessionContext>(taskId, {
				auroraSessionId: aurora.auroraSessionId,
				auroraJwtToken: aurora.jwtToken,
				transactionId: bachSession.transactionId,
				generationNumber: bachSession.generationNumber,
				liveboardId,
				liveboardName,
			});

			span?.setStatus({
				code: SpanStatusCode.OK,
				message: "SpotterViz session created",
			});
			return { spotterVizSessionId: taskId, liveboardId, liveboardName };
		} catch (error) {
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: `Error creating SpotterViz session: ${(error as Error).message}`,
			});
			throw error;
		}
	}

	/**
	 * Start a turn and return a reader over its SSE body. Aborting `signal` cancels the request
	 * and the body. Fails if Aurora does not start answering within STREAM_HEADERS_TIMEOUT_MS.
	 */
	@WithSpan("spotterviz-open-stream")
	async openStream(params: {
		taskId: string;
		message: string;
		signal: AbortSignal;
	}): Promise<ReadableStreamDefaultReader<Uint8Array>> {
		const span = getActiveSpan();
		const { taskId, message, signal } = params;
		span?.setAttribute("spotterviz_session_id", taskId);
		span?.setAttribute("message_length", message.length);

		const context =
			await this.storage.getMetadata<AuroraSessionContext>(taskId);
		if (!context.auroraSessionId) {
			throw new Error("The dashboard task has no SpotterViz session.");
		}

		// One controller for this request: aborted by the caller's signal or by the headers limit.
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		const headersTimer = setTimeout(
			() =>
				controller.abort(
					new TimeoutError("SpotterViz", STREAM_HEADERS_TIMEOUT_MS),
				),
			STREAM_HEADERS_TIMEOUT_MS,
		);

		try {
			const response = await observeUpstreamCall(
				this.recorder,
				UPSTREAM_OPERATION_NAMES.submitAuroraQuery,
				() =>
					this.client.submitAuroraQuery(context, message, controller.signal),
			);
			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error("Aurora /chat/stream returned no response body");
			}
			span?.setStatus({ code: SpanStatusCode.OK, message: "Turn started" });
			return reader;
		} catch (error) {
			const reason = controller.signal.aborted
				? controller.signal.reason
				: error;
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: `Error starting SpotterViz turn: ${(reason as Error).message}`,
			});
			throw reason instanceof Error ? reason : error;
		} finally {
			clearTimeout(headersTimer);
		}
	}

	/**
	 * Commit a BACH generation to the saved liveboard. The generation is passed in by the caller,
	 * which tracked it from the turn's own events, so a concurrent metadata write cannot make this
	 * commit a stale one.
	 */
	@WithSpan("spotterviz-save-liveboard")
	async saveLiveboard(
		params: SaveSpotterVizLiveboardParams,
	): Promise<SaveSpotterVizLiveboardResult> {
		const span = getActiveSpan();
		const { spotterVizSessionId, generationNumber } = params;
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
			const generation = generationNumber ?? context.generationNumber;
			span?.setAttributes({
				liveboard_id: context.liveboardId,
				bach_transaction_id: context.transactionId,
				bach_generation_number: generation,
			});

			await withTimeout(
				this.tsService.saveBachPinboard(context.transactionId, generation),
				UPSTREAM_CALL_TIMEOUT_MS,
				"Saving the dashboard",
			);

			const liveboardUrl = `${this.client.instanceUrl}/#/insights/pinboard/${context.liveboardId}`;
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

	private async resolveLiveboardId(
		newLiveboardName: string | undefined,
		existingLiveboardId: string | undefined,
	): Promise<string> {
		if (existingLiveboardId) {
			return existingLiveboardId;
		}
		if (newLiveboardName) {
			const created = await withTimeout(
				this.tsService.createEmptyLiveboard(newLiveboardName),
				UPSTREAM_CALL_TIMEOUT_MS,
				"Creating the dashboard",
			);
			return created.liveboardId;
		}
		throw new Error(
			"Could not resolve a liveboard id for the SpotterViz session.",
		);
	}
}
