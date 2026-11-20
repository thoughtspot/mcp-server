// get_data for an unsaved Analytics Agent (Spotter) answer. The metadata data
// endpoints only take saved GUIDs, so these rows come from the answer's CSV
// export (session + generation number), parsed into the get_data result shape.

import type { GetDataViz } from "./get-data-types";

// RFC 4180 CSV: quoted fields may hold commas, newlines and "" escapes.
export function parseCsv(csv: string): string[][] {
	return parseCsvRows(csv, Number.POSITIVE_INFINITY).rows;
}

// Parses the whole text but keeps only the first `maxStoredRows` rows, so a
// large file read for a few rows does not become a table of every cell.
// `totalRows` counts every row, kept or not.
function parseCsvRows(
	csv: string,
	maxStoredRows: number,
): { rows: string[][]; totalRows: number } {
	const rows: string[][] = [];
	let totalRows = 0;
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	// Whether any character has been read since the last row break.
	let pending = false;
	// The export may lead with a UTF-8 BOM.
	const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
	const endRow = () => {
		if (totalRows < maxStoredRows) {
			row.push(field);
			rows.push(row);
		}
		totalRows++;
		row = [];
		field = "";
		pending = false;
	};

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		// Past the stored rows only the row boundaries matter, not the cells.
		const keep = totalRows < maxStoredRows;
		if (inQuotes) {
			if (ch === '"' && text[i + 1] === '"') {
				if (keep) {
					field += '"';
				}
				i++;
			} else if (ch === '"') {
				inQuotes = false;
			} else if (keep) {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			if (keep) {
				row.push(field);
				field = "";
			}
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") {
				i++;
			}
			endRow();
			continue;
		} else if (keep) {
			field += ch;
		}
		pending = true;
	}
	// Last record when the file has no trailing newline. A row that is not kept
	// has no cells to look at, so it counts if any character followed the last break.
	const hasLastRow =
		totalRows < maxStoredRows ? field !== "" || row.length > 0 : pending;
	if (hasLastRow) {
		endRow();
	}
	return { rows, totalRows };
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
	// Enough rows for a watermark preamble, the header and `maxRows` of data.
	const { rows: parsed, totalRows } = parseCsvRows(
		csv,
		WATERMARK_SCAN_ROWS + 1 + maxRows,
	);
	const [columns, ...rows] = stripWatermark(parsed);
	if (!columns?.length) {
		throw new SpotterAnswerCsvError("the export has no header row");
	}
	// Rows above the data: the watermark preamble, if any, and the header.
	const leadingRows = parsed.length - rows.length;
	return {
		columns,
		data_rows: rows.slice(0, maxRows),
		// The export returns the whole answer, so this is the full count.
		total_row_count: totalRows - leadingRows,
	};
}
