// get_data for an unsaved Analytics Agent (Spotter) answer. The metadata data
// endpoints only take saved GUIDs, so these rows come from the answer's CSV
// export (session + generation number), parsed into the get_data result shape.

import type { GetDataViz } from "./get-data-types";

// RFC 4180 CSV: quoted fields may hold commas, newlines and "" escapes.
export function parseCsv(csv: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	// The export may lead with a UTF-8 BOM.
	const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') {
				inQuotes = false;
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") {
				i++;
			}
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += ch;
		}
	}
	// Last record when the file has no trailing newline.
	if (field !== "" || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

// Clusters with data-extract watermarking prepend single-field lines (e.g.
// "Data extract produced by <user> on <date>") and a blank line before the
// header. Look for that blank line near the top.
const WATERMARK_SCAN_ROWS = 5;

function isBlankRow(row: string[]): boolean {
	return row.length === 1 && row[0] === "";
}

// Drop a watermark preamble: single-field rows ending in a blank row, only when
// the first one reads "Data extract…". A single-column answer also has
// single-field rows, and an empty cell there looks like the blank line.
function stripWatermark(rows: string[][]): string[][] {
	if (!/^data extract/i.test(rows[0]?.[0] ?? "")) {
		return rows;
	}
	const blank = rows.slice(0, WATERMARK_SCAN_ROWS).findIndex(isBlankRow);
	if (blank < 1 || !rows.slice(0, blank).every((row) => row.length === 1)) {
		return rows;
	}
	return rows.slice(blank + 1);
}

// The answer's CSV export could not be read as a table.
export class SpotterAnswerCsvError extends Error {
	constructor(cause: unknown) {
		super(
			`Could not parse the answer's CSV export: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "SpotterAnswerCsvError";
	}
}

// First CSV row (after any watermark) is the header; the rest are capped at
// `maxRows`. Cells stay as the strings the export wrote.
export function csvToGetDataViz(csv: string, maxRows: number): GetDataViz {
	const [columns, ...rows] = stripWatermark(parseCsv(csv));
	if (!columns?.length) {
		throw new SpotterAnswerCsvError("the export has no header row");
	}
	return {
		columns,
		data_rows: rows.slice(0, maxRows),
		// The export returns the whole answer, so this is the full count.
		total_row_count: rows.length,
	};
}
