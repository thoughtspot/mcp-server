// Exported interfaces and schemas for the `search_objects` Eureka search.

export interface SearchObjectHeader {
	id: string;
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
	query: string;
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
	// Client-generated correlation id sent on the upstream call as the
	// x-request-id header and echoed back here, so the same id can be traced
	// across this server and ThoughtSpot's server-side logs.
	request_id: string;
}
