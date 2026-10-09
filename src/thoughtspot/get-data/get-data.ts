import { buildHeaders, generateRequestId, postJson } from "../rest-utils";
import { GET_DATA_SUPPORTED_TYPES } from "./get-data-constants";
import type {
	GetDataParams,
	GetDataResult,
	GetDataViz,
} from "./get-data-types";

// Default row cap per visualization; unbounded results overwhelm LLM context.
// Keep in sync with the `max_rows` description in tool-definitions.ts.
export const GET_DATA_DEFAULT_MAX_ROWS = 25;

// Max liveboard/data requests in flight; under the Worker's 6 concurrent-
// connection limit.
export const GET_DATA_VIZ_CONCURRENCY = 5;

// Vizzes per liveboard/data request.
export const GET_DATA_VIZ_BATCH_SIZE = 5;

// Fetches still pending after this are aborted and whatever finished is
// returned; a whole big board would exceed client/edge timeouts (524).
export const GET_DATA_TIMEOUT_MS = 30_000;

// Answer-backed tiles; notes/filters 400 the data call ("Invalid vizId").
const ANSWER_VIZ_TYPES = new Set(["TABLE", "CHART"]);

// "Unbounded" record_size for Liveboards (int32 max; they 500 if it can't hold
// the whole viz). Pulls the full viz into memory then caps client-side — don't
// lower to bound memory without verifying the endpoint honors a smaller value.
export const LIVEBOARD_RECORD_SIZE = 2_147_483_647;

// Answers and Liveboards expose fetchable data; a LIVEBOARD_VIZ fetches via its
// parent Liveboard's endpoint.
const [ANSWER_TYPE, LIVEBOARD_TYPE, LIVEBOARD_VIZ_TYPE] =
	GET_DATA_SUPPORTED_TYPES;

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

// Coerce a cell to the scalar the outputSchema declares; non-scalars (object/
// array) are JSON-stringified so a structured cell can't violate the schema.
function toCell(v: unknown): string | number | boolean | null {
	if (v === null || v === undefined) {
		return null;
	}
	const t = typeof v;
	if (t === "string" || t === "number" || t === "boolean") {
		return v as string | number | boolean;
	}
	return JSON.stringify(v);
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

	// Columns = column_names (authoritative order) plus any extra key seen in the
	// rows. Keep every declared column even if no row carries it (all-null column,
	// or zero rows) so the schema stays intact; a missing key just reads as null.
	const named = content.column_names ?? [];
	const rowKeys = new Set<string>();
	for (const row of rawRows) {
		if (isObjectRow(row)) {
			for (const k of Object.keys(row)) {
				rowKeys.add(k);
			}
		}
	}
	const columns = [...named, ...[...rowKeys].filter((k) => !named.includes(k))];
	// Null/malformed entries are dropped; a key a row lacks becomes null.
	const rows = rawRows.flatMap((row) =>
		isObjectRow(row) ? [columns.map((col) => row[col])] : [],
	);
	return { columns, rows };
}

function mapContents(
	contents: RawDataContent[],
	maxRows: number,
): GetDataViz[] {
	return contents.map((content) => {
		const { columns, rows } = normalizeRows(content);
		// Cap client-side (the Liveboard endpoint can't truncate upstream); cells
		// coerced to scalars to match the outputSchema.
		const capped = rows.slice(0, maxRows).map((r) => r.map(toCell));
		return {
			viz_id: content.visualization_id,
			viz_name: content.visualization_name,
			columns,
			data_rows: capped,
			// Total available upstream; undefined when upstream omits it, since a
			// returned/capped count is NOT the total.
			total_row_count: content.available_data_row_count,
			sampling_ratio: content.sampling_ratio,
		};
	});
}

// List a Liveboard's visualization GUIDs (in board order) via one metadata call,
// so a whole-board fetch can be bounded to the first N instead of pulling every
// viz. Returns [] if the board exposes no viz headers.
async function listLiveboardVizIds(
	instanceUrl: string,
	headers: Record<string, string>,
	objectId: string,
): Promise<string[]> {
	const result = await postJson(
		`${instanceUrl}/api/rest/2.0/metadata/search`,
		headers,
		{
			metadata: [{ identifier: objectId, type: LIVEBOARD_TYPE }],
			include_visualization_headers: true,
		},
		"getData failed to list liveboard visualizations",
	);
	const vizHeaders: unknown[] = result?.[0]?.visualization_headers ?? [];
	return (vizHeaders as { id?: unknown; vizType?: unknown }[])
		.filter((vh) => ANSWER_VIZ_TYPES.has(vh?.vizType as string))
		.map((vh) => vh.id)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
}

