import { describe, expect, it } from "vitest";
import {
	SpotterAnswerCsvError,
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

	it("maps the header to columns and keeps cells as strings", () => {
		expect(csvToGetDataViz(csv, 25)).toEqual({
			columns: ["Region", "Revenue", "Label"],
			data_rows: [
				["East", "100", "$1"],
				["West", "-2.5e3", ""],
				["North", "7", "x"],
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
				["East", "11109350"],
				["West", "26279683"],
			],
			total_row_count: 2,
		});
	});

	it("keeps a single-column answer whose first cell is empty", () => {
		expect(csvToGetDataViz('"Region"\n""\n"East"\n', 25)).toMatchObject({
			columns: ["Region"],
			data_rows: [[""], ["East"]],
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
			expect(viz.data_rows[blankRow - 1]).toEqual([""]);
		},
	);

	it("rejects an export with no header row", () => {
		expect(() => csvToGetDataViz("", 25)).toThrow(SpotterAnswerCsvError);
	});
});
