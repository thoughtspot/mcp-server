// Glossary of ThoughtSpot object names (current, legacy, informal) so synonyms
// like pinboard/dashboard or model resolve to canonical names before backend calls.

// A single ThoughtSpot object concept and the various names it goes by.
export interface TerminologyEntry {
	// The canonical, current UI name.
	canonical: string;
	// Informal names and legacy names users may use for the same concept.
	synonyms: string[];
}

// Object glossary; the synonym lookups below are derived from it.
export const TERMINOLOGY: TerminologyEntry[] = [
	{
		canonical: "Liveboard",
		synonyms: ["pinboard", "dashboard", "board"],
	},
	{
		canonical: "Answer",
		synonyms: ["saved answer", "saved search", "viz", "visualization", "chart"],
	},
	{
		canonical: "Worksheet",
		synonyms: [
			"model",
			"logical table",
			"dataset",
			"data model",
			"datasource",
			"data source",
		],
	},
	{
		canonical: "Tag",
		synonyms: ["sticker", "label"],
	},
];

// Eureka facet per canonical concept; Eureka only has these three buckets.
// Concepts absent here (e.g. Tag) are not filterable by object type.
const CANONICAL_OBJECT_TYPE_FACET: Record<string, string> = {
	Liveboard: "pinboard",
	Answer: "answer",
	Worksheet: "worksheet",
};

// `types` filter synonyms -> Eureka OBJECT_TYPE_FACET values, derived from
// TERMINOLOGY so the glossary stays the single source of truth.
export const OBJECT_TYPE_FACET_MAP: Record<string, string> = Object.fromEntries(
	TERMINOLOGY.flatMap((entry) => {
		const facet = CANONICAL_OBJECT_TYPE_FACET[entry.canonical];
		if (!facet) {
			return [];
		}
		return [entry.canonical, ...entry.synonyms].map(
			(name) => [name.toLowerCase(), facet] as const,
		);
	}),
);

// Resolve a term to its Eureka facet; unknown terms pass through lowercased.
export function resolveObjectTypeFacet(type: string): string {
	const key = type.trim().toLowerCase();
	return OBJECT_TYPE_FACET_MAP[key] ?? key;
}

// Resolve and de-duplicate a list of object-type terms to Eureka facet values.
export function resolveObjectTypeFacets(types: string[]): string[] {
	return [...new Set(types.map(resolveObjectTypeFacet))];
}

// Eureka resultType -> canonical concept, so the surfaced `type` round-trips
// through resolveObjectTypeFacet when fed back as a `types` filter.
const RESULT_TYPE_TO_CANONICAL: Record<string, string> = {
	ANSWER_RESULT: "Answer",
	PINBOARD_RESULT: "Liveboard",
	// A viz pinned on a Liveboard is its own type ("Liveboard viz"), distinct
	// from a standalone Answer; `id` points at the parent Liveboard and
	// `visualization_id` at the viz for fetch_data.
	PINBOARD_VIZ_RESULT: "Visualization",
	WORKSHEET_RESULT: "Worksheet",
	LOGICAL_TABLE_RESULT: "Worksheet",
};

// Map an Eureka resultType to its canonical concept, or undefined if unknown.
export function resolveResultTypeToCanonical(
	resultType: string,
): string | undefined {
	return RESULT_TYPE_TO_CANONICAL[resultType];
}
