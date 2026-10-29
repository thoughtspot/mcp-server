import { describe, expect, it } from "vitest";
import {
	csvToGetDataViz,
	parseCsv,
} from "../../../src/thoughtspot/get-data/spotter-answer-data";

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
		expect(csvToGetDataViz(csv, 25, "Revenue by region")).toEqual({
			viz_name: "Revenue by region",
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

	it("returns no columns or rows for an empty export", () => {
		expect(csvToGetDataViz("", 25)).toMatchObject({
			columns: [],
			data_rows: [],
			total_row_count: 0,
		});
	});
});
