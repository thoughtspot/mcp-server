// Exported interfaces and schemas for the `search_objects` Eureka search.

export interface SearchObjectHeader {
	id: string;
	// Present only for a visualization pinned on a Liveboard: `id` is the parent
	// Liveboard, this is the viz to pass as fetch_data `visualization_ids`.
	visualization_id?: string;
	name: string;
	type: string;
	owner: string;
	description: string;
	tags: string[];
	last_modified?: number;
	last_viewed?: number | null;
	verified: boolean;
	frame_url: string;
	match_reason: string;
	confidence?: number;
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

export interface SearchObjectsResult {
	objects: SearchObjectHeader[];
	next_cursor: string | null;
	// Client-minted x-request-id, echoed for cross-system tracing.
	request_id: string;
}
