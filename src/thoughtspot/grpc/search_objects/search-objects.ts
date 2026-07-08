import { resolveObjectTypeFacets } from "../../terminology";
import { buildTsHeaders, generateRequestId, postJson } from "../grpc-utils";
import { searchObjectsQuery } from "./search-objects-query";
import type {
	SearchObjectHeader,
	SearchObjectsParams,
	SearchObjectsResult,
} from "./search-objects-types";

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
		case "LOGICAL_TABLE_RESULT":
			return `${base}/#/data/tables/${id}`;
		default:
			return `${base}/#/insights/pinboard/${id}`;
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
	// Eureka may return sageQuerySnippet as an object or a list; token likewise.
	const sage = snippetInfo?.sageQuerySnippet;
	const sageEntries = Array.isArray(sage) ? sage : sage ? [sage] : [];
	const tokens = sageEntries
		.flatMap((entry: any) =>
			Array.isArray(entry?.token)
				? entry.token
				: entry?.token
					? [entry.token]
					: [],
		)
		.map((t: any) => t?.token)
		.filter(Boolean);
	if (tokens.length) {
		return `Matched query terms: ${tokens.join(", ")}`;
	}
	return "Matched search term";
}

// Custom handler: no public API for full-text object search; mirrors the UI's
// Eureka search.
export function addSearchObjects(
	client: any,
	instanceUrl: string,
	token: string,
) {
	(client as any).searchObjects = async (
		params: SearchObjectsParams,
	): Promise<SearchObjectsResult> => {
		const {
			types,
			owner,
			tag,
			modifiedSince,
			verifiedOnly,
			limit = 10,
		} = params;

		// Not expressible in the Eureka schema; applied per fetched page below.
		const hasPostFilters = Boolean(owner || tag || modifiedSince);

		// Server-side facet filters, shared across all terms.
		const facetSelections: { facetType: string; facetValue: string[] }[] = [];
		if (types?.length) {
			facetSelections.push({
				facetType: "OBJECT_TYPE_FACET",
				facetValue: resolveObjectTypeFacets(types),
			});
		}
		if (verifiedOnly) {
			facetSelections.push({ facetType: "IS_VERIFIED", facetValue: ["true"] });
		}

		const endpoint = "/prism/?op=GetEurekaResults";

		// Fetch and map one raw page for a term, applying the post-filters.
		const fetchPage = async (
			query: string,
			requestId: string,
			pageOffset: number,
		): Promise<{
			pageObjects: SearchObjectHeader[];
			rawCount: number;
			isFinalPage?: boolean;
		}> => {
			const data = (await postJson(
				`${instanceUrl}${endpoint}`,
				buildTsHeaders(token, { requestId }),
				{
					operationName: "GetEurekaResults",
					query: searchObjectsQuery,
					variables: {
						params: {
							batchSize: limit,
							// STICKERS facet lets tag ids resolve to names.
							desiredFacets: [{ facetType: "STICKERS", facetValue: [] }],
							facetSelections,
							maxPinboardVizCount: 5,
							filterSelections: [],
							offset: pageOffset,
							query,
							removeDuplicates: true,
							sortBy: [],
							// pageOffset is always a multiple of limit, so this is exact.
							currentPageNumber: pageOffset / limit + 1,
							searchOption: "SEARCH_RESULTS",
						},
					},
				},
				"searchObjects failed",
			)) as any;

			// Eureka returns HTTP 200 on query-level failures; without this check
			// they surface as a successful "0 objects found".
			const hasGraphqlErrors = Boolean(data?.errors?.length);
			const errorCode = data?.data?.queryRequest?.errorCode;
			if (hasGraphqlErrors || errorCode) {
				const graphqlError = data?.errors?.[0]?.message;
				throw new Error(
					`searchObjects failed: ${
						graphqlError ??
						(errorCode ? `errorCode ${errorCode}` : "unknown GraphQL error")
					}`,
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

			let pageObjects: SearchObjectHeader[] = results
				.map((result: any): SearchObjectHeader | null => {
					// Only the sub-object matching resultType has a populated header id.
					const candidates = [
						result?.searchAnswer?.header,
						result?.searchPinboard?.header,
						result?.searchWorksheet?.header,
						result?.searchPinboardViz?.answer?.header,
						result?.searchPinboardViz?.pinboardHeader,
					];
					const header = candidates.find((h) => h?.id);
					// objectSecurityInfo.objectId is the containing liveboard for viz
					// results, so it is only a fallback.
					const id = header?.id ?? result?.objectSecurityInfo?.objectId;
					if (!id) {
						return null;
					}
					// Falls back to the raw id when the STICKERS facet carries no name;
					// a `tag` filter then can't match by name (rare, cluster-dependent).
					const tags = (header?.tagIds ?? []).map(
						(tagId: string) => stickerNames[tagId] ?? tagId,
					);
					return {
						id,
						name: header?.title ?? "",
						type:
							result?.objectSecurityInfo?.objectType ??
							result?.resultType ??
							"",
						owner: header?.authorName ?? "",
						description: header?.description ?? "",
						tags,
						last_modified: header?.modifiedOn,
						// Eureka exposes no per-user last-viewed timestamp.
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

			if (owner) {
				const needle = owner.toLowerCase();
				pageObjects = pageObjects.filter((o) =>
					o.owner.toLowerCase().includes(needle),
				);
			}
			if (tag) {
				const needle = tag.toLowerCase();
				pageObjects = pageObjects.filter((o) =>
					o.tags.some((t) => t.toLowerCase().includes(needle)),
				);
			}
			if (modifiedSince) {
				pageObjects = pageObjects.filter(
					(o) => (o.last_modified ?? 0) >= modifiedSince,
				);
			}

			return {
				pageObjects,
				rawCount: results.length,
				// Backend end-of-results signal; may be absent on older clusters.
				isFinalPage:
					typeof queryRequest.isFinalPage === "boolean"
						? queryRequest.isFinalPage
						: undefined,
			};
		};

		// Full search for one term; each term mints its own x-request-id.
		const searchSingle = async (
			query: string,
			cursor?: string,
		): Promise<SearchObjectsResult> => {
			// Clamp: LLM callers do fabricate negative cursors.
			const rawOffset = Math.max(
				0,
				cursor ? Number.parseInt(cursor, 10) || 0 : 0,
			);
			// Snap to a page boundary so offset and currentPageNumber never disagree.
			const startOffset = Math.floor(rawOffset / limit) * limit;

			// Minted per call, sent as x-request-id for cross-system tracing.
			const requestId = generateRequestId();

			// Accumulate pages so post-filters can't return a short page while
			// matches remain; the page cap bounds upstream calls.
			const MAX_PAGES = 20;
			let objects: SearchObjectHeader[] = [];
			let pageOffset = startOffset;
			let hasMorePages = false;
			let pages = 0;
			do {
				const page = await fetchPage(query, requestId, pageOffset);
				objects.push(...page.pageObjects);
				// Prefer isFinalPage; fall back to the full-page heuristic.
				hasMorePages =
					page.isFinalPage !== undefined
						? !page.isFinalPage
						: page.rawCount === limit;
				pageOffset += limit;
				pages += 1;
			} while (
				hasPostFilters &&
				objects.length < limit &&
				hasMorePages &&
				pages < MAX_PAGES
			);

			if (hasPostFilters && objects.length < limit && hasMorePages) {
				console.warn(
					`searchObjects: stopped after ${MAX_PAGES} pages with ${objects.length}/${limit} matches; more may exist (continue via next_cursor).`,
				);
			}

			// Enforce limit; on overshoot point the cursor back at the dropped
			// matches' page (duplicates possible, skips never).
			let next_cursor = hasMorePages ? String(pageOffset) : null;
			if (objects.length > limit) {
				objects = objects.slice(0, limit);
				next_cursor = String(pageOffset - limit);
			}

			return {
				objects,
				next_cursor,
				request_id: requestId,
			};
		};

		// Normalize into distinct, non-empty terms (string or array input).
		const rawTerms = Array.isArray(params.query)
			? params.query
			: [params.query];
		const terms = [...new Set(rawTerms.map((t) => t.trim()).filter(Boolean))];

		// Guard empty/whitespace-only input rather than searching upstream for "".
		if (terms.length === 0) {
			throw new Error("searchObjects requires a non-empty query");
		}

		// Single term: full behavior, including cursor-based pagination.
		if (terms.length === 1) {
			return searchSingle(terms[0], params.cursor);
		}

		// Multiple terms: one search per term in parallel, merged; a multi-term
		// fan-out has no cursor.
		const perTerm = await Promise.all(terms.map((term) => searchSingle(term)));
		return mergeTermResults(perTerm, limit);
	};
}

// Dedupe by id (highest confidence wins), sort by confidence, cap at limit,
// join the per-term request ids.
function mergeTermResults(
	results: SearchObjectsResult[],
	limit: number,
): SearchObjectsResult {
	const byId = new Map<string, SearchObjectHeader>();
	for (const result of results) {
		for (const obj of result.objects) {
			const existing = byId.get(obj.id);
			if (!existing || (obj.confidence ?? 0) > (existing.confidence ?? 0)) {
				byId.set(obj.id, obj);
			}
		}
	}

	const objects = [...byId.values()]
		.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
		.slice(0, limit);

	return {
		objects,
		// Pagination across multiple independent term searches is ambiguous.
		next_cursor: null,
		request_id: results.map((r) => r.request_id).join(","),
	};
}
