// Object-type mappings for the search: between the strict `types` filter enum
// (LIVEBOARD | LIVEBOARD_VIZ | ANSWER | WORKSHEET) the agent supplies and the
// two backend vocabularies — the Eureka OBJECT_TYPE facet, and the resultType
// strings the backend returns which we surface as `type`.

// Strict `types` filter value -> Eureka OBJECT_TYPE facet value (the metadata
// type name, as sent by the UI's facetSelections).
const OBJECT_TYPE_FACET_VALUE: Record<string, string> = {
	LIVEBOARD: "pinboard_answer_book",
	LIVEBOARD_VIZ: "visualization",
	ANSWER: "question_answer_book",
	WORKSHEET: "logical_table",
};

// Resolve `types` filter values to Eureka facet values, de-duplicated. Matching
// is case-insensitive; an unrecognized value passes through lowercased.
export function resolveObjectTypeFacets(types: string[]): string[] {
	return [
		...new Set(
			types.map((t) => {
				const key = t.trim().toUpperCase();
				return OBJECT_TYPE_FACET_VALUE[key] ?? t.trim().toLowerCase();
			}),
		),
	];
}

// Eureka resultType -> canonical concept surfaced as `type`. A viz pinned on a
// Liveboard ("Liveboard viz") is distinct from a standalone Answer: `id` is the
// parent Liveboard and `visualization_id` the viz (for fetch_data).
const RESULT_TYPE_TO_CANONICAL: Record<string, string> = {
	ANSWER_RESULT: "Answer",
	PINBOARD_RESULT: "Liveboard",
	PINBOARD_VIZ_RESULT: "Liveboard viz",
	WORKSHEET_RESULT: "Worksheet",
	LOGICAL_TABLE_RESULT: "Worksheet",
};

// Map an Eureka resultType to its canonical concept, or undefined if unknown.
export function resolveResultTypeToCanonical(
	resultType: string,
): string | undefined {
	return RESULT_TYPE_TO_CANONICAL[resultType];
}
