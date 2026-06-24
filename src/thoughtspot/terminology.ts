// Central glossary of ThoughtSpot terminology.
//
// ThoughtSpot objects are commonly referred to by several different names: the
// current UI name, a legacy name, and informal synonyms users reach for (a
// "Liveboard" is often called a "dashboard" or its old name "pinboard"; a
// "Model" used to be a "worksheet"; a "Tag" is also a "sticker"). Users phrase
// search queries with whichever term they know, so we keep the mapping in one
// place and resolve synonyms before talking to the backend.
//
// Sources (ThoughtSpot developer docs):
// - https://developers.thoughtspot.com/docs/thoughtspot-objects
// - https://developers.thoughtspot.com/docs/rest-apiv2-metadata-search
// - https://developers.thoughtspot.com/docs/metadata-api

// A single ThoughtSpot object concept and the various names it goes by.
export interface TerminologyEntry {
	// The canonical, current UI name.
	canonical: string;
	// Informal names and legacy names users may use for the same concept.
	synonyms: string[];
	// One-line description of what the object is.
	description: string;
	// The REST API v2 metadata type (where applicable).
	restApiType?: string;
}

// The ThoughtSpot object glossary. Surfaced for documentation and reused to
// build the synonym lookups below — keep new object types here so every lookup
// stays consistent.
export const TERMINOLOGY: TerminologyEntry[] = [
	{
		canonical: "Liveboard",
		synonyms: ["pinboard", "dashboard", "board"],
		description:
			"A collection of visualizations (pinned answers) arranged on a single interactive board. Formerly called a Pinboard.",
		restApiType: "LIVEBOARD",
	},
	{
		canonical: "Answer",
		synonyms: ["saved answer", "saved search", "viz", "visualization", "chart"],
		description:
			"A saved search result: a single visualization or table answering one question.",
		restApiType: "ANSWER",
	},
	{
		canonical: "Worksheet",
		synonyms: [
			"logical table",
			"dataset",
			"data model",
			"datasource",
			"data source",
		],
		description:
			"A curated, business-friendly data source built on top of tables that users search against. Formerly called a Worksheet.",
		restApiType: "LOGICAL_TABLE",
	},
	{
		canonical: "Tag",
		synonyms: ["sticker", "label"],
		description: "A label applied to objects for organization and discovery.",
		restApiType: "TAG",
	},
];

// Eureka object-type facet value for each canonical object concept the search
// bar can filter on. Eureka exposes three coarse buckets — `pinboard`
// (Liveboards), `answer` (Answers) and `worksheet` (data objects) — so several
// distinct concepts collapse onto the same facet value. Concepts absent from
// this map (e.g. Tag) are not filterable by object type.
const CANONICAL_OBJECT_TYPE_FACET: Record<string, string> = {
	Liveboard: "pinboard",
	Answer: "answer",
	Worksheet: "worksheet",
};

// Object-type synonyms accepted by the `types` filter, mapped to the
// OBJECT_TYPE_FACET value the Eureka search backend understands. Derived from
// TERMINOLOGY so the glossary stays the single source of truth: every faceted
// concept contributes its canonical name plus all of its synonyms.
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

// Resolve a user-supplied object-type term to the Eureka facet value. Falls
// back to the lowercased term so unknown/explicit facet values still pass
// through unchanged.
export function resolveObjectTypeFacet(type: string): string {
	const key = type.trim().toLowerCase();
	return OBJECT_TYPE_FACET_MAP[key] ?? key;
}

// Resolve and de-duplicate a list of object-type terms to Eureka facet values.
export function resolveObjectTypeFacets(types: string[]): string[] {
	return [...new Set(types.map(resolveObjectTypeFacet))];
}
