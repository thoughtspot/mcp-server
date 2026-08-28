import { describe, expect, it } from "vitest";
import {
	buildChoiceAnswer,
	summarizeWorksheetModel,
} from "../../../src/thoughtspot/spotter-model/spotter-model-mapper";

describe("buildChoiceAnswer", () => {
	// Table/column/join options carry a native is_selected flag.
	const flaggedChoice = {
		title: "Which fact table?",
		choice_type: "FACT_TABLE_RECOMMENDATION",
		choice_options: [
			{ table_option: { id: "1", table_guid: "guid-1", is_selected: false } },
			{ table_option: { id: "2", table_guid: "guid-2", is_selected: false } },
			{ table_option: { id: "3", table_guid: "guid-3", is_selected: true } },
		],
	};

	// Formula options have no is_selected field.
	const unflaggedChoice = {
		title: "Which formulas?",
		choice_options: [
			{ formula_option: { id: "1", name: "revenue" } },
			{ formula_option: { id: "2", name: "margin" } },
		],
	};

	it("returns undefined when nothing is pending", () => {
		expect(buildChoiceAnswer(null, ["1"])).toBeUndefined();
		expect(buildChoiceAnswer(undefined, ["1"])).toBeUndefined();
	});

	it("toggles is_selected on flagged options, keeping every option", () => {
		const answer = buildChoiceAnswer(flaggedChoice, ["2"]) as any;
		expect(answer.choice_options).toHaveLength(3);
		expect(
			answer.choice_options.map((o: any) => o.table_option.is_selected),
		).toEqual([false, true, false]);
		// The previously selected option is cleared, not left set.
		expect(answer.choice_options[2].table_option.is_selected).toBe(false);
	});

	it("supports selecting several flagged options", () => {
		const answer = buildChoiceAnswer(flaggedChoice, ["1", "3"]) as any;
		expect(
			answer.choice_options.map((o: any) => o.table_option.is_selected),
		).toEqual([true, false, true]);
	});

	it("filters unflagged (formula) options down to the selection", () => {
		const answer = buildChoiceAnswer(unflaggedChoice, ["2"]) as any;
		expect(answer.choice_options).toHaveLength(1);
		expect(answer.choice_options[0].formula_option.name).toBe("margin");
	});

	it("does not mutate the stored pending choice", () => {
		const answer = buildChoiceAnswer(flaggedChoice, ["1"]) as any;
		answer.choice_options[0].table_option.is_selected = "mutated";
		expect(flaggedChoice.choice_options[0].table_option.is_selected).toBe(
			false,
		);
	});

	it("preserves the envelope fields the builder binds against", () => {
		const answer = buildChoiceAnswer(flaggedChoice, ["1"]) as any;
		expect(answer.title).toBe("Which fact table?");
		expect(answer.choice_type).toBe("FACT_TABLE_RECOMMENDATION");
	});

	it("tolerates a missing or non-array choice_options", () => {
		// No options to flag, so the unflagged branch runs and normalizes the field to [].
		expect(buildChoiceAnswer({ title: "t" }, ["1"])).toEqual({
			title: "t",
			choice_options: [],
		});
		const answer = buildChoiceAnswer({ title: "t", choice_options: "nope" }, [
			"1",
		]) as any;
		expect(answer.choice_options).toEqual([]);
	});

	it("skips options whose inner payload is not an object or has no id", () => {
		const answer = buildChoiceAnswer(
			{ choice_options: [{ table_option: null }, { other: { name: "x" } }] },
			["1"],
		) as any;
		// Neither option carries an id, so the unflagged branch drops both.
		expect(answer.choice_options).toEqual([]);
	});
});

describe("summarizeWorksheetModel", () => {
	const model = (worksheetModel: unknown) => ({
		data: { Worksheet__operation: { worksheetModel } },
	});

	it("returns null when the response shape is unrecognized", () => {
		expect(summarizeWorksheetModel(undefined)).toBeNull();
		expect(summarizeWorksheetModel({})).toBeNull();
		expect(summarizeWorksheetModel(model(null))).toBeNull();
	});

	it("returns null for an empty model", () => {
		expect(
			summarizeWorksheetModel(
				model({
					schemaGraphProto: { schemaTables: [] },
					schemaJoins: [],
					columnGroup: [],
				}),
			),
		).toBeNull();
	});

	it("counts tables, joins and columns with table names", () => {
		const summary = summarizeWorksheetModel(
			model({
				schemaGraphProto: {
					schemaTables: [
						{ schemaTableId: "t1", userDefinedName: "ORDERS" },
						{ schemaTableId: "t2", userDefinedName: "CUSTOMERS" },
					],
				},
				schemaJoins: [{ srcSchemaTableId: "t1", destSchemaTableId: "t2" }],
				columnGroup: [
					{ worksheetColumn: [{}, {}, {}] },
					{ worksheetColumn: [{}] },
				],
			}),
		);
		expect(summary).toBe("2 tables (ORDERS, CUSTOMERS), 1 joins, 4 columns.");
	});

	it("omits the name list when no table has a usable name", () => {
		const summary = summarizeWorksheetModel(
			model({
				schemaGraphProto: { schemaTables: [{ userDefinedName: "" }, {}] },
				schemaJoins: [],
				columnGroup: [{ worksheetColumn: [{}] }],
			}),
		);
		expect(summary).toBe("2 tables, 0 joins, 1 columns.");
	});

	it("tolerates missing collections and non-array column groups", () => {
		const summary = summarizeWorksheetModel(
			model({
				schemaGraphProto: { schemaTables: [{ userDefinedName: "ORDERS" }] },
				columnGroup: [{ worksheetColumn: "nope" }, {}],
			}),
		);
		expect(summary).toBe("1 tables (ORDERS), 0 joins, 0 columns.");
	});
});
