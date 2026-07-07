import { generateRequestId } from "../grpc-utils";
import type {
	FetchDataParams,
	FetchDataResult,
	FetchDataViz,
} from "./fetch-data-types";

// Default row cap per visualization; unbounded results overwhelm LLM context.
export const FETCH_DATA_DEFAULT_MAX_ROWS = 1000;

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

	// FULL: object rows; derive columns from row keys when not provided.
	const columns = content.column_names ?? [];
	if (columns.length === 0) {
		for (const row of rawRows) {
			if (isObjectRow(row)) {
				for (const key of Object.keys(row)) {
					if (!columns.includes(key)) {
						columns.push(key);
					}
				}
			}
		}
	}
	// Null/malformed entries are dropped.
	const rows = rawRows.flatMap((row) => {
		if (isObjectRow(row)) {
			return [roundRow(columns.map((col) => row[col]))];
		}
		return Array.isArray(row) ? [roundRow(row)] : [];
	});
	return { columns, rows };
}

function mapContents(contents: RawDataContent[]): FetchDataViz[] {
	return contents.map((content) => {
		const { columns, rows } = normalizeRows(content);
		return {
			viz_id: content.visualization_id,
			viz_name: content.visualization_name,
			columns,
			data_rows: rows,
			total_row_count: content.available_data_row_count,
			row_count: content.returned_data_row_count ?? rows.length,
			sampling_ratio: content.sampling_ratio,
		};
	});
}

// Custom handler: the rest-api-sdk has no single call that resolves a GUID's
// type and fetches its data from the matching endpoint.
export function addFetchData(client: any, instanceUrl: string, token: string) {
	(client as any).fetchData = async ({
		objectId,
		vizIds,
		maxRows = FETCH_DATA_DEFAULT_MAX_ROWS,
	}: FetchDataParams): Promise<FetchDataResult> => {
		// Shared x-request-id ties both upstream calls together for tracing.
		const requestId = generateRequestId();

		const headers = {
			"Content-Type": "application/json",
			Accept: "application/json",
			"accept-language": "en-US",
			"x-request-id": requestId,
			"user-agent": "ThoughtSpot-ts-client",
			Authorization: `Bearer ${token}`,
		};

		// Step 1: resolve the object's type — it decides the data endpoint.
		const metaResponse = await fetch(
			`${instanceUrl}/api/rest/2.0/metadata/search`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ metadata: [{ identifier: objectId }] }),
			},
		);
		if (!metaResponse.ok) {
			const errorText = await metaResponse.text();
			throw new Error(
				`fetchData failed to resolve object with status ${metaResponse.status}: ${errorText}`,
			);
		}
		const metaData = (await metaResponse.json()) as any[];
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
			record_size: maxRows,
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

		const dataResponse = await fetch(`${instanceUrl}${endpoint}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		if (!dataResponse.ok) {
			const errorText = await dataResponse.text();
			throw new Error(
				`fetchData failed with status ${dataResponse.status}: ${errorText}`,
			);
		}
		const data = (await dataResponse.json()) as any;
		const contents: RawDataContent[] = data?.contents ?? [];

		return {
			id: objectId,
			name,
			type: objectType,
			description,
			data: mapContents(contents),
			request_id: requestId,
		};
	};
}
