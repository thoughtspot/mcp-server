// Exported interfaces and schemas for the `search_objects` Eureka search.

// Internal working shape while a page is fetched, filtered and paginated.
// `last_modified` stays epoch-ms here so the `modified_since` filter can compare
// it numerically; it is converted to ISO-8601 only in the final output.
export interface SearchObjectHeader {
	id: string;
	// Present only for a visualization pinned on a Liveboard: `id` is the parent
	// Liveboard, this is the viz to pass as fetch_data `visualization_ids`.
	visualization_id?: string;
	name: string;
	type: string;
	owner: string;
	description: string | null;
	tags: string[];
	last_modified?: number;
	verified: boolean;
	frame_url: string;
	// Sage/TML tokens for Answers/vizzes; null for Liveboards (spec rule).
	query: string | null;
	confidence: number;
}

// Spec-shaped result item surfaced to the client (Slack contract 2026-07-09).
export interface SearchObjectResult {
	id: string;
	visualization_id?: string;
	name: string;
	// UPPER-case enum: LIVEBOARD | ANSWER | WORKSHEET (viz collapses to LIVEBOARD).
	type: string;
	owner: string;
	description: string | null;
	tags: string[];
	// ISO-8601, or null when the backend exposes no modification time.
	last_modified: string | null;
	verified: boolean;
	frame_url: string;
	query: string | null;
	confidence: number;
}

export interface SearchObjectsParams {
	// A single search term, or several terms to search in parallel and merge.
	query: string | string[];
	types?: string[];
	owner?: string;
	tag?: string;
	modifiedSince?: number;
	verifiedOnly?: boolean;
	limit?: number;
	cursor?: string;
}

// Internal accumulator returned by the per-term search before projection.
export interface RawSearchResult {
	objects: SearchObjectHeader[];
	next_cursor: string | null;
	// Client-minted x-request-id, echoed for cross-system tracing.
	request_id: string;
}

// Final spec-shaped success payload (no `status` field, per the spec).
export interface SearchObjectsResult {
	results: SearchObjectResult[];
	next_cursor: string | null;
	request_id: string;
}

// Typed error codes for the error envelope (Slack contract 2026-07-09).
export type SearchErrorCode =
	| "INVALID_ARGUMENT"
	| "UNAUTHORIZED"
	| "RATE_LIMITED"
	| "UPSTREAM_TIMEOUT"
	| "INTERNAL";

// Query ran, nothing matched — not an error.
export interface SearchObjectsNoResults {
	status: "no_results";
	results: SearchObjectResult[];
	message: string;
	next_cursor: null;
	request_id: string;
}

// Couldn't return data.
export interface SearchObjectsError {
	status: "error";
	results: SearchObjectResult[];
	error: {
		code: SearchErrorCode;
		message: string;
		retryable: boolean;
	};
	request_id: string;
}

// The three scenarios the handler can return.
export type SearchObjectsResponse =
	| SearchObjectsResult
	| SearchObjectsNoResults
	| SearchObjectsError;
