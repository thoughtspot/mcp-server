import { resolveObjectTypeFacets } from "../object-types";
import { buildHeaders, generateRequestId, postJson } from "../rest-utils";
import { toHeader, toResult } from "./search-objects-mapper";
import { searchObjectsQuery } from "./search-objects-query";
import type {
	RawSearchResult,
	SearchErrorCode,
	SearchObjectHeader,
	SearchObjectsError,
	SearchObjectsParams,
	SearchObjectsResponse,
} from "./search-objects-types";

// Custom handler: no public API for full-text object search; mirrors the UI's
// Eureka search.
export function addSearchObjects(
	client: any,
	instanceUrl: string,
	token: string,
) {
	(client as any).searchObjects = async (
		params: SearchObjectsParams,
	): Promise<SearchObjectsResponse> => {
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

		// Server-side facet filters. OBJECT_TYPE is the filterable facet (the
		// facet the UI's facetSelections uses); OBJECT_TYPE_FACET is only a
		// computed/returned facet, not a filter.
		const facetSelections: { facetType: string; facetValue: string[] }[] = [];
		if (types?.length) {
			facetSelections.push({
				facetType: "OBJECT_TYPE",
				facetValue: resolveObjectTypeFacets(types),
			});
		}
		if (verifiedOnly) {
			facetSelections.push({ facetType: "IS_VERIFIED", facetValue: ["true"] });
		}

		// Fetch and map one raw page for a term, applying the post-filters.
		const fetchPage = async (
			query: string,
			requestId: string,
			pageOffset: number,
		): Promise<{
			pageObjects: SearchObjectHeader[];
			rawCount: number;
			isFinalPage?: boolean;
			totalResults?: number;
		}> => {
			const data = (await postJson(
				`${instanceUrl}/prism/?op=GetEurekaResults`,
				buildHeaders(token, undefined, undefined, {
					requestId,
					acceptLanguage: "en-US",
				}),
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
							// Offset-derived; page number is advisory telemetry.
							currentPageNumber: Math.floor(pageOffset / limit) + 1,
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
				.map((result: any) => toHeader(result, instanceUrl, stickerNames))
				.filter(
					(obj: SearchObjectHeader | null): obj is SearchObjectHeader =>
						obj !== null,
				);

			if (owner) {
				const ownerLower = owner.toLowerCase();
				pageObjects = pageObjects.filter((o) =>
					o.owner.toLowerCase().includes(ownerLower),
				);
			}
			if (tag) {
				const tagLower = tag.toLowerCase();
				pageObjects = pageObjects.filter((o) =>
					o.tags.some((t) => t.toLowerCase().includes(tagLower)),
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
				// Backend end-of-results signals; may be absent on older clusters.
				isFinalPage:
					typeof queryRequest.isFinalPage === "boolean"
						? queryRequest.isFinalPage
						: undefined,
				totalResults:
					typeof queryRequest.totalResults === "number"
						? queryRequest.totalResults
						: undefined,
			};
		};

		// Full search for the term; the x-request-id is passed in so it is
		// preserved even when the call later fails.
		const runSearch = async (
			query: string,
			requestId: string,
			cursor?: string,
		): Promise<RawSearchResult> => {
			// Clamp: LLM callers do fabricate negative cursors.
			const rawOffset = Math.max(
				0,
				cursor ? Number.parseInt(cursor, 10) || 0 : 0,
			);
			// Honor the cursor's absolute offset; snapping to the current limit could
			// move it backwards if the caller changed `limit` between pages.
			const startOffset = rawOffset;

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
				// Authoritative signals first (isFinalPage, then totalResults);
				// rawCount === limit is only a last resort because removeDuplicates
				// can shrink a page below limit while more results remain.
				pageOffset += limit;
				if (page.isFinalPage !== undefined) {
					hasMorePages = !page.isFinalPage;
				} else if (page.totalResults !== undefined) {
					hasMorePages = pageOffset < page.totalResults;
				} else {
					hasMorePages = page.rawCount === limit;
				}
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
			};
		};

		// Minted once and sent upstream as x-request-id for server-side tracing.
		const requestId = generateRequestId();

		const term = params.query.trim();

		// Guard empty/whitespace-only input rather than searching upstream for "".
		if (!term) {
			return buildError(
				"INVALID_ARGUMENT",
				"Provide a non-empty search term.",
				false,
			);
		}

		try {
			const raw = await runSearch(term, requestId, params.cursor);

			const results = raw.objects.map(toResult);

			// Query ran but matched nothing — a distinct scenario, not an error.
			if (results.length === 0) {
				return {
					status: "no_results",
					results: [],
					next_cursor: null,
				};
			}

			// Project the internal headers to the spec-shaped success payload.
			return {
				results,
				next_cursor: raw.next_cursor,
			};
		} catch (error) {
			return classifySearchError(error);
		}
	};
}

// Map a thrown search failure to the typed error envelope. Codes are derived
// from the upstream HTTP status (postJson embeds "status <N>") or the message;
// `message` is a friendly, safe string.
function classifySearchError(error: unknown): SearchObjectsError {
	const raw = error instanceof Error ? error.message : String(error);
	const status = Number(raw.match(/status (\d{3})/)?.[1]);

	if (status === 401 || status === 403) {
		return buildError(
			"UNAUTHORIZED",
			"Not authorized to search ThoughtSpot. Check your session or token.",
			false,
		);
	}
	if (status === 429) {
		return buildError(
			"RATE_LIMITED",
			"ThoughtSpot rate limit reached. Try again shortly.",
			true,
		);
	}
	if (
		status === 408 ||
		status === 502 ||
		status === 503 ||
		status === 504 ||
		/tim(e|ed)[ -]?out/i.test(raw)
	) {
		return buildError(
			"UPSTREAM_TIMEOUT",
			"ThoughtSpot took too long to respond. Try again shortly.",
			true,
		);
	}
	if (status >= 500) {
		return buildError(
			"INTERNAL",
			"ThoughtSpot hit an error while searching. Try again shortly.",
			true,
		);
	}
	// GraphQL/query-level failures and everything else: not transient.
	return buildError(
		"INTERNAL",
		"ThoughtSpot could not complete the search.",
		false,
	);
}

// Assemble an error envelope.
function buildError(
	code: SearchErrorCode,
	message: string,
	retryable: boolean,
): SearchObjectsError {
	return {
		status: "error",
		results: [],
		error: { code, message, retryable },
	};
}
