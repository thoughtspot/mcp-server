import { describe, expect, it } from "vitest";
import {
	resolveObjectTypeFacets,
	resolveResultTypeToCanonical,
} from "../../src/thoughtspot/object-types";

describe("object-types", () => {
	describe("resolveObjectTypeFacets", () => {
		it("maps the strict type enum to Eureka facet values", () => {
			expect(resolveObjectTypeFacets(["LIVEBOARD"])).toEqual([
				"pinboard_answer_book",
			]);
			expect(resolveObjectTypeFacets(["LIVEBOARD_VIZ"])).toEqual([
				"visualization",
			]);
			expect(resolveObjectTypeFacets(["ANSWER"])).toEqual([
				"question_answer_book",
			]);
			expect(resolveObjectTypeFacets(["WORKSHEET"])).toEqual(["logical_table"]);
		});

		it("is case- and whitespace-insensitive", () => {
			expect(resolveObjectTypeFacets(["  liveboard  "])).toEqual([
				"pinboard_answer_book",
			]);
			expect(resolveObjectTypeFacets(["Answer"])).toEqual([
				"question_answer_book",
			]);
		});

		it("de-duplicates resolved facets", () => {
			expect(
				resolveObjectTypeFacets(["LIVEBOARD", "WORKSHEET", "WORKSHEET"]),
			).toEqual(["pinboard_answer_book", "logical_table"]);
		});

		it("passes an unrecognized value through lowercased", () => {
			expect(resolveObjectTypeFacets(["connection"])).toEqual(["connection"]);
		});
	});

	describe("resolveResultTypeToCanonical", () => {
		it("maps backend resultType strings to canonical concepts", () => {
			expect(resolveResultTypeToCanonical("ANSWER_RESULT")).toBe("Answer");
			expect(resolveResultTypeToCanonical("PINBOARD_RESULT")).toBe("Liveboard");
			expect(resolveResultTypeToCanonical("PINBOARD_VIZ_RESULT")).toBe(
				"Liveboard viz",
			);
			expect(resolveResultTypeToCanonical("WORKSHEET_RESULT")).toBe(
				"Worksheet",
			);
			// A logical table surfaces as a Worksheet too.
			expect(resolveResultTypeToCanonical("LOGICAL_TABLE_RESULT")).toBe(
				"Worksheet",
			);
		});

		it("returns undefined for an unknown resultType", () => {
			expect(resolveResultTypeToCanonical("CONNECTION_RESULT")).toBeUndefined();
		});
	});
});
