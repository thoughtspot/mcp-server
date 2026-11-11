import { fetchApi } from "../../rest-utils";
import { type ClientContext, ThoughtSpotApiError } from "../../types";
import type {
	Analyst,
	AnalystConnector,
	RawAnalystItem,
	RawSearchAnalystsResponse,
	SearchAnalystsParams,
	SearchAnalystsResult,
} from "./analysts-types";

// Analysts are "spots" in convex. The public search route serves both a paginated list mode and
// a single-analyst fetch mode that enforces the caller's access (owner -> sharing -> admin).
export const SEARCH_ANALYSTS_ENDPOINT = "/convex/spots/public/search";

function toConnector(
	raw: NonNullable<RawAnalystItem["mcp_connectors"]>[number],
): AnalystConnector | null {
	if (typeof raw === "string") {
		return raw ? { id: raw } : null;
	}
	if (!raw?.id) {
		return null;
	}
	return { id: raw.id, ...(raw.name ? { name: raw.name } : {}) };
}

export function toAnalyst(raw: RawAnalystItem): Analyst {
	return {
		id: raw.id,
		name: raw.name ?? "",
		description: raw.description ?? "",
		connectors: (raw.mcp_connectors ?? [])
			.map(toConnector)
			.filter((c): c is AnalystConnector => c !== null),
	};
}

async function postSearch(
	ctx: ClientContext,
	body: Record<string, unknown>,
	operation: string,
): Promise<RawSearchAnalystsResponse> {
	const response = await fetchApi(ctx, SEARCH_ANALYSTS_ENDPOINT, {
		json: body,
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(response.status, operation, errorText);
	}
	return (await response.json()) as RawSearchAnalystsResponse;
}

/*
 * List the Analysts the caller can access (created by or shared with them).
 */
export async function searchAnalysts(
	ctx: ClientContext,
	{ recordSize, recordOffset, query, type }: SearchAnalystsParams,
): Promise<SearchAnalystsResult> {
	const data = await postSearch(
		ctx,
		{
			record_size: recordSize,
			record_offset: recordOffset,
			...(query ? { query } : {}),
			...(type ? { type } : {}),
		},
		"searchAnalysts",
	);
	return {
		analysts: (data.analysts ?? []).map(toAnalyst),
		totalSize: data.total_size ?? 0,
	};
}

/*
 * Fetch a single Analyst by id with the caller's permissions. Throws ThoughtSpotApiError with
 * status 404 when the id is unknown or malformed, and 403 when the caller lacks access.
 */
export async function getAnalyst(
	ctx: ClientContext,
	{ analystId }: { analystId: string },
): Promise<Analyst> {
	const data = await postSearch(
		ctx,
		{ analyst_identifier: analystId },
		"getAnalyst",
	);
	const raw = data.analysts?.[0];
	if (!raw) {
		throw new ThoughtSpotApiError(404, "getAnalyst", "Analyst not found");
	}
	return toAnalyst(raw);
}
