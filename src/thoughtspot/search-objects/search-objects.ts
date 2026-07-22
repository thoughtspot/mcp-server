import {
	resolveObjectTypeFacets,
	resolveResultTypeToCanonical,
} from "../object-types";
import { buildHeaders, generateRequestId, postJson } from "../rest-utils";
import { searchObjectsQuery } from "./search-objects-query";
import type {
	RawSearchResult,
	SearchErrorCode,
	SearchObjectHeader,
	SearchObjectResult,
	SearchObjectsError,
	SearchObjectsParams,
	SearchObjectsResponse,
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
		case "LOGICAL_TABLE_RESULT":
			return `${base}/#/data/tables/${id}`;
		default:
			return `${base}/#/insights/pinboard/${id}`;
	}
}

// Eureka may report modifiedOn in seconds; normalize to epoch-ms so it matches
// the epoch-ms `modified_since` filter and the documented output unit.
function toEpochMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}
	return value < 1e12 ? Math.round(value * 1000) : value;
}

// Sage/TML tokens only carry meaning for Answers and vizzes; Liveboards report
// a bare GUID here, which the spec maps to null.
function deriveQuery(resultType: string, sageQuery: unknown): string | null {
	if (resultType !== "ANSWER_RESULT" && resultType !== "PINBOARD_VIZ_RESULT") {
		return null;
	}
	return typeof sageQuery === "string" && sageQuery.trim() ? sageQuery : null;
}

// Project the internal working header to the spec-shaped result item:
// UPPER-case type, ISO-8601 last_modified, drop internal-only fields.
function toResult(header: SearchObjectHeader): SearchObjectResult {
	return {
		object_id: header.id,
		...(header.visualization_id
			? { visualization_id: header.visualization_id }
			: {}),
		title: header.name,
		// Emit as an UPPER_SNAKE token, e.g. "Liveboard viz" -> "LIVEBOARD_VIZ".
		type: header.type.toUpperCase().replace(/\s+/g, "_"),
		author_name: header.owner,
		description: header.description,
		tags: header.tags,
		last_modified:
			header.last_modified != null
				? new Date(header.last_modified).toISOString()
				: null,
		verified: header.verified,
		frame_url: header.frame_url,
		query: header.query,
		confidence: header.confidence,
	};
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
			totalResults?: number;
		}> => {
			const data = (await postJson(
				`${instanceUrl}${endpoint}`,
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
				.map((result: any): SearchObjectHeader | null => {
					const resultType: string = result?.resultType ?? "";

					// Eureka returns ALL sub-objects on every result; only the one
					// matching resultType is populated (the rest are empty stubs with
					// id/title ""). So dispatch strictly on resultType, never on which
					// sub-object is "present".
					let id: string | undefined;
					let visualizationId: string | undefined;
					let header: any;
					if (resultType === "PINBOARD_VIZ_RESULT") {
						// A pinboard-viz hit is fetched via its parent Liveboard, so
						// surface the Liveboard as `id` (fetch_data resolves it) and the
						// viz id separately.
						const viz = result?.searchPinboardViz;
						header = viz?.answer?.header;
						id =
							viz?.pinboardHeader?.id || result?.objectSecurityInfo?.objectId;
						visualizationId = viz?.answer?.header?.id || undefined;
					} else if (resultType === "PINBOARD_RESULT") {
						header = result?.searchPinboard?.header;
						id = header?.id || result?.objectSecurityInfo?.objectId;
					} else if (resultType === "ANSWER_RESULT") {
						header = result?.searchAnswer?.header;
						id = header?.id || result?.objectSecurityInfo?.objectId;
					} else if (
						resultType === "WORKSHEET_RESULT" ||
						resultType === "LOGICAL_TABLE_RESULT"
					) {
						header = result?.searchWorksheet?.header;
						id = header?.id || result?.objectSecurityInfo?.objectId;
					} else {
						// Unknown kind: take whichever sub-header actually carries an id.
						header =
							result?.searchAnswer?.header ??
							result?.searchPinboard?.header ??
							result?.searchWorksheet?.header;
						id = header?.id || result?.objectSecurityInfo?.objectId;
					}
					// Empty-string ids are stubs, not real ids — drop them.
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
						visualization_id: visualizationId,
						name: header?.title ?? "",
						// Canonical type so it round-trips as a `types` filter; raw
						// backend type is the fallback for unrecognized kinds.
						type:
							resolveResultTypeToCanonical(resultType) ??
							result?.objectSecurityInfo?.objectType ??
							resultType,
						owner: header?.authorName ?? "",
						description: header?.description || null,
						tags,
						last_modified: toEpochMs(header?.modifiedOn),
						verified: header?.isVerified ?? false,
						frame_url: buildFrameUrl(
							instanceUrl,
							resultType,
							visualizationId ?? id,
							id,
						),
						query: deriveQuery(resultType, result?.sageQuery),
						// TODO: raw Eureka relevance score; normalization to 0–1 pending.
						confidence: result?.score ?? 0,
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

		// Minted once for the whole call so it survives a failure (the error
		// envelope must still carry a request_id).
		const requestId = generateRequestId();

		const term = params.query.trim();

		// Guard empty/whitespace-only input rather than searching upstream for "".
		if (!term) {
			return buildError(
				"INVALID_ARGUMENT",
				"Provide a non-empty search term.",
				false,
				requestId,
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
					message: `No objects matched ${JSON.stringify(term)}.`,
					next_cursor: null,
					request_id: requestId,
				};
			}

			// Project the internal headers to the spec-shaped success payload.
			return {
				results,
				next_cursor: raw.next_cursor,
				request_id: requestId,
			};
		} catch (error) {
			return classifySearchError(error, requestId);
		}
	};
}

// Map a thrown search failure to the typed error envelope. Codes are derived
// from the upstream HTTP status (postJson embeds "status <N>") or the message;
// `message` is a friendly, safe string — trace specifics via `request_id`.
function classifySearchError(
	error: unknown,
	requestId: string,
): SearchObjectsError {
	const raw = error instanceof Error ? error.message : String(error);
	const status = Number(raw.match(/status (\d{3})/)?.[1]);

	if (status === 401 || status === 403) {
		return buildError(
			"UNAUTHORIZED",
			"Not authorized to search ThoughtSpot. Check your session or token.",
			false,
			requestId,
		);
	}
	if (status === 429) {
		return buildError(
			"RATE_LIMITED",
			"ThoughtSpot rate limit reached. Try again shortly.",
			true,
			requestId,
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
			requestId,
		);
	}
	if (status >= 500) {
		return buildError(
			"INTERNAL",
			"ThoughtSpot hit an error while searching. Try again shortly.",
			true,
			requestId,
		);
	}
	// GraphQL/query-level failures and everything else: not transient.
	return buildError(
		"INTERNAL",
		"ThoughtSpot could not complete the search.",
		false,
		requestId,
	);
}

// Assemble an error envelope.
function buildError(
	code: SearchErrorCode,
	message: string,
	retryable: boolean,
	requestId: string,
): SearchObjectsError {
	return {
		status: "error",
		results: [],
		error: { code, message, retryable },
		request_id: requestId,
	};
}
