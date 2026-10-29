import { createBearerAuthenticationConfig } from "@thoughtspot/rest-api-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	GET_DATA_TIMEOUT_MS,
	GET_DATA_VIZ_BATCH_SIZE,
	GET_DATA_VIZ_CONCURRENCY,
	LIVEBOARD_RECORD_SIZE,
} from "../../../../src/services/clients/get-data/get-data-client";
import { getThoughtSpotClient } from "../../../../src/services/clients/thoughtspot-client";

// Mock the ThoughtSpot REST API SDK
vi.mock("@thoughtspot/rest-api-sdk", () => ({
	createBearerAuthenticationConfig: vi.fn(),
	ThoughtSpotRestApi: vi.fn(),
}));

// Mock fetch
global.fetch = vi.fn();

describe("get-data-client", () => {
	const mockInstanceUrl = "https://test.thoughtspot.com";
	const mockBearerToken = "test-token-123";

	let mockConfig: any;

	beforeEach(() => {
		vi.clearAllMocks();

		// Re-assign fetch as a fresh vi.fn() so mockResolvedValue/mockRejectedValue
		// are always available (vi.restoreAllMocks in afterEach would otherwise strip
		// the mock methods from the plain vi.fn() assigned at module load time).
		global.fetch = vi.fn();

		// Setup mock config
		mockConfig = {
			middleware: [],
		};

		(createBearerAuthenticationConfig as any).mockReturnValue(mockConfig);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("getData", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		// Mirrors the real /metadata/answer/data FULL response: column_names plus
		// object rows keyed by column name. The caller supplies object_type.
		it("fetches and maps a saved Answer", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					metadata_id: "obj-1",
					metadata_name: "Test Answer v1",
					contents: [
						{
							available_data_row_count: 2,
							column_names: ["city", "Total quantity purchased", "Total sales"],
							data_rows: [
								{
									city: "Boulder",
									"Total quantity purchased": 677792,
									"Total sales": 34070647.18,
								},
								{
									city: "Atlanta",
									"Total quantity purchased": 424496,
									"Total sales": 21161832.426,
								},
							],
							record_offset: 0,
							record_size: 10,
							returned_data_row_count: 2,
							sampling_ratio: 1,
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			// A single call fetches the answer data (no type-resolution round-trip).
			expect((fetch as any).mock.calls.length).toBe(1);
			const dataUrl = (fetch as any).mock.calls[0][0];
			const dataBody = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(dataUrl).toBe(
				`${mockInstanceUrl}/api/rest/2.0/metadata/answer/data`,
			);
			expect(dataBody).toEqual({
				metadata_identifier: "obj-1",
				data_format: "FULL",
				record_offset: 0,
				record_size: 25,
			});

			// FULL object rows are normalized into columns + positional rows.
			expect(result).toEqual({
				data: [
					{
						viz_id: undefined,
						viz_name: undefined,
						columns: ["city", "Total quantity purchased", "Total sales"],
						data_rows: [
							["Boulder", 677792, 34070647.18],
							["Atlanta", 424496, 21161832.426],
						],
						total_row_count: 2,
						sampling_ratio: 1,
					},
				],
			});
		});

		// A null-valued cell can be serialized as an absent key. Columns must come
		// from column_names, not the first row's keys, so the column isn't dropped.
		it("keeps a column the first row omits (columns from column_names)", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					contents: [
						{
							column_names: ["city", "Total sales"],
							data_rows: [
								{ city: "Boulder" }, // "Total sales" key absent (null)
								{ city: "Atlanta", "Total sales": 21161832.4 },
							],
							available_data_row_count: 2,
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0].columns).toEqual(["city", "Total sales"]);
			expect(result.data[0].data_rows).toEqual([
				["Boulder", null],
				["Atlanta", 21161832.4],
			]);
		});

		// column_names can be incomplete; a key present in rows but missing from it
		// must not be dropped (union of column_names + row keys).
		it("keeps a row key that column_names omits", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					contents: [
						{
							column_names: ["a"], // omits "b"
							data_rows: [{ a: 1, b: 2 }],
							available_data_row_count: 1,
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0].columns).toEqual(["a", "b"]);
			expect(result.data[0].data_rows).toEqual([[1, 2]]);
		});

		// A declared column that NO row carries (all-null column) must be kept, not
		// dropped — the schema stays intact and its cells read as null.
		it("keeps a declared column no row carries", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					contents: [
						{
							column_names: ["city", "Total sales"],
							data_rows: [{ city: "Boulder" }, { city: "Atlanta" }],
							available_data_row_count: 2,
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0].columns).toEqual(["city", "Total sales"]);
			expect(result.data[0].data_rows).toEqual([
				["Boulder", null],
				["Atlanta", null],
			]);
		});

		// Zero rows still returns the declared column headers (empty data set).
		it("keeps declared columns when there are no rows", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					contents: [
						{
							column_names: ["city", "Total sales"],
							data_rows: [],
							available_data_row_count: 0,
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0].columns).toEqual(["city", "Total sales"]);
			expect(result.data[0].data_rows).toEqual([]);
		});

		// A non-scalar cell is JSON-stringified so it can't violate the outputSchema.
		it("coerces a non-scalar cell to a string", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					contents: [
						{
							column_names: ["city", "meta"],
							data_rows: [{ city: "Boulder", meta: { tier: "gold" } }],
							available_data_row_count: 1,
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0].data_rows).toEqual([
				["Boulder", '{"tier":"gold"}'],
			]);
		});

		// A returned/capped count is not the total; without available_data_row_count
		// total_row_count is unknown (undefined), not a fabricated capped number.
		it("leaves total_row_count undefined when upstream omits the available count", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					contents: [
						{
							column_names: ["city"],
							data_rows: [{ city: "Boulder" }, { city: "Atlanta" }],
							returned_data_row_count: 2, // no available_data_row_count
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0].total_row_count).toBeUndefined();
		});

		// Mirrors the real /metadata/liveboard/data FULL response: one content
		// entry per visualization, each with visualization_id/name.
		it("fetches a whole Liveboard: enumerates vizzes, then scopes the data call", async () => {
			// Call 1: metadata/search enumerates the board's viz GUIDs.
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue([
					{
						metadata_id: "obj-1",
						visualization_headers: [
							{ id: "de1240fc-2d4d-4c67-9317-02e9c6e3bf1c", vizType: "CHART" },
							{ id: "cf049bb9-f3b7-466b-9000-41d814d3967a", vizType: "TABLE" },
						],
					},
				]),
			});
			// Then liveboard/data, one call per batch.
			const contentsById: Record<string, unknown> = {
				"de1240fc-2d4d-4c67-9317-02e9c6e3bf1c": {
					available_data_row_count: 1,
					column_names: ["item type", "Total sales"],
					data_rows: [{ "item type": "Dresses", "Total sales": 7896217.73 }],
					returned_data_row_count: 1,
					sampling_ratio: 1,
					visualization_id: "de1240fc-2d4d-4c67-9317-02e9c6e3bf1c",
					visualization_name: "Total sales by item type by year",
				},
				"cf049bb9-f3b7-466b-9000-41d814d3967a": {
					available_data_row_count: 1,
					column_names: ["city", "Total sales"],
					data_rows: [{ city: "Billings", "Total sales": 3198084.8 }],
					returned_data_row_count: 1,
					sampling_ratio: 1,
					visualization_id: "cf049bb9-f3b7-466b-9000-41d814d3967a",
					visualization_name: "Total sales by city (this year, 2026)",
				},
			};
			(fetch as any).mockImplementation(async (_url: string, init: any) => {
				const ids: string[] = JSON.parse(init.body).visualization_identifiers;
				return {
					ok: true,
					json: async () => ({ contents: ids.map((id) => contentsById[id]) }),
				};
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "LIVEBOARD",
				maxRows: 50,
			});

			// Call 1 is the viz enumeration.
			const metaUrl = (fetch as any).mock.calls[0][0];
			const metaBody = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(metaUrl).toBe(`${mockInstanceUrl}/api/rest/2.0/metadata/search`);
			expect(metaBody.include_visualization_headers).toBe(true);
			expect(metaBody.metadata).toEqual([
				{ identifier: "obj-1", type: "LIVEBOARD" },
			]);

			// Call 2 is the data fetch, scoped to the enumerated vizzes (one batch).
			expect((fetch as any).mock.calls).toHaveLength(2);
			const dataUrl = (fetch as any).mock.calls[1][0];
			const dataBody = JSON.parse((fetch as any).mock.calls[1][1].body);
			expect(dataUrl).toBe(
				`${mockInstanceUrl}/api/rest/2.0/metadata/liveboard/data`,
			);
			expect(dataBody.record_size).toBe(LIVEBOARD_RECORD_SIZE);
			expect(dataBody.visualization_identifiers).toEqual([
				"de1240fc-2d4d-4c67-9317-02e9c6e3bf1c",
				"cf049bb9-f3b7-466b-9000-41d814d3967a",
			]);

			expect(result.data).toEqual([
				{
					viz_id: "de1240fc-2d4d-4c67-9317-02e9c6e3bf1c",
					viz_name: "Total sales by item type by year",
					columns: ["item type", "Total sales"],
					data_rows: [["Dresses", 7896217.73]],
					total_row_count: 1,
					sampling_ratio: 1,
				},
				{
					viz_id: "cf049bb9-f3b7-466b-9000-41d814d3967a",
					viz_name: "Total sales by city (this year, 2026)",
					columns: ["city", "Total sales"],
					data_rows: [["Billings", 3198084.8]],
					total_row_count: 1,
					sampling_ratio: 1,
				},
			]);
		});

		// Echoes one content per requested viz id.
		const echoContents = (init: any) => {
			const ids: string[] = JSON.parse(init.body).visualization_identifiers;
			return {
				ok: true,
				json: async () => ({
					contents: ids.map((id) => ({ visualization_id: id, data_rows: [] })),
				}),
			};
		};

		// No cap: every viz is fetched in batches, at most N in flight; a freed
		// worker picks the next batch.
		it("fetches every viz of a big board in batches through the worker pool", async () => {
			const vizIds = Array.from({ length: 40 }, (_, i) => `viz-${i}`);
			let inFlight = 0;
			let peak = 0;
			(fetch as any).mockImplementation(async (url: string, init: any) => {
				if (url.endsWith("/metadata/search")) {
					return {
						ok: true,
						json: async () => [
							{
								visualization_headers: vizIds.map((id) => ({
									id,
									vizType: "CHART",
								})),
							},
						],
					};
				}
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setTimeout(r, 1));
				inFlight--;
				return echoContents(init);
			});

			const result = await client.getData({
				objectId: "board-big",
				objectType: "LIVEBOARD",
			});

			const batches = (fetch as any).mock.calls
				.slice(1)
				.map((c: any) => JSON.parse(c[1].body).visualization_identifiers);
			expect(batches).toHaveLength(40 / GET_DATA_VIZ_BATCH_SIZE);
			for (const ids of batches) {
				expect(ids).toHaveLength(GET_DATA_VIZ_BATCH_SIZE);
			}
			expect(peak).toBe(GET_DATA_VIZ_CONCURRENCY);
			// All 40, in board order regardless of completion order.
			expect(result.data.map((v: any) => v.viz_id)).toEqual(vizIds);
		});

		// One failing batch must not sink the others.
		it("returns vizzes from the batches that succeed when one fails", async () => {
			const vizIds = Array.from({ length: 10 }, (_, i) => `viz-${i}`);
			(fetch as any).mockImplementation(async (url: string, init: any) => {
				if (url.endsWith("/metadata/search")) {
					return {
						ok: true,
						json: async () => [
							{
								visualization_headers: vizIds.map((id) => ({
									id,
									vizType: "TABLE",
								})),
							},
						],
					};
				}
				const ids: string[] = JSON.parse(init.body).visualization_identifiers;
				if (ids.includes("viz-0")) {
					return {
						ok: false,
						status: 400,
						text: async () => '{"error":"Invalid vizId : viz-0"}',
					};
				}
				return {
					ok: true,
					json: async () => ({
						contents: ids.map((id) => ({
							visualization_id: id,
							column_names: ["a"],
							data_rows: [[1]],
						})),
					}),
				};
			});

			const result = await client.getData({
				objectId: "board-partial",
				objectType: "LIVEBOARD",
			});

			expect(result.data.map((v: any) => v.viz_id)).toEqual(vizIds.slice(5));
		});

		it("throws when every batch fails", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 400,
				text: async () => '{"error":"Invalid vizId"}',
			});

			await expect(
				client.getData({
					objectId: "board-1",
					objectType: "LIVEBOARD",
					vizIds: ["bad-1", "bad-2"],
				}),
			).rejects.toThrow("getData failed with status 400");
		});

		// Never-resolving fetch that rejects only when aborted.
		const hangUntilAborted = (init: any) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () =>
					reject(new Error("The operation was aborted")),
				);
			});

		it("throws a timeout when nothing finishes before the deadline", async () => {
			vi.useFakeTimers();
			try {
				(fetch as any).mockImplementation((_url: string, init: any) =>
					hangUntilAborted(init),
				);

				const pending = client.getData({
					objectId: "board-1",
					objectType: "LIVEBOARD",
					vizIds: ["slow-1"],
				});
				const assertion = expect(pending).rejects.toThrow(
					`getData timed out after ${GET_DATA_TIMEOUT_MS / 1000}s`,
				);
				await vi.advanceTimersByTimeAsync(GET_DATA_TIMEOUT_MS);
				await assertion;
			} finally {
				vi.useRealTimers();
			}
		});

		it("returns what finished by the deadline and skips the rest", async () => {
			vi.useFakeTimers();
			try {
				// 7 batches (b0..b6); b1 and b3 hang.
				const batchOf = (b: number) =>
					Array.from(
						{ length: GET_DATA_VIZ_BATCH_SIZE },
						(_, j) => `b${b}-${j}`,
					);
				const vizIds = Array.from({ length: 7 }, (_, b) => batchOf(b)).flat();
				(fetch as any).mockImplementation((_url: string, init: any) => {
					const ids: string[] = JSON.parse(init.body).visualization_identifiers;
					if (ids[0].startsWith("b1-") || ids[0].startsWith("b3-")) {
						return hangUntilAborted(init);
					}
					return Promise.resolve(echoContents(init));
				});

				const pending = client.getData({
					objectId: "board-1",
					objectType: "LIVEBOARD",
					vizIds,
				});
				await vi.advanceTimersByTimeAsync(GET_DATA_TIMEOUT_MS);
				const result = await pending;

				// Freed workers pick up b5/b6 (past the first 25); slow ones are dropped.
				expect(result.data.map((v: any) => v.viz_id)).toEqual(
					[0, 2, 4, 5, 6].flatMap(batchOf),
				);
			} finally {
				vi.useRealTimers();
			}
		});

		// Note/filter tiles have no data; sending them 400s the whole call.
		it("skips non-data tiles (notes, filters) when enumerating", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue([
					{
						visualization_headers: [
							{ id: "table-1", vizType: "TABLE" },
							{ id: "note-1", name: "Note-tile-note-1" },
							{ id: "filter-1", vizType: "FILTER" },
							{ id: "chart-1", vizType: "CHART" },
						],
					},
				]),
			});
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({ contents: [] }),
			});

			await client.getData({
				objectId: "board-mixed",
				objectType: "LIVEBOARD",
			});

			const dataBody = JSON.parse((fetch as any).mock.calls[1][1].body);
			expect(dataBody.visualization_identifiers).toEqual([
				"table-1",
				"chart-1",
			]);
		});

		// If enumeration yields no viz headers, fall back to the unbounded fetch
		// (no visualization_identifiers) rather than failing.
		it("falls back to an unbounded fetch when enumeration is empty", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue([{ visualization_headers: [] }]),
			});
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({ contents: [] }),
			});

			const result = await client.getData({
				objectId: "board-empty",
				objectType: "LIVEBOARD",
			});

			const dataBody = JSON.parse((fetch as any).mock.calls[1][1].body);
			expect(dataBody.visualization_identifiers).toBeUndefined();
			expect(result.data).toEqual([]);
		});

		// Enumeration itself failing (network/permission) must not fail the whole
		// request — fall back to the unbounded fetch.
		it("falls back to an unbounded fetch when enumeration fails", async () => {
			(fetch as any).mockRejectedValueOnce(new Error("metadata search boom"));
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({ contents: [] }),
			});

			const result = await client.getData({
				objectId: "board-err",
				objectType: "LIVEBOARD",
			});

			// Second call is the data fetch, unbounded (no viz filter).
			const dataUrl = (fetch as any).mock.calls[1][0];
			const dataBody = JSON.parse((fetch as any).mock.calls[1][1].body);
			expect(dataUrl).toBe(
				`${mockInstanceUrl}/api/rest/2.0/metadata/liveboard/data`,
			);
			expect(dataBody.visualization_identifiers).toBeUndefined();
			expect(result.data).toEqual([]);
		});

		// An answer pinned inside a Liveboard: pass the Liveboard GUID plus the
		// visualization GUID; the request carries visualization_identifiers.
		it("fetches a specific visualization inside a Liveboard", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					metadata_id: "obj-1",
					metadata_name: "Test MCP Liveboard 1",
					contents: [
						{
							available_data_row_count: 1,
							column_names: ["item type", "Total sales"],
							data_rows: [
								{ "item type": "Dresses", "Total sales": 7896217.73 },
							],
							returned_data_row_count: 1,
							sampling_ratio: 1,
							visualization_id: "de1240fc-2d4d-4c67-9317-02e9c6e3bf1c",
							visualization_name: "Total sales by item type by year",
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "LIVEBOARD",
				vizIds: ["de1240fc-2d4d-4c67-9317-02e9c6e3bf1c"],
			});

			const dataUrl = (fetch as any).mock.calls[0][0];
			const dataBody = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(dataUrl).toBe(
				`${mockInstanceUrl}/api/rest/2.0/metadata/liveboard/data`,
			);
			expect(dataBody.visualization_identifiers).toEqual([
				"de1240fc-2d4d-4c67-9317-02e9c6e3bf1c",
			]);
			expect(result.data).toHaveLength(1);
			expect(result.data[0].viz_id).toBe(
				"de1240fc-2d4d-4c67-9317-02e9c6e3bf1c",
			);
		});

		// COMPACT format returns positional rows alongside column_names; the
		// handler should pass them through aligned to the columns.
		it("tolerates COMPACT positional rows", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					metadata_id: "obj-1",
					metadata_name: "Compact Answer",
					contents: [
						{
							column_names: ["city", "Total sales"],
							data_rows: [
								["Boulder", 34070647.18],
								["Atlanta", 21161832.426],
							],
							returned_data_row_count: 2,
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0]).toMatchObject({
				columns: ["city", "Total sales"],
				data_rows: [
					["Boulder", 34070647.18],
					["Atlanta", 21161832.426],
				],
			});
		});

		// FULL rows without column_names: columns are derived from row keys.
		it("derives columns from row keys when column_names is absent", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					metadata_id: "obj-1",
					metadata_name: "No Columns",
					contents: [
						{
							data_rows: [
								{ city: "Boulder", "Total sales": 34070647.18 },
								{ city: "Atlanta", "Total sales": 21161832.426 },
							],
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0].columns).toEqual(["city", "Total sales"]);
			expect(result.data[0].data_rows).toEqual([
				["Boulder", 34070647.18],
				["Atlanta", 21161832.426],
			]);
		});

		// Cells pass through unchanged — full precision, no rounding.
		it("returns numeric cells at full precision in COMPACT rows", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					metadata_id: "obj-1",
					metadata_name: "Noisy Answer",
					contents: [
						{
							column_names: ["city", "Total sales", "Avg", "Orders"],
							data_rows: [
								["Boulder", 10679247.690000001, 120.030833623, 42],
								["Atlanta", 0.1 + 0.2, 121.694679091, null],
							],
							returned_data_row_count: 2,
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0].data_rows).toEqual([
				["Boulder", 10679247.690000001, 120.030833623, 42],
				["Atlanta", 0.1 + 0.2, 121.694679091, null],
			]);
		});

		it("returns numeric cells at full precision in FULL rows", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					metadata_id: "obj-1",
					metadata_name: "Noisy Full",
					contents: [
						{
							data_rows: [
								{ city: "Boulder", "Total sales": 10679247.690000001 },
							],
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0].data_rows).toEqual([
				["Boulder", 10679247.690000001],
			]);
		});

		// Small-magnitude values (rates, ratios) are returned exactly as stored.
		it("preserves small-magnitude values exactly", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					metadata_id: "obj-1",
					metadata_name: "Rates",
					contents: [
						{
							column_names: ["metric", "rate"],
							data_rows: [
								["conversion", 0.0043],
								["ratio", 0.014],
								["zero", 0],
							],
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0].data_rows).toEqual([
				["conversion", 0.0043],
				["ratio", 0.014],
				["zero", 0],
			]);
		});

		// Large integer IDs/timestamps pass through exactly.
		it("preserves large integers exactly", async () => {
			const bigId = 90071992547409936;
			const microTs = 1735689600000000;
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					metadata_id: "obj-1",
					metadata_name: "IDs",
					contents: [
						{
							column_names: ["record_id", "created_us"],
							data_rows: [[bigId, microTs]],
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0].data_rows).toEqual([[bigId, microTs]]);
		});

		// Null entries mixed into data_rows must not crash the row mapper.
		it("drops null rows instead of crashing", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					metadata_id: "obj-1",
					metadata_name: "Sparse",
					contents: [
						{
							data_rows: [
								{ city: "Boulder", sales: 1.5 },
								null,
								{ city: "Atlanta", sales: 2.5 },
							],
						},
					],
				}),
			});

			const result = await client.getData({
				objectId: "obj-1",
				objectType: "ANSWER",
			});

			expect(result.data[0].data_rows).toEqual([
				["Boulder", 1.5],
				["Atlanta", 2.5],
			]);
		});

		it("throws for an unsupported object type", async () => {
			await expect(
				client.getData({
					objectId: "obj-1",
					objectType: "LOGICAL_TABLE",
				}),
			).rejects.toThrow(/does not support object type "LOGICAL_TABLE"/);
			// No data call is made for unsupported types.
			expect((fetch as any).mock.calls.length).toBe(0);
		});

		it("throws when the data fetch is not ok", async () => {
			(fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 403,
				text: vi.fn().mockResolvedValue("forbidden"),
			});

			await expect(
				client.getData({ objectId: "obj-1", objectType: "ANSWER" }),
			).rejects.toThrow(/getData failed with status 403/);
		});
	});
});
