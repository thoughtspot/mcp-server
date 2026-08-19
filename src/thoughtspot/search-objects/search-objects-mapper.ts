// Projection helpers: raw Eureka result -> internal header -> spec-shaped result.
// Kept separate from the search orchestration so neither file is a giant function.

import { resolveResultTypeToCanonical } from "../object-types";
import type {
	SearchObjectHeader,
	SearchObjectResult,
} from "./search-objects-types";

// Deep link to the object in the ThoughtSpot UI, derived from its result type.
function toExternalLink(
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
function toQuery(resultType: string, sageQuery: unknown): string | null {
	if (resultType !== "ANSWER_RESULT" && resultType !== "PINBOARD_VIZ_RESULT") {
		return null;
	}
	return typeof sageQuery === "string" && sageQuery.trim() ? sageQuery : null;
}

// Eureka returns ALL sub-objects on every result; only the one matching
// resultType is populated (the rest are empty stubs with id/title ""). So
// dispatch strictly on resultType, never on which sub-object is "present".
// For a pinboard-viz hit the parent Liveboard is the `id` (get_object_data resolves
// it) and the viz id is surfaced separately.
function resolveResultShape(result: any): {
	id?: string;
	visualizationId?: string;
	header: any;
} {
	const resultType: string = result?.resultType ?? "";
	const fallbackId = result?.objectSecurityInfo?.objectId;

	if (resultType === "PINBOARD_VIZ_RESULT") {
		const viz = result?.searchPinboardViz;
		return {
			header: viz?.answer?.header,
			id: viz?.pinboardHeader?.id || fallbackId,
			visualizationId: viz?.answer?.header?.id || undefined,
		};
	}
	if (resultType === "PINBOARD_RESULT") {
		const header = result?.searchPinboard?.header;
		return { header, id: header?.id || fallbackId };
	}
	if (resultType === "ANSWER_RESULT") {
		const header = result?.searchAnswer?.header;
		return { header, id: header?.id || fallbackId };
	}
	if (
		resultType === "WORKSHEET_RESULT" ||
		resultType === "LOGICAL_TABLE_RESULT"
	) {
		const header = result?.searchWorksheet?.header;
		return { header, id: header?.id || fallbackId };
	}
	// Unknown kind: take whichever sub-header actually carries an id.
	const header =
		result?.searchAnswer?.header ??
		result?.searchPinboard?.header ??
		result?.searchWorksheet?.header;
	return { header, id: header?.id || fallbackId };
}

// Map one raw Eureka result to the internal working header, or null to drop it.
// `stickerNames` resolves tag GUIDs to names.
export function toHeader(
	result: any,
	instanceUrl: string,
	stickerNames: Record<string, string>,
): SearchObjectHeader | null {
	const resultType: string = result?.resultType ?? "";
	const { id, visualizationId, header } = resolveResultShape(result);
	// Empty-string ids are stubs, not real ids — drop them.
	if (!id) {
		return null;
	}
	// Falls back to the raw id when the STICKERS facet carries no name; a `tag`
	// filter then can't match by name (rare, cluster-dependent).
	const tags = (header?.tagIds ?? []).map(
		(tagId: string) => stickerNames[tagId] ?? tagId,
	);
	return {
		id,
		visualization_id: visualizationId,
		name: header?.title ?? "",
		// Canonical type so it round-trips as a `types` filter; raw backend type
		// is the fallback for unrecognized kinds.
		type:
			resolveResultTypeToCanonical(resultType) ??
			result?.objectSecurityInfo?.objectType ??
			resultType,
		owner: header?.authorName ?? "",
		description: header?.description || null,
		tags,
		last_modified: toEpochMs(header?.modifiedOn),
		verified: header?.isVerified ?? false,
		external_link: toExternalLink(
			instanceUrl,
			resultType,
			visualizationId ?? id,
			id,
		),
		query: toQuery(resultType, result?.sageQuery),
		// TODO: raw Eureka relevance score; normalization to 0–1 pending.
		confidence: result?.score ?? 0,
	};
}

// Project the internal working header to the spec-shaped result item:
// UPPER-case type, ISO-8601 last_modified, optional fields omitted when absent.
export function toResult(header: SearchObjectHeader): SearchObjectResult {
	return {
		object_id: header.id,
		...(header.visualization_id
			? { visualization_id: header.visualization_id }
			: {}),
		title: header.name,
		// Emit as an UPPER_SNAKE token, e.g. "Liveboard viz" -> "LIVEBOARD_VIZ".
		type: header.type.toUpperCase().replace(/\s+/g, "_"),
		author_name: header.owner,
		// Optional fields are omitted (not null) when absent.
		...(header.description ? { description: header.description } : {}),
		tags: header.tags,
		...(header.last_modified != null
			? { last_modified: new Date(header.last_modified).toISOString() }
			: {}),
		verified: header.verified,
		external_link: header.external_link,
		query: header.query,
		confidence: header.confidence,
	};
}
