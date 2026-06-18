import { searchObjectsQuery } from "./search-objects-query";
import type {
	SearchObjectHeader,
	SearchObjectsParams,
	SearchObjectsResult,
} from "./search-objects-types";

// Friendly object-type names accepted by the `types` filter, mapped to the
// OBJECT_TYPE_FACET values the Eureka backend understands.
const OBJECT_TYPE_FACET_MAP: Record<string, string> = {
	liveboard: "pinboard",
	pinboard: "pinboard",
	dashboard: "pinboard",
	answer: "answer",
	worksheet: "worksheet",
	table: "worksheet",
	model: "worksheet",
};

// Build a deep link to the object in the ThoughtSpot UI from its result type.
function buildFrameUrl(
	instanceUrl: string,
	resultType: string,
	id: string,
	parentId?: string,
): string {
	const base = instanceUrl.replace(/\/$/, "");
	switch (resultType) {
		case "PINBOARD_VIZ_RESULT":
			return `${base}/#/insights/pinboard/${parentId ?? id}/${id}`;
		case "ANSWER_RESULT":
			return `${base}/#/saved-answer/${id}`;
		case "WORKSHEET_RESULT":
			return `${base}/#/data/tables/${id}`;
		default:
			return `${base}/#/insights/pinboard//${id}`;
	}
}

// Derive a human-readable match reason from the Eureka snippet metadata.
function deriveMatchReason(snippetInfo: any): string {
	if (snippetInfo?.titleSnippet?.highlights?.length) {
		return "Matched in title";
	}
	if (snippetInfo?.descriptionSnippet?.highlights?.length) {
		return "Matched in description";
	}
	const tokens = (snippetInfo?.sageQuerySnippet?.token ?? [])
		.map((t: any) => t?.token)
		.filter(Boolean);
	if (tokens.length) {
		return `Matched query terms: ${tokens.join(", ")}`;
	}
	return "Matched search term";
}

/*
 * Using custom handler because we don't have a public API for full-text object search.
 * This mirrors the Eureka search used by the ThoughtSpot UI search bar.
 */
