/** Ownership filter for listing Analysts (convex `SpotType`). */
export type AnalystListType = "ALL" | "CREATED_BY_ME" | "SHARED_TO_ME";

export interface AnalystConnector {
	id: string;
	name?: string;
}

/** An Analyst as returned by the MCP server: only what the host agent needs. */
export interface Analyst {
	id: string;
	name: string;
	description: string;
	connectors: AnalystConnector[];
}

export interface SearchAnalystsParams {
	recordSize: number;
	recordOffset: number;
	query?: string;
	type?: AnalystListType;
}

export interface SearchAnalystsResult {
	analysts: Analyst[];
	totalSize: number;
}

/** Raw `AnalystItem` from convex `POST /convex/spots/public/search` (subset we read). */
export interface RawAnalystItem {
	id: string;
	name?: string | null;
	description?: string | null;
	mcp_connectors?: ({ id?: string | null; name?: string | null } | string)[];
}

export interface RawSearchAnalystsResponse {
	analysts?: RawAnalystItem[];
	total_size?: number;
}
