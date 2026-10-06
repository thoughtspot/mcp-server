/**
 * Types for the SpotterViz (Aurora liveboard agent) integration.
 *
 * `BachSession` lives in `src/thoughtspot/types.ts` because BACH is a general ThoughtSpot
 * concept; the types below are SpotterViz-specific.
 */

export interface AuroraSessionInitResult {
	auroraSessionId: string;
	jwtToken: string;
	liveboardName?: string;
}

/**
 * Aurora session context stored in the shared ConversationStorageServer DO under the metadata
 * slot. Follow-up SpotterViz tools read this to address the right Aurora session. The instance
 * URL is not stored — it's taken fresh from ctx.props on each request.
 */
export interface AuroraSessionContext extends Record<string, unknown> {
	auroraSessionId: string;
	auroraJwtToken: string;
	transactionId: string;
	generationNumber: string;
	liveboardId?: string;
	liveboardName?: string;
	/**
	 * Number of `get_updates` calls already issued for the current turn. Drives the per-call wait
	 * backoff. Reset to 0 whenever a turn is observed to be done and whenever a new turn starts via
	 * `submitQuery`. Absent means "not yet polled" (effectively 0).
	 */
	pollCount?: number;
}

export interface CreateSpotterVizSessionParams {
	newLiveboardName?: string;
	existingLiveboardId?: string;
}

export interface CreateSpotterVizSessionResult {
	spotterVizSessionId: string;
	liveboardId: string;
	liveboardName?: string;
}

/**
 * Aurora SSE event format.
 */
export interface SpotterVizEvent extends Record<string, unknown> {
	event_type: string;
	data: Record<string, unknown>;
	message_id?: string | null;
	idx?: number | null;
	timestamp?: string | null;
	tool_id?: string | null;
	group_id?: string | null;
	heading?: string | null;
}

export interface SubmitSpotterVizQueryParams {
	spotterVizSessionId: string;
	message: string;
}

export interface SubmitSpotterVizQueryResult {
	success: true;
}

export interface GetSpotterVizUpdatesParams {
	spotterVizSessionId: string;
}

export interface GetSpotterVizUpdatesResult {
	updates: SpotterVizEvent[];
	isDone: boolean;
}

export interface SaveSpotterVizLiveboardParams {
	spotterVizSessionId: string;
}

export interface SaveSpotterVizLiveboardResult {
	liveboardId: string;
	liveboardUrl: string;
}