export function addSearchObjects(
	client: any,
	instanceUrl: string,
	token: string,
) {
	(client as any).searchObjects = async ({
		query,
		types,
		owner,
		tag,
		modifiedSince,
		verifiedOnly,
		limit = 10,
		cursor,
	}: SearchObjectsParams): Promise<SearchObjectsResult> => {
		const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;

		// Filters the Eureka backend can apply server-side via facetSelections.
		const facetSelections: { facetType: string; facetValue: string[] }[] = [];
		if (types?.length) {
			const facetValue = [
				...new Set(
					types.map(
						(t) => OBJECT_TYPE_FACET_MAP[t.toLowerCase()] ?? t.toLowerCase(),
					),
				),
			];
			facetSelections.push({ facetType: "OBJECT_TYPE_FACET", facetValue });
		}
		if (verifiedOnly) {
			facetSelections.push({ facetType: "IS_VERIFIED", facetValue: ["true"] });
		}

		// Correlation id we mint per call and send as x-request-id. ThoughtSpot
		// does not return this — it generates its own — so we generate and echo it
		// back to enable cross-system tracing.
		const requestId = globalThis.crypto.randomUUID();

		const endpoint = "/prism/?op=GetEurekaResults";
		const fetchOptions = {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				// The Eureka backend derives the request locale from this header.
				// Without it the server falls back to "*" and 500s with
				// "IllegalArgumentException: Invalid locale format: *".
				"accept-language": "en-US",
				"x-request-id": requestId,
				"user-agent": "ThoughtSpot-ts-client",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				operationName: "GetEurekaResults",
				query: searchObjectsQuery,
				variables: {
					params: {
						batchSize: limit,
						// Request the STICKERS facet so tag ids on each result can be
						// resolved to human-readable tag names.
						desiredFacets: [{ facetType: "STICKERS", facetValue: [] }],
						facetSelections,
						maxPinboardVizCount: 5,
						filterSelections: [],
						offset,
						query,
						removeDuplicates: true,
						sortBy: [],
						currentPageNumber: Math.floor(offset / limit) + 1,
						searchOption: "SEARCH_RESULTS",
					},
				},
			}),
		};
		const response = await fetch(`${instanceUrl}${endpoint}`, fetchOptions);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`searchObjects failed with status ${response.status}: ${errorText}`,
			);
		}

		const data = (await response.json()) as any;

		// The Eureka endpoint returns HTTP 200 even on query-level failures,
		// reporting them in a top-level `errors` array (with `data` null) or in
		// `queryRequest.errorCode`. Without this check those surface as an empty
		// result set and get reported as a successful "0 objects found".
		const graphqlError = data?.errors?.[0]?.message;
		const errorCode = data?.data?.queryRequest?.errorCode;
		if (graphqlError || errorCode) {
			throw new Error(
				`searchObjects failed: ${graphqlError ?? `errorCode ${errorCode}`}`,
			);
		}

		const queryRequest = data?.data?.queryRequest ?? {};
		const results = queryRequest.results ?? [];

		// Build a sticker id -> name map so tagIds can be surfaced as tag names.
		const stickerNames: Record<string, string> = {};
		for (const facet of queryRequest.facets ?? []) {
			if (facet?.facetType === "STICKERS") {
				for (const value of facet.facetValues ?? []) {
					if (value?.id) {
						stickerNames[value.id] = value.name ?? value.id;
					}
				}
			}
		}

		let objects: SearchObjectHeader[] = results
			.map((result: any): SearchObjectHeader | null => {
				// Each result carries every sub-object (searchAnswer, searchPinboard,
				// searchWorksheet, searchPinboardViz) but only the one matching
				// resultType is populated; the rest are placeholders with an empty
				// header id. Pick the first header that actually has an id.
				const candidates = [
					result?.searchAnswer?.header,
					result?.searchPinboard?.header,
					result?.searchWorksheet?.header,
					result?.searchPinboardViz?.answer?.header,
					result?.searchPinboardViz?.pinboardHeader,
				];
				const header = candidates.find((h) => h?.id);
				// Prefer the object's own header id. objectSecurityInfo.objectId
				// points at the containing liveboard for viz results, which would
				// make every viz in a liveboard collapse to the same id — so it is
				// only a fallback for objects that expose no populated header.
				const id = header?.id ?? result?.objectSecurityInfo?.objectId;
				if (!id) {
					return null;
				}
				const tags = (header?.tagIds ?? []).map(
					(tagId: string) => stickerNames[tagId] ?? tagId,
				);
				return {
					id,
					name: header?.title ?? "",
					type:
						result?.objectSecurityInfo?.objectType ?? result?.resultType ?? "",
					owner: header?.authorName ?? "",
					description: header?.description ?? "",
					tags,
					last_modified: header?.modifiedOn,
					// Eureka search does not expose a per-user last-viewed timestamp.
					last_viewed: null,
					verified: header?.isVerified ?? false,
					frame_url: buildFrameUrl(
						instanceUrl,
						result?.resultType ?? "",
						id,
						result?.objectSecurityInfo?.objectId,
					),
					match_reason: deriveMatchReason(result?.snippetInfo),
					confidence: result?.score,
				};
			})
			.filter(
				(obj: SearchObjectHeader | null): obj is SearchObjectHeader =>
					obj !== null,
			);

		// owner, tag and modified_since are not reliably expressible through the
		// Eureka request schema, so they are applied to the returned page here.
		if (owner) {
			const needle = owner.toLowerCase();
			objects = objects.filter((o) => o.owner.toLowerCase().includes(needle));
		}
		if (tag) {
			const needle = tag.toLowerCase();
			objects = objects.filter((o) =>
				o.tags.some((t) => t.toLowerCase().includes(needle)),
			);
		}
		if (modifiedSince) {
			objects = objects.filter((o) => (o.last_modified ?? 0) >= modifiedSince);
		}

		// A full page of raw results implies there may be more to fetch.
		const next_cursor =
			results.length === limit ? String(offset + limit) : null;

		return {
			objects,
			next_cursor,
			request_id: requestId,
		};
	};
}
