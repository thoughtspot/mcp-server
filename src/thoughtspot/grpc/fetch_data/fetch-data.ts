import type {
	FetchDataParams,
	FetchDataResult,
	FetchDataViz,
} from "./fetch-data-types";

// Default cap on rows fetched per visualization. The upstream APIs accept -1 to
// mean "all rows", but an unbounded result can easily overwhelm an LLM's
// context, so we cap by default and let callers raise it via `maxRows`.
export const FETCH_DATA_DEFAULT_MAX_ROWS = 1000;

// Object types we can resolve tabular data for. Other metadata (worksheets,
// connections, etc.) have no "answer data" to fetch.
const ANSWER_TYPE = "ANSWER";
const LIVEBOARD_TYPE = "LIVEBOARD";

// We request FULL format: in FULL each row is an object keyed by column name
// ({ "col": value }), whereas COMPACT returns positional arrays alongside a
// separate `column_names` list. FULL is self-describing per row, which is
// robust when `column_names` is not returned. `mapContents` normalizes either
// shape back into `columns` + positional `data_rows` for a compact result.
const DATA_FORMAT = "FULL";

// A raw `contents[]` entry from the metadata answer/liveboard data endpoints.
// Field names follow the public REST v2 response schema (snake_case).
interface RawDataContent {
	column_names?: string[];
	// FULL: array of { columnName: value } objects. COMPACT: array of positional
	// value arrays aligned to `column_names`.
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

// Round a single cell, collapsing floating-point representation noise (e.g.
// 10679247.690000001 -> 10679247.69) while leaving non-finite numbers,
// integers, strings, and nulls untouched. Significant-figure rounding keeps
// genuine precision regardless of magnitude, so small metrics (0.0023) and
// large aggregates are both handled correctly.
function roundCell(value: unknown): unknown {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return value;
	}
	return Number(value.toPrecision(12));
}

function roundRow(row: unknown[]): unknown[] {
	return row.map(roundCell);
}

// Normalize a content entry's rows into `columns` + positional `data_rows`,
// handling both FULL (object rows) and COMPACT (positional rows) responses.
function normalizeRows(content: RawDataContent): {
	columns: string[];
	rows: unknown[][];
} {
	const rawRows = content.data_rows ?? [];
	const firstRow = rawRows.find((r) => r != null);

	// COMPACT: positional rows; trust the provided column_names ordering.
	if (!isObjectRow(firstRow)) {
		return {
			columns: content.column_names ?? [],
			rows: (rawRows as unknown[][]).map(roundRow),
		};
	}

	// FULL: object rows. Prefer the server's column ordering when present,
	// otherwise derive it from the union of keys (first-seen order).
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
	const rows = rawRows.map((row) =>
		isObjectRow(row)
			? roundRow(columns.map((col) => row[col]))
			: roundRow(row as unknown[]),
	);
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

/*
 * Using a custom handler because the rest-api-sdk does not expose a single
 * call that disambiguates an object by GUID and then fetches its data shaped to
 * its type. `fetch_data` is the natural follow-on to `search_objects`: given a
 * GUID, it resolves the object's type via metadata search and then pulls the
 * full result set from the matching public data endpoint.
 */
export function addFetchData(client: any, instanceUrl: string, token: string) {
	(client as any).fetchData = async ({
		objectId,
		vizIds,
		maxRows = FETCH_DATA_DEFAULT_MAX_ROWS,
	}: FetchDataParams): Promise<FetchDataResult> => {
		// Correlation id minted per call and echoed on every upstream request as
		// x-request-id, so the whole fetch_data flow can be traced together.
		const requestId = globalThis.crypto.randomUUID();

		const headers = {
			"Content-Type": "application/json",
			Accept: "application/json",
			"accept-language": "en-US",
			"x-request-id": requestId,
			"user-agent": "ThoughtSpot-ts-client",
			Authorization: `Bearer ${token}`,
		};

		// Step 1: resolve the object's type and display metadata. The data
		// endpoint to call depends on whether this GUID is an Answer or a
		// Liveboard.
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
			// Restrict to specific visualizations when requested; omit to fetch
			// every visualization on the Liveboard.
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
