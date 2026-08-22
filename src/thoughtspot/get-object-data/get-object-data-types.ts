// Interfaces for the `get_object_data` tool: full data of an Answer/Liveboard GUID.

export interface GetObjectDataParams {
	// GUID of an Answer or Liveboard, typically from `search_objects`.
	objectId: string;
	// Required type ("ANSWER"/"LIVEBOARD") from search_objects; picks the endpoint.
	objectType: string;
	// Liveboards only: restrict to these viz GUIDs; omit for all vizzes.
	vizIds?: string[];
	// Row cap per viz (upstream `record_size`); defaults protect LLM context.
	maxRows?: number;
}

// One tabular result: one for an Answer, one per Liveboard visualization.
export interface GetObjectDataViz {
	// Viz GUID; undefined for a standalone Answer.
	viz_id?: string;
	viz_name?: string;
	columns: string[];
	// Cell values aligned to `columns`.
	data_rows: unknown[][];
	// Total rows available upstream (may exceed rows returned when capped).
	total_row_count?: number;
	// 0..1; 1 means the complete result set was returned.
	sampling_ratio?: number;
}

export interface GetObjectDataResult {
	// One entry for an Answer; one per visualization for a Liveboard.
	data: GetObjectDataViz[];
}
