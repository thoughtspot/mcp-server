import { describe, expect, it } from "vitest";
import {
	csvToGetDataViz,
	parseCsv,
} from "../../../../src/services/clients/get-data/spotter-answer-data";

describe("parseCsv", () => {
	it("parses quoted fields with commas, escaped quotes and newlines", () => {
		const csv =
			'Name,Note\n"Acme, Inc.","said ""hi""\nthen left"\nBeta,plain\n';
		expect(parseCsv(csv)).toEqual([
			["Name", "Note"],
			["Acme, Inc.", 'said "hi"\nthen left'],
			["Beta", "plain"],
		]);
	});

	it("handles CRLF line endings, a BOM and no trailing newline", () => {
		expect(parseCsv("﻿a,b\r\n1,2\r\n3,")).toEqual([
			["a", "b"],
			["1", "2"],
			["3", ""],
		]);
	});
});

describe("csvToGetDataViz", () => {
	const csv = "Region,Revenue,Label\nEast,100,$1\nWest,-2.5e3,\nNorth,7,x\n";

	it("maps the header to columns and coerces plain numbers and empty cells", () => {
		expect(csvToGetDataViz(csv, 25)).toEqual({
			columns: ["Region", "Revenue", "Label"],
			data_rows: [
				["East", 100, "$1"],
				["West", -2500, null],
				["North", 7, "x"],
			],
			total_row_count: 3,
		});
	});

	it("caps rows at maxRows but reports the full row count", () => {
		const viz = csvToGetDataViz(csv, 2);
		expect(viz.data_rows).toHaveLength(2);
		expect(viz.total_row_count).toBe(3);
	});

	it("skips the data-extract watermark preamble", () => {
		// Shape returned by a real cluster with watermarking on.
		const watermarked =
			'"Data extract produced by someone (someone@example.com) on 29/10/2026 05:28 UTC"\n"n"\n""\n"Store Region","Sales (fx)"\n"East","11109350"\n"West","26279683"\n';
		expect(csvToGetDataViz(watermarked, 25)).toMatchObject({
			columns: ["Store Region", "Sales (fx)"],
			data_rows: [
				["East", 11109350],
				["West", 26279683],
			],
			total_row_count: 2,
		});
	});

	it("keeps a single-column answer whose first cell is empty", () => {
		expect(csvToGetDataViz('"Region"\n""\n"East"\n', 25)).toMatchObject({
			columns: ["Region"],
			data_rows: [[null], ["East"]],
		});
	});

	it.each([2, 3, 4])(
		"keeps a single-column answer with an empty cell at row %i",
		(blankRow) => {
			const values = ["East", "West", "North", "South"];
			values.splice(blankRow - 1, 0, "");
			const csv = `${["Region", ...values].map((v) => `"${v}"`).join("\n")}\n`;
			const viz = csvToGetDataViz(csv, 25);
			expect(viz.columns).toEqual(["Region"]);
			expect(viz.total_row_count).toBe(5);
			expect(viz.data_rows[0]).toEqual(["East"]);
			expect(viz.data_rows[blankRow - 1]).toEqual([null]);
		},
	);

	it("coerces decimal and E-notation cells but keeps IDs and huge integers as text", () => {
		const viz = csvToGetDataViz(
			"v\n00123\n12345678901234567890\n1e3\n1.093225231E7\n1.50\n0.5\nInfinity\n+5\n.5\n42\n-3.25\n",
			25,
		);
		expect(viz.data_rows).toEqual([
			["00123"],
			["12345678901234567890"],
			[1000],
			[10932252.31],
			[1.5],
			[0.5],
			["Infinity"],
			["+5"],
			[".5"],
			[42],
			[-3.25],
		]);
	});

	it("returns no columns or rows for an empty export", () => {
		expect(csvToGetDataViz("", 25)).toMatchObject({
			columns: [],
			data_rows: [],
			total_row_count: 0,
		});
	});
});
