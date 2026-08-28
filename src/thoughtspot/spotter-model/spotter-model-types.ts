/**
 * Types for the Spotter Model (Lumos) agentic model-creation flow.
 */

/**
 * Persisted *scalar* state for a Spotter model session, stored as a single blob (the DO's generic
 * session-state slot) in the ConversationStorageServerSQLite Durable Object so it survives isolate
 * restarts. The streamed updates are NOT here — they go through the same append/read-bookmark
 * message stream the analytical-session tools use, so the background stream consumer and the reader
 * never clobber each other on a shared blob.
 */
export interface ModelSessionState {
	transactionId: string;
	generationNo: number;
	// Every edit generation the server has reported for this session (the initial/baseline
	// generation from model/init is excluded). Sent as genNoWorkingSet on the bach SAVE_WORKSHEET
	// request — the save fails without the full working set, since one edit spans many generations.
	genNoWorkingSet: number[];
	// A ThoughtSpot session cookie (JSESSIONID=…; possibly more) minted from the bearer token via
	// session/login. Forwarded on the Lumos /chat calls because backend tools (e.g. FormulaGen
	// validation) require a cookie session — a Bearer token alone hits a broken code path.
	sessionCookie?: string;
	// The most recent clarification the builder asked (the inner `choice` object from a
	// META_CHOICE event: { title, choice_type, choice_option_type, choice_options: [...] }).
	// The builder does not send a choice_id, so to answer we echo this object back upstream with
	// each option's is_selected flag set per the user's selection. Null when nothing is pending.
	pendingChoice?: Record<string, unknown> | null;
}

// A single normalized streamed update (e.g. { type: "text", text }, { type: "choice", ... }).
// Structurally a RawMessage, which is how the message stream stores it.
export type ModelUpdate = Record<string, unknown>;

/**
 * Where the stream consumer writes what it parses. Keeps this module independent of the Durable
 * Object client: the server binds a session id to a StorageServiceClient and passes it in, and
 * tests pass a fake.
 */
export interface ModelStreamSink {
	// Persist the scalar session state (generation/pendingChoice changed).
	putSession(session: ModelSessionState): Promise<void>;
	// Append normalized updates; isDone marks the turn complete so pollers stop.
	appendUpdates(
		updates: ModelUpdate[],
		opts: { isDone?: boolean },
	): Promise<void>;
}

// ── Upstream call shapes (Lumos /model, /chat and bach worksheet-editor ops) ──

export interface CreateModelSessionParams {
	// Build a NEW model on this warehouse connection.
	connectionIdentifier?: string;
	// Open an EXISTING model for editing. Wins upstream if both are given.
	modelIdentifier?: string;
}

export interface CreateModelSessionResult {
	conversation_id: string;
	transaction_id: string;
	generation_no: number;
}

export interface SendModelMessageParams {
	conversation_identifier: string;
	transaction_id: string;
	generation_no: number;
	gen_no_working_set?: number[];
	session_cookie?: string;
	message: string;
	choice?: unknown;
}

export interface SaveModelParams {
	transaction_id: string;
	generation_no: number;
	gen_no_working_set?: number[];
	name?: string;
	description?: string;
}

export interface SaveModelResult {
	model_identifier: string;
	url?: string;
}

export interface FetchWorksheetModelParams {
	session_identifier: string;
	generation_number: number;
	gen_no_working_set?: number[];
}
