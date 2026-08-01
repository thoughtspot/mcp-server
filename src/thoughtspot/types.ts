export interface DataSource {
	name: string;
	id: string;
	description: string;
}

// Error from a ThoughtSpot HTTP call, carrying the numeric status so callers can
// branch on it (e.g. 401/403 = no access) instead of parsing message strings.
// The response body is kept off `message` so it can't leak into logs/responses.
export class ThoughtSpotApiError extends Error {
	constructor(
		readonly status: number,
		operation: string,
		readonly body?: string,
	) {
		super(`${operation} failed with status ${status}`);
		this.name = "ThoughtSpotApiError";
	}
}

export interface DataSourceSuggestion {
	confidence: number;
	header: {
		description: string;
		displayName: string;
		guid: string;
	};
	llmReasoning: string;
}

export interface DataSourceSuggestionResponse {
	dataSources: DataSourceSuggestion[];
}

export interface Org {
	id: number;
	name: string;
	description?: string;
}

export interface SessionInfo {
	mixpanelToken: string;
	userGUID: string;
	userName: string;
	clusterName: string;
	clusterId: string;
	releaseVersion: string;
	currentOrgId: string;
	privileges: any;
	isSpotterDataSourceDiscoveryEnabled?: boolean;
	orgsEnabled?: boolean;
	isSpotterChatHistoryEnabled?: boolean;
}

export enum SpotterResponseFormat {
	SIMPLIFIED = "SIMPLIFIED",
	RAW = "RAW",
}

export interface BaseMessage {
	is_thinking: boolean;
}

export interface TextMessage extends BaseMessage {
	type: "text" | "text_chunk" | "step_notification";
	text: string;
}

export interface AnswerMessage extends BaseMessage {
	type: "answer";
	answer_id: string;
	answer_title: string;
	answer_data_source_id: string;
	answer_query: string;
	iframe_url: string;
}

export type Message = TextMessage | AnswerMessage;

// In raw mode, upstream events are passed through unmodified instead of being reshaped into a
// `Message`, so their shape is not guaranteed to match `Message` at all.
export type RawMessage = Record<string, unknown>;

export interface StreamingMessagesState {
	messages: (Message | RawMessage)[];
	isDone: boolean;
}

/**
 * Persisted *scalar* state for a Spotter model session, stored as a single blob in the
 * ConversationStorageServerSQLite Durable Object so it survives isolate restarts. The streamed
 * updates are NOT here — they use a separate write/read-bookmark store (see ModelUpdatesState) so
 * the background stream consumer and the reader never clobber each other on a shared blob.
 */
export interface ModelSessionState {
	transactionId: string;
	generationNo: number;
	// Every edit generation the server has reported for this session (the initial/baseline
	// generation from chat/init is excluded). Sent as genNoWorkingSet on the bach SAVE_WORKSHEET
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
export type ModelUpdate = Record<string, unknown>;

// The result of reading the not-yet-consumed model updates for a session. Mirrors
// StreamingMessagesState: `updates` are those appended since the reader's last call, and `isDone`
// flips true once the background stream consumer has finished the current turn.
export interface ModelUpdatesState {
	updates: ModelUpdate[];
	isDone: boolean;
}

export interface Answer {
	title: string;
	session_identifier: string;
	generation_number: number;
}