// Fetch Liveboard vizzes in batches through a pool of workers: each picks the
// next batch as soon as its last one lands, until the deadline aborts the rest.
// Returns what finished (board order); throws only if nothing did.
async function fetchVizPool(
	url: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
	vizIds: string[],
): Promise<RawDataContent[]> {
	const batches: string[][] = [];
	for (let i = 0; i < vizIds.length; i += GET_DATA_VIZ_BATCH_SIZE) {
		batches.push(vizIds.slice(i, i + GET_DATA_VIZ_BATCH_SIZE));
	}
	const fetched: RawDataContent[][] = new Array(batches.length);
	const errors: unknown[] = [];
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), GET_DATA_TIMEOUT_MS);
	const startedAt = Date.now();
	let next = 0;

	const worker = async () => {
		while (next < batches.length && !controller.signal.aborted) {
			const i = next++;
			try {
				const data = await postJson(
					url,
					headers,
					{
						...body,
						visualization_identifiers: batches[i],
						record_size: LIVEBOARD_RECORD_SIZE,
					},
					"getData failed",
					controller.signal,
				);
				fetched[i] = data?.contents ?? [];
			} catch (error) {
				const timedOut = controller.signal.aborted;
				console.error(
					`getData: batch ${i + 1}/${batches.length} ${timedOut ? "timed out" : "failed"} after ${Date.now() - startedAt}ms`,
					error instanceof Error ? error.message : String(error),
				);
				errors.push(
					timedOut
						? new Error(
								`getData timed out after ${GET_DATA_TIMEOUT_MS / 1000}s waiting for ThoughtSpot`,
							)
						: error,
				);
			}
		}
	};

	try {
		await Promise.all(
			Array.from(
				{ length: Math.min(GET_DATA_VIZ_CONCURRENCY, batches.length) },
				worker,
			),
		);
	} finally {
		clearTimeout(timer);
	}

	// filter() skips the holes left by failed/unfetched batches.
	const done = fetched.filter(Boolean);
	if (!done.length) {
		throw errors[0];
	}
	return done.flat();
}

// Custom handler: the rest-api-sdk has no single call that resolves a GUID's
// type and fetches its data from the matching endpoint.
export function addGetData(client: any, instanceUrl: string, token: string) {
	client.getData = async ({
		objectId,
		objectType,
		vizIds,
		maxRows = GET_DATA_DEFAULT_MAX_ROWS,
	}: GetDataParams): Promise<GetDataResult> => {
		// x-request-id ties the upstream call to tracing.
		const requestId = generateRequestId();
		const headers = buildHeaders(token, undefined, undefined, { requestId });

		// The caller-supplied type (from search_objects) picks the data endpoint.
		const body: Record<string, unknown> = {
			metadata_identifier: objectId,
			data_format: DATA_FORMAT,
			record_offset: 0,
		};
		let endpoint: string;
		if (objectType === ANSWER_TYPE) {
			endpoint = "/api/rest/2.0/metadata/answer/data";
		} else if (
			objectType === LIVEBOARD_TYPE ||
			objectType === LIVEBOARD_VIZ_TYPE
		) {
			endpoint = "/api/rest/2.0/metadata/liveboard/data";
			if (vizIds?.length) {
				// Caller scoped the fetch to specific vizzes.
				body.visualization_identifiers = vizIds;
			} else {
				// Whole-board request: enumerate the vizzes so the pool can fetch them
				// in batches; one unscoped call on a big board times out (524). Fall back
				// to it only if enumeration returns nothing or itself fails.
				let allVizIds: string[] = [];
				try {
					allVizIds = await listLiveboardVizIds(instanceUrl, headers, objectId);
				} catch (error) {
					console.error("getData: liveboard viz enumeration failed", error);
				}
				if (allVizIds.length) {
					body.visualization_identifiers = allVizIds;
				}
			}
		} else {
			throw new Error(
				`getData does not support object type "${objectType}" (id ${objectId}); only Answers and Liveboards expose fetchable data.`,
			);
		}

		const url = `${instanceUrl}${endpoint}`;
		const scopedVizIds = body.visualization_identifiers as string[] | undefined;
		if (scopedVizIds?.length) {
			const contents = await fetchVizPool(url, headers, body, scopedVizIds);
			return { data: mapContents(contents, maxRows) };
		}

		// Answers cap rows via record_size; Liveboards need the whole viz, capped
		// client-side in mapContents.
		const recordSize =
			objectType === ANSWER_TYPE ? maxRows : LIVEBOARD_RECORD_SIZE;
		const data = await postJson(
			url,
			headers,
			{ ...body, record_size: recordSize },
			"getData failed",
		);
		const contents: RawDataContent[] = data?.contents ?? [];

		return { data: mapContents(contents, maxRows) };
	};
}
