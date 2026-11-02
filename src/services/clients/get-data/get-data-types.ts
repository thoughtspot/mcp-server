// Interfaces for the `get_data` tool: full data of an Answer/Liveboard GUID.

import type { GetDataObjectType } from "./get-data-constants";

export interface GetDataParams {
	// GUID of an Answer or Liveboard, typically from `search_objects`.
	objectId: string;
	// Required type from search_objects; picks the endpoint.
	objectType: GetDataObjectType;
	// Liveboards only: restrict to these viz GUIDs; omit for all vizzes.
	vizIds?: string[];
	// Row cap per viz (upstream `record_size`); defaults protect LLM context.
	maxRows?: number;
}

// One tabular result: one for an Answer, one per Liveboard visualization.
export interface GetDataViz {
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

export interface GetDataResult {
	// One entry for an Answer; one per visualization for a Liveboard.
	data: GetDataViz[];
}
