import { fetchApi } from "../../rest-utils";
import { type ClientContext, ThoughtSpotApiError } from "../../types";
import type {
	Analyst,
	RawAnalystItem,
	RawSearchAnalystsResponse,
	SearchAnalystsParams,
	SearchAnalystsResult,
} from "./analysts-types";

// Analysts are "spots" in convex. The public search route lists the Analysts the caller can
// access (created by or shared with them), paginated by record_size / record_offset.
export const SEARCH_ANALYSTS_ENDPOINT = "/convex/spots/public/search";

export function toAnalyst(raw: RawAnalystItem): Analyst {
	return {
		id: raw.id,
		name: raw.name ?? "",
		description: raw.description ?? "",
	};
}

/**
 * List the Analysts the caller can access. Throws ThoughtSpotApiError on a non-2xx response.
 */
export async function searchAnalysts(
	ctx: ClientContext,
	{ recordSize, recordOffset, query, type }: SearchAnalystsParams,
): Promise<SearchAnalystsResult> {
	const response = await fetchApi(ctx, SEARCH_ANALYSTS_ENDPOINT, {
		json: {
			record_size: recordSize,
			record_offset: recordOffset,
			...(query ? { query } : {}),
			...(type ? { type } : {}),
		},
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new ThoughtSpotApiError(response.status, "searchAnalysts", errorText);
	}
	const data = (await response.json()) as RawSearchAnalystsResponse;
	return {
		analysts: (data.analysts ?? []).map(toAnalyst),
		totalSize: data.total_size ?? 0,
	};
}
