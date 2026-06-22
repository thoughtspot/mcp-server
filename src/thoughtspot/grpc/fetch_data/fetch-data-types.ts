// Exported interfaces for the `fetch_data` tool, which retrieves the full data
// of a saved Answer or Liveboard given its GUID.

export interface FetchDataParams {
	// GUID of the object to fetch (an Answer or a Liveboard), typically taken
	// from a prior `search_objects` result.
	objectId: string;
	// When `objectId` is a Liveboard, restrict the fetch to these visualization
	// GUIDs. Omit to fetch every visualization on the Liveboard. Ignored for
	// standalone Answers.
	vizIds?: string[];
	// Upper bound on the number of rows returned per visualization. Maps to the
	// upstream `record_size`. Defaults to FETCH_DATA_DEFAULT_MAX_ROWS so an
	// unexpectedly large object cannot flood the caller's context.
	maxRows?: number;
}

// A single tabular result: one for an Answer, one per visualization for a
// Liveboard.
export interface FetchDataViz {
	// The visualization GUID. Populated for Liveboard vizzes; undefined for a
	// standalone Answer.
	viz_id?: string;
	// The visualization name. Populated for Liveboard vizzes.
	viz_name?: string;
	columns: string[];
	// Each row is an array of cell values aligned to `columns`. Cells may be
	// strings, numbers, booleans or null depending on the column type.
	data_rows: unknown[][];
	// Total rows available upstream (may exceed the rows returned when capped).
	total_row_count?: number;
	// Rows actually returned in this payload.
	row_count?: number;
	// Sampling ratio (0..1); 1 means the complete result set was returned.
	sampling_ratio?: number;
}

export interface FetchDataResult {
	id: string;
	// Display name of the object, resolved via metadata search.
	name: string;
	// The resolved object type: "ANSWER" or "LIVEBOARD".
	type: string;
	description: string;
	// One entry for an Answer; one per visualization for a Liveboard.
	data: FetchDataViz[];
	// Client-generated correlation id sent on the upstream calls as the
	// x-request-id header and echoed back here, so the same id can be traced
	// across this server and ThoughtSpot's server-side logs.
	request_id: string;
}
