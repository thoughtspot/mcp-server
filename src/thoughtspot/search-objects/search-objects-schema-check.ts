// Init-time drift guard for the search_objects tool. The GetEurekaResults query
// lives in search-objects-query.ts as a hand-maintained copy with no shared
// source of truth, so this fires it once against the live gateway to catch a
// schema mismatch without needing a schema registry.

import { buildHeaders, generateRequestId } from "../rest-utils";
import {
	MAX_PINBOARD_VIZ_COUNT,
	SCHEMA_CHECK_TIMEOUT_MS,
} from "./search-objects-constants";
import { searchObjectsQuery } from "./search-objects-query";

// Outcome of the init-time schema check:
//  - "ok":      got a well-formed response in the shape the mapper expects.
//  - "drift":   the query failed GraphQL validation/parse — it no longer matches
//               the live Eureka schema (a field/type/arg we rely on changed).
//  - "unknown": couldn't determine (network/timeout/auth/unexpected shape). Never
//               treat this as drift — it must not disable a possibly-working tool.
export type SchemaCheckResult = "ok" | "drift" | "unknown";

// Result plus a human-readable reason, used for the single per-run log line.
interface SchemaCheckOutcome {
	result: SchemaCheckResult;
	detail?: string;
}

// One-time schema guard, run (and awaited) at server init. Fires the shipped
// GetEurekaResults query against the live gateway and verifies the response is
// well-formed. Never throws, and never runs longer than SCHEMA_CHECK_TIMEOUT_MS
// — failures/timeouts resolve to "unknown" so they can never disable a
// possibly-working tool or block startup. Logs exactly one line per run
// (result + duration + reason) so the check is observable in the logs.
export async function verifySearchObjectsSchema(
	instanceUrl: string,
	token: string,
): Promise<SchemaCheckResult> {
	const startedAt = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Hard cap independent of fetch internals: whatever stalls, resolve "unknown".
	const timeout = new Promise<SchemaCheckOutcome>((resolve) => {
		timer = setTimeout(
			() =>
				resolve({
					result: "unknown",
					detail: `exceeded ${SCHEMA_CHECK_TIMEOUT_MS}ms hard cap`,
				}),
			SCHEMA_CHECK_TIMEOUT_MS,
		);
	});

	let outcome: SchemaCheckOutcome;
	try {
		outcome = await Promise.race([runSchemaCheck(instanceUrl, token), timeout]);
	} finally {
		clearTimeout(timer);
	}

	const ms = Date.now() - startedAt;
	if (outcome.result === "drift") {
		console.warn(
			`search_objects schema check: DRIFT (schema mismatch) after ${ms}ms — ${outcome.detail} — tool will not be listed`,
		);
	} else if (outcome.result === "unknown") {
		console.info(
			`search_objects schema check: inconclusive after ${ms}ms — ${outcome.detail ?? "no detail"} — tool left enabled`,
		);
	} else {
		console.info(`search_objects schema check: ok after ${ms}ms`);
	}
	return outcome.result;
}

async function runSchemaCheck(
	instanceUrl: string,
	token: string,
): Promise<SchemaCheckOutcome> {
	let body: any;
	try {
		const response = await fetch(`${instanceUrl}/prism/?op=GetEurekaResults`, {
			method: "POST",
			headers: buildHeaders(token, undefined, undefined, {
				requestId: generateRequestId(),
				acceptLanguage: "en-US",
			}),
			// Variable values are irrelevant: GraphQL validates the document (its
			// fields, types and args) before executing, so a minimal page suffices.
			body: JSON.stringify({
				operationName: "GetEurekaResults",
				query: searchObjectsQuery,
				variables: {
					params: {
						batchSize: 1,
						desiredFacets: [{ facetType: "STICKERS", facetValue: [] }],
						facetSelections: [],
						maxPinboardVizCount: MAX_PINBOARD_VIZ_COUNT,
						filterSelections: [],
						offset: 0,
						query: "a",
						removeDuplicates: true,
						sortBy: [],
						currentPageNumber: 1,
						searchOption: "SEARCH_RESULTS",
					},
				},
			}),
			signal: AbortSignal.timeout(SCHEMA_CHECK_TIMEOUT_MS),
		});
		body = await response.json();
	} catch (error) {
		// Network error, timeout, disabled endpoint, non-JSON body, etc. — can't
		// verify anything, so report inconclusive rather than drift. Keep the cause
		// (e.g. TimeoutError vs a network failure) so the log explains why.
		const cause =
			error instanceof Error
				? `${error.name}: ${error.message}`
				: "request failed";
		return { result: "unknown", detail: cause };
	}

	const errors: any[] = Array.isArray(body?.errors) ? body.errors : [];
	// Only validation/parse errors mean OUR query drifted from the schema;
	// auth/rate-limit/runtime errors are not this check's concern.
	const drift = errors.filter(
		(e) =>
			e?.extensions?.code === "GRAPHQL_VALIDATION_FAILED" ||
			e?.extensions?.code === "GRAPHQL_PARSE_FAILED" ||
			/cannot query field|unknown type|unknown argument|unknown field|of required type|is not defined/i.test(
				String(e?.message ?? ""),
			),
	);
	if (drift.length) {
		return {
			result: "drift",
			detail: drift.map((e) => e.message).join("; "),
		};
	}

	// A well-formed success carries the queryRequest object the mapper reads.
	if (body?.data?.queryRequest && typeof body.data.queryRequest === "object") {
		return { result: "ok" };
	}
	// Parseable but neither a known success shape nor a validation error (e.g. an
	// auth/runtime error) — inconclusive; don't penalize the tool. Surface any
	// server errors so the log is actionable.
	const detail = errors.length
		? `non-validation errors: ${errors.map((e) => e?.message ?? "?").join("; ")}`
		: "unexpected response shape (no data.queryRequest)";
	return { result: "unknown", detail };
}
