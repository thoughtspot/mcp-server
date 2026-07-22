import { buildHeaders, generateRequestId, postJson } from "../rest-utils";
import type {
	FetchDataParams,
	FetchDataResult,
	FetchDataViz,
} from "./fetch-data-types";

// Default row cap per visualization; unbounded results overwhelm LLM context.
// Keep in sync with the `max_rows` description in tool-definitions.ts.
export const FETCH_DATA_DEFAULT_MAX_ROWS = 25;

// Only Answers and Liveboards expose fetchable data.
const ANSWER_TYPE = "ANSWER";
const LIVEBOARD_TYPE = "LIVEBOARD";

// FULL rows are self-describing ({ col: value }), robust when `column_names`
// is absent; `mapContents` normalizes either shape to columns + positional rows.
const DATA_FORMAT = "FULL";

// Raw `contents[]` entry; field names follow the public REST v2 schema.
interface RawDataContent {
	column_names?: string[];
	// FULL: { columnName: value } objects. COMPACT: positional arrays.
	data_rows?: unknown[];
	available_data_row_count?: number;
	returned_data_row_count?: number;
	sampling_ratio?: number;
	// Present only for Liveboard visualizations.
	visualization_id?: string;
	visualization_name?: string;
}

function isObjectRow(row: unknown): row is Record<string, unknown> {
	return typeof row === "object" && row !== null && !Array.isArray(row);
}

// Round numeric cells to 2 decimals: collapses FP noise and trims payload.
// Non-numbers and non-finite values pass through untouched.
function roundCell(value: unknown): unknown {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return value;
	}
	// Integers have no fractional noise to trim; rounding large ones (IDs,
	// epoch timestamps) via *100 would overflow 2^53 and corrupt them.
	if (Number.isInteger(value)) {
		return value;
	}
	// Below 0.1 keep 2 significant digits so rates/ratios aren't zeroed.
	if (Math.abs(value) < 0.1) {
		return Number(value.toPrecision(2));
	}
	return Math.round(value * 100) / 100;
}

function roundRow(row: unknown[]): unknown[] {
	return row.map(roundCell);
}

// Normalize FULL or COMPACT rows into `columns` + positional `data_rows`.
function normalizeRows(content: RawDataContent): {
	columns: string[];
	rows: unknown[][];
} {
	const rawRows = content.data_rows ?? [];
	const firstRow = rawRows.find((r) => r != null);

	// COMPACT: positional rows; null/malformed entries are dropped.
	if (!isObjectRow(firstRow)) {
		return {
			columns: content.column_names ?? [],
			rows: rawRows
				.filter((row): row is unknown[] => Array.isArray(row))
				.map(roundRow),
		};
	}

	// FULL rows are self-describing; take columns from the row keys (not
	// column_names) so the projection can't emit all-null cells on a mismatch.
	const columns = Object.keys(firstRow);
	// Null/malformed entries are dropped.
	const rows = rawRows.flatMap((row) =>
		isObjectRow(row) ? [roundRow(columns.map((col) => row[col]))] : [],
	);
	return { columns, rows };
}

function mapContents(
	contents: RawDataContent[],
	maxRows: number,
): FetchDataViz[] {
	return contents.map((content) => {
		const { columns, rows } = normalizeRows(content);
		// Cap client-side: the Liveboard endpoint can't truncate upstream (see
		// fetchData), so it may return the full viz; keep `total_row_count` at the
		// upstream total so the caller still sees how many rows exist.
		const capped = rows.slice(0, maxRows);
		return {
			viz_id: content.visualization_id,
			viz_name: content.visualization_name,
			columns,
			data_rows: capped,
			total_row_count:
				content.available_data_row_count ??
				content.returned_data_row_count ??
				rows.length,
			row_count: capped.length,
			sampling_ratio: content.sampling_ratio,
		};
	});
}

// The Liveboard data endpoint rejects a record_size smaller than a viz's total
// row count with a 500 ("rowCount: N cannot be greater than batchSize: M"). We
// can't know N up front, so we read the required count off the error and refetch
// big enough. Returns that count, or null when the error is something else.
function requiredRowCount(error: unknown): number | null {
	const message = error instanceof Error ? error.message : String(error);
	const match = message.match(
		/rowCount:\s*(\d+)\s+cannot be greater than batchSize/,
	);
	return match ? Number(match[1]) : null;
}

// Custom handler: the rest-api-sdk has no single call that resolves a GUID's
// type and fetches its data from the matching endpoint.
export function addFetchData(client: any, instanceUrl: string, token: string) {
	client.fetchData = async ({
		objectId,
		vizIds,
		maxRows = FETCH_DATA_DEFAULT_MAX_ROWS,
	}: FetchDataParams): Promise<FetchDataResult> => {
		// Shared x-request-id ties both upstream calls together for tracing.
		const requestId = generateRequestId();
		const headers = buildHeaders(token, undefined, undefined, { requestId });

		// Step 1: resolve the object's type — it decides the data endpoint.
		const metaData = await postJson(
			`${instanceUrl}/api/rest/2.0/metadata/search`,
			headers,
			{ metadata: [{ identifier: objectId }] },
			"fetchData failed to resolve object",
		);
		const meta = metaData?.[0];
		if (!meta) {
			throw new Error(`fetchData found no object with id ${objectId}`);
		}
		const objectType: string = meta.metadata_type ?? "";
		const name: string = meta.metadata_name ?? meta.metadata_header?.name ?? "";
		const description: string = meta.metadata_header?.description ?? "";

		// Step 2: fetch the data from the endpoint matching the object type.
		const body: Record<string, unknown> = {
			metadata_identifier: objectId,
			data_format: DATA_FORMAT,
			record_offset: 0,
		};
		let endpoint: string;
		if (objectType === ANSWER_TYPE) {
			endpoint = "/api/rest/2.0/metadata/answer/data";
		} else if (objectType === LIVEBOARD_TYPE) {
			endpoint = "/api/rest/2.0/metadata/liveboard/data";
			// Omitting visualization_identifiers fetches every viz on the board.
			if (vizIds?.length) {
				body.visualization_identifiers = vizIds;
			}
		} else {
			throw new Error(
				`fetchData does not support object type "${objectType}" (id ${objectId}); only Answers and Liveboards expose fetchable data.`,
			);
		}

		// `record_size` caps returned rows for Answers, but the Liveboard endpoint
		// treats it as "must hold the whole viz" and 500s when it's too small.
		// Start at maxRows; on that error, bump to the required count and refetch,
		// then cap rows client-side below. Attempts are bounded (a full Liveboard
		// can report a larger viz on each retry) to avoid a runaway loop.
		let recordSize = maxRows;
		let data: any;
		for (let attempt = 0; ; attempt++) {
			try {
				data = await postJson(
					`${instanceUrl}${endpoint}`,
					headers,
					{ ...body, record_size: recordSize },
					"fetchData failed",
				);
				break;
			} catch (error) {
				const needed = requiredRowCount(error);
				if (needed == null || needed <= recordSize || attempt >= 3) {
					throw error;
				}
				recordSize = needed;
			}
		}
		const contents: RawDataContent[] = data?.contents ?? [];

		return {
			id: objectId,
			name,
			type: objectType,
			description,
			data: mapContents(contents, maxRows),
			request_id: requestId,
		};
	};
}
