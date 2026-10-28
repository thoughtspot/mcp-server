import { createBearerAuthenticationConfig } from "@thoughtspot/rest-api-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getThoughtSpotClient } from "../../../../src/services/clients/thoughtspot-client";

// Mock the ThoughtSpot REST API SDK
vi.mock("@thoughtspot/rest-api-sdk", () => ({
	createBearerAuthenticationConfig: vi.fn(),
	ThoughtSpotRestApi: vi.fn(),
}));

// Mock fetch
global.fetch = vi.fn();

describe("search-objects-client", () => {
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

	describe("searchObjects", () => {
		let client: any;

		beforeEach(() => {
			client = getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		});

		it("should search objects and map the results", async () => {
			const mockResponse = {
				data: {
					queryRequest: {
						requestIdentifiers: { apiRequestId: "req-1" },
						facets: [
							{
								facetType: "STICKERS",
								facetValues: [{ id: "tag-1", name: "Finance" }],
							},
						],
						results: [
							{
								objectSecurityInfo: {
									objectType: "QUESTION_ANSWER_BOOK",
									objectId: "answer-123",
								},
								searchAnswer: {
									header: {
										id: "answer-123",
										title: "Sales by Region",
										description: "Revenue by region",
										authorName: "alice",
										modifiedOn: 1700000000000,
										isVerified: true,
										tagIds: ["tag-1"],
									},
								},
								snippetInfo: {
									titleSnippet: { highlights: [{ start: 0, end: 5 }] },
								},
								resultType: "ANSWER_RESULT",
								score: 0.9,
							},
							{
								objectSecurityInfo: {
									objectType: "PINBOARD_ANSWER_BOOK",
									objectId: "lb-456",
								},
								searchPinboard: {
									header: {
										id: "lb-456",
										title: "Sales Overview",
										description: "Overview",
										authorName: "bob",
										modifiedOn: 1700000001000,
										isVerified: false,
									},
								},
								resultType: "PINBOARD_RESULT",
								score: 0.8,
							},
						],
						totalResults: 2,
					},
				},
			};

			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue(mockResponse),
			});

			const result = await client.searchObjects({
				query: "sales",
				limit: 5,
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.operationName).toBe("GetEurekaResults");
			expect(body.variables.params.query).toBe("sales");
			expect(body.variables.params.batchSize).toBe(5);

			expect(result.results).toEqual([
				{
					object_id: "answer-123",
					title: "Sales by Region",
					type: "ANSWER",
					author_name: "alice",
					description: "Revenue by region",
					tags: ["Finance"],
					last_modified: new Date(1700000000000).toISOString(),
					verified: true,
					external_link: `${mockInstanceUrl}/#/saved-answer/answer-123`,
					query: null, // no sageQuery in this fixture
					confidence: 0.9,
				},
				{
					object_id: "lb-456",
					title: "Sales Overview",
					type: "LIVEBOARD",
					author_name: "bob",
					description: "Overview",
					tags: [],
					last_modified: new Date(1700000001000).toISOString(),
					verified: false,
					external_link: `${mockInstanceUrl}/#/insights/pinboard/lb-456`,
					query: null, // Liveboards always map query -> null
					confidence: 0.8,
				},
			]);
			expect(result.next_cursor).toBeNull();
		});

		it("should generate and send the x-request-id header", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue({ data: { queryRequest: { results: [] } } }),
			});

			await client.searchObjects({ query: "sales" });

			const headers = (fetch as any).mock.calls[0][1].headers;
			const uuid =
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
			expect(headers["x-request-id"]).toMatch(uuid);
		});

		it("should send server-side facet selections for types and verified_only", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue({ data: { queryRequest: { results: [] } } }),
			});

			await client.searchObjects({
				query: "sales",
				types: ["LIVEBOARD", "ANSWER"],
				verifiedOnly: true,
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.variables.params.facetSelections).toEqual([
				{
					facetType: "OBJECT_TYPE",
					facetValue: ["pinboard_answer_book", "question_answer_book"],
				},
				{ facetType: "IS_VERIFIED", facetValue: ["true"] },
			]);
		});

		it("should default limit to 10 and offset to 0 when not provided", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue({ data: { queryRequest: { results: [] } } }),
			});

			const result = await client.searchObjects({ query: "sales" });

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.variables.params.batchSize).toBe(10);
			expect(body.variables.params.offset).toBe(0);
			expect(result.results).toEqual([]);
			expect(result.next_cursor).toBeNull();
		});

		it("should page using the cursor and emit next_cursor on a full page", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [
								{
									objectSecurityInfo: { objectType: "X", objectId: "a" },
									searchPinboard: { header: { id: "a", title: "A" } },
									resultType: "PINBOARD_RESULT",
								},
								{
									objectSecurityInfo: { objectType: "X", objectId: "b" },
									searchPinboard: { header: { id: "b", title: "B" } },
									resultType: "PINBOARD_RESULT",
								},
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({
				query: "sales",
				limit: 2,
				cursor: "4",
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.variables.params.offset).toBe(4);
			expect(result.next_cursor).toBe("6");
		});

		it("should apply modified_since as a client-side filter", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [
								{
									objectSecurityInfo: { objectType: "X", objectId: "old" },
									searchPinboard: {
										header: {
											id: "old",
											title: "Old",
											modifiedOn: 1600000000000,
										},
									},
									resultType: "PINBOARD_RESULT",
								},
								{
									objectSecurityInfo: { objectType: "X", objectId: "new" },
									searchPinboard: {
										header: {
											id: "new",
											title: "New",
											modifiedOn: 1700000000000,
										},
									},
									resultType: "PINBOARD_RESULT",
								},
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({
				query: "sales",
				modifiedSince: 1650000000000,
			});

			expect(result.results.map((o: any) => o.object_id)).toEqual(["new"]);
		});

		it("normalizes second-precision modifiedOn to epoch-ms", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [
								{
									objectSecurityInfo: { objectType: "X", objectId: "s" },
									searchPinboard: {
										// Seconds-precision timestamp from an older cluster.
										header: { id: "s", title: "S", modifiedOn: 1700000000 },
									},
									resultType: "PINBOARD_RESULT",
								},
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales" });

			// Seconds normalized to ms, then emitted as ISO-8601.
			expect(result.results[0].last_modified).toBe(
				new Date(1700000000000).toISOString(),
			);
		});

		// Helper: a single raw Eureka result owned by `author`.
		const ownedResult = (id: string, author: string) => ({
			objectSecurityInfo: { objectType: "X", objectId: id },
			searchPinboard: { header: { id, title: id, authorName: author } },
			resultType: "PINBOARD_RESULT",
		});
		const pageResponse = (results: any[]) => ({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: { queryRequest: { results } } }),
		});

		it("keeps fetching pages so a post-filter never returns a short page while matches remain", async () => {
			// Each full page of `limit` raw rows contributes only one owner match,
			// so a single fetch would return 1 object (and a misleading cursor).
			(fetch as any)
				.mockResolvedValueOnce(
					pageResponse([ownedResult("a1", "alice"), ownedResult("b1", "bob")]),
				)
				.mockResolvedValueOnce(
					pageResponse([ownedResult("a2", "alice"), ownedResult("b2", "bob")]),
				);

			const result = await client.searchObjects({
				query: "sales",
				owner: "alice",
				limit: 2,
			});

			expect((fetch as any).mock.calls.length).toBe(2);
			expect(
				JSON.parse((fetch as any).mock.calls[0][1].body).variables.params
					.offset,
			).toBe(0);
			expect(
				JSON.parse((fetch as any).mock.calls[1][1].body).variables.params
					.offset,
			).toBe(2);
			expect(result.results.map((o: any) => o.object_id)).toEqual(["a1", "a2"]);
			// A full final raw page means more may exist: resume past both pages.
			expect(result.next_cursor).toBe("4");
		});

		it("stops paging and emits a null cursor once raw results are exhausted", async () => {
			(fetch as any)
				.mockResolvedValueOnce(
					pageResponse([ownedResult("a1", "alice"), ownedResult("b1", "bob")]),
				)
				// Shorter-than-limit page => backend has nothing more to give.
				.mockResolvedValueOnce(pageResponse([ownedResult("b2", "bob")]));

			const result = await client.searchObjects({
				query: "sales",
				owner: "alice",
				limit: 2,
			});

			expect((fetch as any).mock.calls.length).toBe(2);
			expect(result.results.map((o: any) => o.object_id)).toEqual(["a1"]);
			expect(result.next_cursor).toBeNull();
		});

		it("honors the cursor's absolute offset without realigning it", async () => {
			(fetch as any).mockResolvedValue(pageResponse([]));

			await client.searchObjects({ query: "sales", limit: 10, cursor: "25" });

			const params = JSON.parse((fetch as any).mock.calls[0][1].body).variables
				.params;
			// The cursor offset is used as-is (no snap-back that could rewind a page
			// when limit changed between calls); page number is derived from it.
			expect(params.offset).toBe(25);
			expect(params.currentPageNumber).toBe(3);
		});

		it("should fall back to objectSecurityInfo.objectId when no header has an id", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [
								{ objectSecurityInfo: { objectType: "X", objectId: "y" } },
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales" });
			expect(result.results).toEqual([
				{
					object_id: "y",
					title: "",
					type: "X",
					author_name: "",
					tags: [],
					verified: false,
					external_link: `${mockInstanceUrl}/#/insights/pinboard/y`,
					query: null,
					confidence: 0,
				},
			]);
		});

		it("surfaces the parent Liveboard as id and the viz as visualization_id for a pinboard-viz hit", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [
								{
									objectSecurityInfo: {
										objectType: "PINBOARD_ANSWER_BOOK",
										objectId: "lb-1",
									},
									searchPinboardViz: {
										answer: { header: { id: "viz-1", title: "Revenue viz" } },
										pinboardHeader: { id: "lb-1", title: "Sales Board" },
									},
									resultType: "PINBOARD_VIZ_RESULT",
									score: 0.7,
								},
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.results).toHaveLength(1);
			const obj = result.results[0] as any;
			// get_data resolves the Liveboard id; the viz is passed via
			// visualization_ids to fetch just this visualization.
			expect(obj.object_id).toBe("lb-1");
			expect(obj.visualization_id).toBe("viz-1");
			// A viz pinned on a Liveboard is its own type ("Liveboard viz").
			expect(obj.type).toBe("LIVEBOARD_VIZ");
			expect(obj.external_link).toBe(
				`${mockInstanceUrl}/#/insights/pinboard/lb-1/viz-1`,
			);
		});

		it("should skip results with neither a header id nor an objectId", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [{ resultType: "PINBOARD_RESULT" }],
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales" });
			expect(result.results).toEqual([]);
		});

		it("returns an INTERNAL error envelope on GraphQL errors", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					errors: [{ message: "Invalid locale format: *" }],
					data: { queryRequest: null },
				}),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.status).toBe("error");
			expect(result.results).toEqual([]);
			expect(result.error.code).toBe("INTERNAL");
			expect(result.error.retryable).toBe(false);
		});

		it("maps a 401 to an UNAUTHORIZED error envelope", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 401,
				text: vi.fn().mockResolvedValue("unauthorized"),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.status).toBe("error");
			expect(result.error.code).toBe("UNAUTHORIZED");
			expect(result.error.retryable).toBe(false);
		});

		it("maps a 429 to a retryable RATE_LIMITED error envelope", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 429,
				text: vi.fn().mockResolvedValue("slow down"),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.error.code).toBe("RATE_LIMITED");
			expect(result.error.retryable).toBe(true);
		});

		it("maps a 504 to a retryable UPSTREAM_TIMEOUT error envelope", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 504,
				text: vi.fn().mockResolvedValue("gateway timeout"),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.error.code).toBe("UPSTREAM_TIMEOUT");
			expect(result.error.retryable).toBe(true);
		});

		it("maps a 500 to a retryable INTERNAL error envelope", async () => {
			(fetch as any).mockResolvedValue({
				ok: false,
				status: 500,
				text: vi.fn().mockResolvedValue("boom"),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.error.code).toBe("INTERNAL");
			expect(result.error.retryable).toBe(true);
		});

		it("resolves the type filter enum to Eureka facet values", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue({ data: { queryRequest: { results: [] } } }),
			});

			await client.searchObjects({
				query: "sales",
				// LIVEBOARD -> pinboard_answer_book; WORKSHEET -> logical_table (deduped).
				types: ["LIVEBOARD", "WORKSHEET", "WORKSHEET"],
			});

			const body = JSON.parse((fetch as any).mock.calls[0][1].body);
			expect(body.variables.params.facetSelections).toEqual([
				{
					facetType: "OBJECT_TYPE",
					facetValue: ["pinboard_answer_book", "logical_table"],
				},
			]);
		});

		// A raw Eureka result with a given id and relevance score.
		const scoredResult = (id: string, score: number) => ({
			objectSecurityInfo: { objectType: "X", objectId: id },
			searchPinboard: { header: { id, title: id } },
			resultType: "PINBOARD_RESULT",
			score,
		});

		it("returns an INVALID_ARGUMENT envelope for a whitespace-only query", async () => {
			(fetch as any).mockResolvedValue(pageResponse([]));

			const result = await client.searchObjects({ query: "   " });

			expect(result.status).toBe("error");
			expect(result.error.code).toBe("INVALID_ARGUMENT");
			expect(result.error.retryable).toBe(false);
			// Never hits the upstream for an empty term.
			expect((fetch as any).mock.calls.length).toBe(0);
		});

		it("clamps a negative cursor to offset 0", async () => {
			(fetch as any).mockResolvedValue(pageResponse([]));

			await client.searchObjects({ query: "sales", limit: 10, cursor: "-5" });

			const params = JSON.parse((fetch as any).mock.calls[0][1].body).variables
				.params;
			expect(params.offset).toBe(0);
			expect(params.currentPageNumber).toBe(1);
		});

		it("trusts the backend's isFinalPage over the full-page heuristic", async () => {
			// A short page would normally mean "no more results", but the backend
			// says otherwise (e.g. it trimmed rows for dedup/security reasons).
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [scoredResult("a", 0.5)],
							isFinalPage: false,
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales", limit: 2 });

			expect(result.results.map((o: any) => o.object_id)).toEqual(["a"]);
			expect(result.next_cursor).toBe("2");
		});

		it("emits a null cursor when the backend marks a full page as final", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [scoredResult("a", 0.5), scoredResult("b", 0.4)],
							isFinalPage: true,
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales", limit: 2 });

			expect(result.results).toHaveLength(2);
			expect(result.next_cursor).toBeNull();
		});

		it("truncates post-filter overshoot to limit with a skip-free cursor", async () => {
			// Page 1 contributes one owner match; page 2 contributes two, taking the
			// accumulated total to 3 for limit=2.
			(fetch as any)
				.mockResolvedValueOnce(
					pageResponse([ownedResult("a1", "alice"), ownedResult("b1", "bob")]),
				)
				.mockResolvedValueOnce(
					pageResponse([
						ownedResult("a2", "alice"),
						ownedResult("a3", "alice"),
					]),
				);

			const result = await client.searchObjects({
				query: "sales",
				owner: "alice",
				limit: 2,
			});

			expect(result.results.map((o: any) => o.object_id)).toEqual(["a1", "a2"]);
			// The dropped match ("a3") came from the page at offset 2, so the cursor
			// points back at it rather than past it.
			expect(result.next_cursor).toBe("2");
		});

		it("returns an INTERNAL error envelope when GraphQL errors carry no message", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ errors: [{}], data: null }),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.status).toBe("error");
			expect(result.error.code).toBe("INTERNAL");
		});

		it("returns an INTERNAL error envelope when the queryRequest reports an errorCode", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: { queryRequest: { errorCode: 42, results: [] } },
				}),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.status).toBe("error");
			expect(result.error.code).toBe("INTERNAL");
			expect(result.error.retryable).toBe(false);
		});

		it("returns a no_results envelope when the query matches nothing", async () => {
			(fetch as any).mockResolvedValue(pageResponse([]));

			const result = await client.searchObjects({ query: "nonexistent" });

			expect(result.status).toBe("no_results");
			expect(result.results).toEqual([]);
			expect(result.next_cursor).toBeNull();
		});

		it("applies tag as a client-side filter using resolved sticker names", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							facets: [
								{
									facetType: "STICKERS",
									facetValues: [{ id: "tag-1", name: "Finance" }],
								},
							],
							results: [
								{
									objectSecurityInfo: { objectType: "X", objectId: "a" },
									searchPinboard: {
										header: { id: "a", title: "A", tagIds: ["tag-1"] },
									},
									resultType: "PINBOARD_RESULT",
								},
								{
									objectSecurityInfo: { objectType: "X", objectId: "b" },
									searchPinboard: { header: { id: "b", title: "B" } },
									resultType: "PINBOARD_RESULT",
								},
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({
				query: "sales",
				tag: "finance",
			});

			expect(result.results.map((o: any) => o.object_id)).toEqual(["a"]);
		});

		it("derives `query` from sageQuery for Answers/vizzes and null otherwise", async () => {
			(fetch as any).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						queryRequest: {
							results: [
								{
									objectSecurityInfo: { objectType: "X", objectId: "a" },
									searchAnswer: { header: { id: "a", title: "A" } },
									resultType: "ANSWER_RESULT",
									sageQuery: "sales by region",
								},
								{
									objectSecurityInfo: { objectType: "X", objectId: "b" },
									searchPinboardViz: {
										pinboardHeader: { id: "lb", title: "LB" },
										answer: { header: { id: "b", title: "B" } },
									},
									resultType: "PINBOARD_VIZ_RESULT",
									sageQuery: "revenue weekly",
								},
								{
									// Liveboard: sageQuery is a bare GUID -> query must be null.
									objectSecurityInfo: { objectType: "X", objectId: "c" },
									searchPinboard: { header: { id: "c", title: "C" } },
									resultType: "PINBOARD_RESULT",
									sageQuery: "902ed66c-0765-4e05-832d-3c44fed7424e",
								},
							],
						},
					},
				}),
			});

			const result = await client.searchObjects({ query: "sales" });

			expect(result.results.map((o: any) => o.query)).toEqual([
				"sales by region",
				"revenue weekly",
				null,
			]);
		});

		it("stops accumulating after the page cap and warns", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			// Every page is full of non-matching rows, so the post-filter loop runs
			// to its page cap and reports that more results may remain.
			(fetch as any).mockResolvedValue(
				pageResponse([ownedResult("x1", "bob"), ownedResult("x2", "bob")]),
			);

			const result = await client.searchObjects({
				query: "sales",
				owner: "alice",
				limit: 2,
			});

			expect((fetch as any).mock.calls.length).toBe(20);
			// Nothing survived the post-filter -> no_results (cursor null per spec),
			// even though more raw pages may remain.
			expect(result.status).toBe("no_results");
			expect(result.results).toEqual([]);
			expect(result.next_cursor).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("stopped after 20 page"),
			);
			warnSpy.mockRestore();
		});
	});
});
