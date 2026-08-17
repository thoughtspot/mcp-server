import { buildHeaders, generateRequestId, postJson } from "../rest-utils";
import type {
	FetchDataParams,
	FetchDataResult,
	FetchDataViz,
} from "./fetch-data-types";

// Default row cap per visualization; unbounded results overwhelm LLM context.
// Keep in sync with the `max_rows` description in tool-definitions.ts.
export const FETCH_DATA_DEFAULT_MAX_ROWS = 25;

// "Unbounded" record_size for Liveboards (they 500 if it can't hold the whole
// viz). Max 32-bit signed int — the endpoint reads it as a GraphQL Int.
export const LIVEBOARD_RECORD_SIZE = 2_147_483_647;

// Only Answers and Liveboards expose fetchable data.
enum ObjectType {
	Answer = "ANSWER",
	Liveboard = "LIVEBOARD",
}

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

// Normalize FULL or COMPACT rows into `columns` + positional `data_rows`.
// Cell values pass through as-is — no rounding, so callers get full precision.
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
			rows: rawRows.filter((row): row is unknown[] => Array.isArray(row)),
		};
	}

	// FULL rows are self-describing; take columns from the row keys (not
	// column_names) so the projection can't emit all-null cells on a mismatch.
	const columns = Object.keys(firstRow);
	// Null/malformed entries are dropped.
	const rows = rawRows.flatMap((row) =>
		isObjectRow(row) ? [columns.map((col) => row[col])] : [],
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
			sampling_ratio: content.sampling_ratio,
		};
	});
}

// Custom handler: the rest-api-sdk has no single call that resolves a GUID's
// type and fetches its data from the matching endpoint.
export function addFetchData(client: any, instanceUrl: string, token: string) {
	client.fetchData = async ({
		objectId,
		objectType: knownType,
		vizIds,
		maxRows = FETCH_DATA_DEFAULT_MAX_ROWS,
	}: FetchDataParams): Promise<FetchDataResult> => {
		// x-request-id ties the upstream call(s) together for tracing.
		const requestId = generateRequestId();
		const headers = buildHeaders(token, undefined, undefined, { requestId });

		// Resolve the object's type (decides the data endpoint) only when the
		// caller didn't already supply it from a prior search_objects result.
		let objectType = knownType ?? "";
		if (
			objectType !== ObjectType.Answer &&
			objectType !== ObjectType.Liveboard
		) {
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
			objectType = meta.metadata_type ?? "";
		}

		// Fetch the data from the endpoint matching the object type.
		const body: Record<string, unknown> = {
			metadata_identifier: objectId,
			data_format: DATA_FORMAT,
			record_offset: 0,
		};
		let endpoint: string;
		if (objectType === ObjectType.Answer) {
			endpoint = "/api/rest/2.0/metadata/answer/data";
		} else if (objectType === ObjectType.Liveboard) {
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

		// Answers cap rows via record_size; Liveboards need the whole viz, capped
		// client-side in mapContents.
		const recordSize =
			objectType === ObjectType.Liveboard ? LIVEBOARD_RECORD_SIZE : maxRows;
		const data = await postJson(
			`${instanceUrl}${endpoint}`,
			headers,
			{ ...body, record_size: recordSize },
			"fetchData failed",
		);
		const contents: RawDataContent[] = data?.contents ?? [];

		return { data: mapContents(contents, maxRows) };
	};
}
