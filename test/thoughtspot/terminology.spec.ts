import { describe, expect, it } from "vitest";
import {
	OBJECT_TYPE_FACET_MAP,
	TERMINOLOGY,
	resolveObjectTypeFacet,
	resolveObjectTypeFacets,
} from "../../src/thoughtspot/terminology";

// Canonical object concepts that Eureka can filter on, and the facet value each
// resolves to. Kept in the test so a glossary edit that changes faceting is a
// deliberate, reviewed change.
const FACETED_CONCEPTS: Record<string, string> = {
	Liveboard: "pinboard",
	Answer: "answer",
	Worksheet: "worksheet",
};

describe("terminology", () => {
	describe("resolveObjectTypeFacet", () => {
		it("maps the Liveboard family to the pinboard facet", () => {
			expect(resolveObjectTypeFacet("liveboard")).toBe("pinboard");
			expect(resolveObjectTypeFacet("pinboard")).toBe("pinboard");
			expect(resolveObjectTypeFacet("dashboard")).toBe("pinboard");
		});

		it("maps the Answer family to the answer facet", () => {
			expect(resolveObjectTypeFacet("answer")).toBe("answer");
			expect(resolveObjectTypeFacet("saved search")).toBe("answer");
			expect(resolveObjectTypeFacet("visualization")).toBe("answer");
		});

		it("maps the Worksheet family to the worksheet facet", () => {
			expect(resolveObjectTypeFacet("worksheet")).toBe("worksheet");
			expect(resolveObjectTypeFacet("logical table")).toBe("worksheet");
			expect(resolveObjectTypeFacet("data model")).toBe("worksheet");
			expect(resolveObjectTypeFacet("data source")).toBe("worksheet");
		});

		it("is case- and whitespace-insensitive", () => {
			expect(resolveObjectTypeFacet("  Dashboard  ")).toBe("pinboard");
			expect(resolveObjectTypeFacet("ANSWER")).toBe("answer");
		});

		it("falls back to the lowercased term for unknown types", () => {
			expect(resolveObjectTypeFacet("connection")).toBe("connection");
			expect(resolveObjectTypeFacet("Pinboard_Viz")).toBe("pinboard_viz");
		});
	});

	describe("resolveObjectTypeFacets", () => {
		it("resolves and de-duplicates a list of terms", () => {
			expect(
				resolveObjectTypeFacets([
					"dashboard",
					"worksheet",
					"logical table",
					"data model",
				]),
			).toEqual(["pinboard", "worksheet"]);
		});
	});

	describe("glossary", () => {
		it("derives the facet map from TERMINOLOGY (single source of truth)", () => {
			// Every canonical name and synonym of a faceted concept must resolve to
			// that concept's facet value.
			for (const entry of TERMINOLOGY) {
				const facet = FACETED_CONCEPTS[entry.canonical];
				if (!facet) {
					continue;
				}
				for (const name of [entry.canonical, ...entry.synonyms]) {
					expect(resolveObjectTypeFacet(name)).toBe(facet);
				}
			}
		});

		it("only emits the three Eureka facet buckets", () => {
			for (const value of Object.values(OBJECT_TYPE_FACET_MAP)) {
				expect(["pinboard", "answer", "worksheet"]).toContain(value);
			}
		});

		it("does not facet non-object-type concepts such as Tag", () => {
			const tag = TERMINOLOGY.find((t) => t.canonical === "Tag");
			expect(tag).toBeDefined();
			// Tag is not an object-type facet, so it falls through to the raw term.
			expect(resolveObjectTypeFacet("tag")).toBe("tag");
			expect(resolveObjectTypeFacet("sticker")).toBe("sticker");
		});

		it("documents the core ThoughtSpot object concepts", () => {
			const canonicals = TERMINOLOGY.map((t) => t.canonical);
			expect(canonicals).toContain("Liveboard");
			expect(canonicals).toContain("Worksheet");
			const liveboard = TERMINOLOGY.find((t) => t.canonical === "Liveboard");
			expect(liveboard?.synonyms).toContain("pinboard");
			expect(liveboard?.synonyms).toContain("dashboard");
		});
	});
});
