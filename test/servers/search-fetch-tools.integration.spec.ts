/**
 * Integration tests for the `search_objects` and `fetch_data` tools.
 *
 * Unlike the unit tests in mcp-server.spec.ts — which mock the whole
 * ThoughtSpot client and stub `searchObjects`/`fetchData` outright — these wire
 * the real components together and mock ONLY the external network boundary
 * (`fetch`). Every call flows through:
 *
 *   server.callSearchObjects / callFetchData → real ThoughtSpotService →
 *   real handler (addSearchObjects / addFetchData) → rest-utils.postJson →
 *   fetch (mocked).
 *
 * This exercises the request building (endpoints, headers, x-request-id,
 * facets, pagination offsets) and the response parsing/shaping (Eureka result
 * → canonical header, REST data → rounded rows) that the client-mocked unit
 * tests can't reach. Tools are invoked via the handler methods directly (as in
 * mcp-server-v2.integration.spec.ts) rather than a transport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCPServer } from "../../src/servers/mcp-server";
import { ThoughtSpotService } from "../../src/thoughtspot/thoughtspot-service";
import { makeRequest } from "./helpers";

// Product analytics is out of scope for these tests.
vi.mock("../../src/metrics/mixpanel/mixpanel", () => ({
	MixpanelTracker: class {
		track() {}
	},
}));

const INSTANCE_URL = "https://test.thoughtspot.cloud";

const mockProps = {
	instanceUrl: INSTANCE_URL,
	accessToken: "test-access-token",
	clientName: {
		clientId: "test-client-id",
		clientName: "test-client",
		registrationDate: 0,
	},
};

// Minimal getSessionInfo response that satisfies BaseMCPServer.init(). Stubbed
// at the service level so init() makes no network call; the real search/fetch
// handlers still run through the mocked fetch below.
const sessionInfoResponse = {
	clusterId: "test-cluster-123",
	clusterName: "test-cluster",
	releaseVersion: "10.13.0.cl-110",
	userGUID: "test-user-123",
	configInfo: {
		mixpanelConfig: {
			devSdkKey: "test-dev-token",
			prodSdkKey: "test-prod-token",
			production: false,
		},
		selfClusterName: "test-cluster",
		selfClusterId: "test-cluster-123",
		enableSpotterDataSourceDiscovery: true,
	},
	userName: "test-user",
	currentOrgId: "test-org",
	privileges: [],
};

// A Response-like object good enough for rest-utils.postJson and the raw-fetch
// handlers (they only touch ok/status/json()/text()).
function jsonResponse(body: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
}

// Per-test upstream handlers, keyed by the endpoint the real handlers hit. The
// router below always answers the init-time session-info call; each test wires
// only the routes it needs.
interface UpstreamHandlers {
	eureka?: (body: any) => unknown;
	metaSearch?: (body: any) => unknown;
	answerData?: (body: any) => unknown;
	liveboardData?: (body: any) => unknown;
}

let handlers: UpstreamHandlers;
let fetchMock: ReturnType<typeof vi.fn>;

function installRouter() {
	fetchMock = vi.fn(async (url: string, init?: any) => {
		const u = String(url);
		const body = init?.body ? JSON.parse(init.body) : undefined;

		if (u.includes("op=GetEurekaResults")) {
			if (!handlers.eureka) throw new Error(`unexpected eureka call: ${u}`);
			return handlers.eureka(body);
		}
		if (u.includes("/api/rest/2.0/metadata/search")) {
			if (!handlers.metaSearch) throw new Error(`unexpected metaSearch: ${u}`);
			return handlers.metaSearch(body);
		}
		if (u.includes("/api/rest/2.0/metadata/answer/data")) {
			if (!handlers.answerData) throw new Error(`unexpected answerData: ${u}`);
			return handlers.answerData(body);
		}
		if (u.includes("/api/rest/2.0/metadata/liveboard/data")) {
			if (!handlers.liveboardData)
				throw new Error(`unexpected liveboardData: ${u}`);
			return handlers.liveboardData(body);
		}
		throw new Error(`unmocked fetch: ${u}`);
	});
	vi.stubGlobal("fetch", fetchMock);
}

// Find the [url, init] of the first fetch call whose URL contains `needle`.
function callTo(needle: string): [string, any] | undefined {
	return fetchMock.mock.calls.find(([u]) => String(u).includes(needle)) as
		| [string, any]
		| undefined;
}

async function newServer(): Promise<MCPServer> {
	const server = new MCPServer({ props: mockProps, env: {} as any });
	await server.init();
	return server;
}

// Invoke a tool through its handler method. Recorder is optional — the metrics
// path guards an undefined recorder — so tests don't need to build one.
function callTool(
	server: MCPServer,
	name: string,
	args: Record<string, unknown>,
) {
	const request = makeRequest(name, args) as any;
	return name === "search_objects"
		? server.callSearchObjects(request, undefined as any)
		: server.callFetchData(request, undefined as any);
}

beforeEach(() => {
	vi.clearAllMocks();
	handlers = {};
	installRouter();
	// init() needs session info but it's not what we're testing — short-circuit
	// the call so no session-info fetch is required.
	vi.spyOn(ThoughtSpotService.prototype, "getSessionInfo").mockResolvedValue(
		sessionInfoResponse as any,
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// search_objects
// ---------------------------------------------------------------------------

describe("search_objects tool — real handler + mocked network", () => {
	// A raw Eureka page result for a saved Answer.
	const answerResult = {
		resultType: "ANSWER_RESULT",
		searchAnswer: {
			header: {
				id: "answer-1",
				title: "Sales by Region",
				authorName: "Alice",
				description: "Revenue by region",
				tagIds: ["sticker-1"],
				modifiedOn: 1_700_000_000, // seconds — must normalize to ms
				isVerified: true,
			},
		},
		snippetInfo: { titleSnippet: { highlights: [{ text: "Sales" }] } },
		sageQuery: "sales by region",
		score: 0.95,
		objectSecurityInfo: {
			objectId: "answer-1",
			objectType: "QUESTION_ANSWER_BOOK",
		},
	};

	// A pinboard-viz hit: id is the parent Liveboard, viz id surfaced separately.
	const vizResult = {
		resultType: "PINBOARD_VIZ_RESULT",
		searchPinboardViz: {
			pinboardHeader: { id: "liveboard-1" },
			answer: {
				header: {
					id: "viz-1",
					title: "Revenue Trend",
					authorName: "Bob",
					description: "Trend viz",
					tagIds: [],
					modifiedOn: 1_700_000_005_000, // already ms — must pass through
					isVerified: false,
				},
			},
		},
		snippetInfo: { descriptionSnippet: { highlights: [{ text: "Trend" }] } },
		sageQuery: "revenue weekly",
		score: 0.8,
		objectSecurityInfo: { objectId: "liveboard-1" },
	};

	// Eureka echoes every sub-object on every result; the ones that don't match
	// resultType are empty stubs (id/title ""). The mapper must ignore them and
	// dispatch on resultType, not on which sub-object is "present".
	const emptyStubs = {
		searchAnswer: { header: { id: "", title: "" } },
		searchPinboardViz: {
			pinboardHeader: { id: "", title: "" },
			answer: { header: { id: "", title: "" } },
		},
		searchWorksheet: { header: { id: "", title: "" } },
	};

	// A standalone Liveboard hit (carried on searchPinboard), with the empty
	// sibling stubs the real backend includes alongside it.
	const liveboardResult = {
		...emptyStubs,
		resultType: "PINBOARD_RESULT",
		searchPinboard: {
			header: {
				id: "liveboard-9",
				title: "SRW Spotter Command",
				authorName: "samuel weick",
				description: "",
				tagIds: [],
				modifiedOn: 1_752_025_458_563,
				isVerified: false,
			},
		},
		score: 0.99,
		objectSecurityInfo: {
			objectId: "liveboard-9",
			objectType: "PINBOARD_ANSWER_BOOK",
		},
	};

	function eurekaPage(results: unknown[], extra: Record<string, unknown> = {}) {
		return jsonResponse({
			data: {
				queryRequest: {
					results,
					facets: [
						{
							facetType: "STICKERS",
							facetValues: [{ id: "sticker-1", name: "Finance" }],
						},
					],
					isFinalPage: true,
					...extra,
				},
			},
		});
	}

	it("maps a mixed Eureka page to canonical object headers", async () => {
		handlers.eureka = () => eurekaPage([answerResult, vizResult]);

		const server = await newServer();

		const result = await callTool(server, "search_objects", { query: "sales" });

		expect(result.isError).toBeUndefined();
		const structured = result.structuredContent as any;
		expect(structured.results).toHaveLength(2);

		expect(structured.results[0]).toMatchObject({
			object_id: "answer-1",
			type: "ANSWER", // UPPER-case, round-trips as a `types` filter
			title: "Sales by Region",
			author_name: "Alice",
			tags: ["Finance"], // resolved from the STICKERS facet
			last_modified: "2023-11-14T22:13:20.000Z", // seconds → ISO-8601
			verified: true,
			query: "sales by region", // sage tokens for an Answer
			frame_url: `${INSTANCE_URL}/#/saved-answer/answer-1`,
			confidence: 0.95,
		});

		expect(structured.results[1]).toMatchObject({
			object_id: "liveboard-1",
			visualization_id: "viz-1",
			type: "LIVEBOARD_VIZ", // a viz pinned on a Liveboard ("Liveboard viz")
			title: "Revenue Trend",
			last_modified: "2023-11-14T22:13:25.000Z", // already ms → ISO-8601
			query: "revenue weekly",
			frame_url: `${INSTANCE_URL}/#/insights/pinboard/liveboard-1/viz-1`,
		});

		expect(structured.next_cursor).toBeNull(); // isFinalPage: true
		expect(typeof structured.request_id).toBe("string");
		expect(structured.request_id.length).toBeGreaterThan(0);

		// The outbound Eureka request carries the tracing + locale headers.
		const [, init] = callTo("op=GetEurekaResults") ?? [];
		expect(init.headers["accept-language"]).toBe("en-US");
		expect(init.headers["x-request-id"]).toBe(structured.request_id);
		const body = JSON.parse(init.body);
		expect(body.variables.params.query).toBe("sales");
		expect(body.variables.params.batchSize).toBe(10); // default limit
	});

	it("maps a standalone Liveboard, ignoring the empty sibling stubs", async () => {
		// Regression: the mapper used to dispatch on which sub-object was present,
		// but Eureka includes an empty searchPinboardViz stub on every result — so
		// a Liveboard was read through the viz branch and surfaced empty/dropped.
		handlers.eureka = () => eurekaPage([liveboardResult]);

		const server = await newServer();

		const result = await callTool(server, "search_objects", {
			query: "command",
		});

		const structured = result.structuredContent as any;
		expect(structured.results).toHaveLength(1);
		const obj = structured.results[0];
		expect(obj.type).toBe("LIVEBOARD");
		expect(obj.title).toBe("SRW Spotter Command");
		expect(obj.object_id).toBe("liveboard-9");
		expect(obj.author_name).toBe("samuel weick");
		// Not a viz — no visualization_id.
		expect(obj.visualization_id).toBeUndefined();
	});

	it("sends type/verified facets and honors the cursor offset", async () => {
		handlers.eureka = () =>
			eurekaPage([answerResult], {
				isFinalPage: false,
				totalResults: 100,
			});

		const server = await newServer();

		const result = await callTool(server, "search_objects", {
			query: "sales",
			types: ["ANSWER"],
			verified_only: true,
			cursor: "20",
			limit: 5,
		});

		const structured = result.structuredContent as any;
		// startOffset 20 + limit 5 = 25; more pages remain (offset < totalResults).
		expect(structured.next_cursor).toBe("25");

		const [, init] = callTo("op=GetEurekaResults") ?? [];
		const params = JSON.parse(init.body).variables.params;
		expect(params.offset).toBe(20);
		expect(params.batchSize).toBe(5);
		expect(params.facetSelections).toEqual(
			expect.arrayContaining([
				{
					facetType: "OBJECT_TYPE",
					facetValue: ["question_answer_book"],
				},
				{ facetType: "IS_VERIFIED", facetValue: ["true"] },
			]),
		);
	});

	it("surfaces an upstream GraphQL error as a typed error envelope", async () => {
		// Eureka returns HTTP 200 with a query-level error.
		handlers.eureka = () =>
			jsonResponse({ errors: [{ message: "eureka exploded" }] });

		const server = await newServer();

		const result = await callTool(server, "search_objects", { query: "sales" });

		// Returned as structured content (not a protocol error) so the model can
		// render the typed envelope.
		expect(result.isError).toBeFalsy();
		const structured = result.structuredContent as any;
		expect(structured.status).toBe("error");
		expect(structured.results).toEqual([]);
		expect(structured.error.code).toBe("INTERNAL");
		expect(structured.error.retryable).toBe(false);
		expect(typeof structured.request_id).toBe("string");
	});

	it("returns a no_results envelope when nothing matches", async () => {
		handlers.eureka = () => eurekaPage([]);

		const server = await newServer();

		const result = await callTool(server, "search_objects", {
			query: "nothing-matches-this",
		});

		const structured = result.structuredContent as any;
		expect(structured.status).toBe("no_results");
		expect(structured.results).toEqual([]);
		expect(structured.next_cursor).toBeNull();
		expect(structured.message).toContain("nothing-matches-this");
	});
});

// ---------------------------------------------------------------------------
// fetch_data
// ---------------------------------------------------------------------------

describe("fetch_data tool — real handler + mocked network", () => {
	it("resolves an Answer's type, hits the answer endpoint, and rounds cells", async () => {
		handlers.metaSearch = () =>
			jsonResponse([
				{
					metadata_type: "ANSWER",
					metadata_name: "Sales by Region",
					metadata_header: { description: "Revenue by region" },
				},
			]);
		// COMPACT positional rows with fractional cells to exercise rounding.
		handlers.answerData = () =>
			jsonResponse({
				contents: [
					{
						column_names: ["Region", "Revenue"],
						data_rows: [
							["East", 1_200_000.555],
							["West", 0.0456],
						],
						available_data_row_count: 2,
						returned_data_row_count: 2,
						sampling_ratio: 1,
					},
				],
			});

		const server = await newServer();

		const result = await callTool(server, "fetch_data", {
			object_id: "answer-1",
		});

		expect(result.isError).toBeUndefined();
		const structured = result.structuredContent as any;
		expect(structured).toMatchObject({
			id: "answer-1",
			name: "Sales by Region",
			type: "ANSWER",
			description: "Revenue by region",
		});
		expect(structured.data).toHaveLength(1);
		expect(structured.data[0]).toMatchObject({
			viz_id: undefined,
			columns: ["Region", "Revenue"],
			total_row_count: 2,
			row_count: 2,
			sampling_ratio: 1,
		});
		// 1,200,000.555 → 2 decimals; 0.0456 (<0.1) → 2 significant digits.
		expect(structured.data[0].data_rows).toEqual([
			["East", 1_200_000.56],
			["West", 0.046],
		]);

		// Step 1 body resolves the id; the data endpoint matches the resolved type.
		const [, metaInit] = callTo("/metadata/search") ?? [];
		expect(JSON.parse(metaInit.body)).toEqual({
			metadata: [{ identifier: "answer-1" }],
		});
		expect(callTo("/metadata/answer/data")).toBeDefined();
		expect(callTo("/metadata/liveboard/data")).toBeUndefined();

		// Both upstream calls share one x-request-id, echoed back for tracing.
		const [, dataInit] = callTo("/metadata/answer/data") ?? [];
		expect(dataInit.headers["x-request-id"]).toBe(
			metaInit.headers["x-request-id"],
		);
		expect(structured.request_id).toBe(metaInit.headers["x-request-id"]);
	});

	it("fetches a Liveboard viz, passing the viz filter and max_rows through", async () => {
		handlers.metaSearch = () =>
			jsonResponse([
				{
					metadata_type: "LIVEBOARD",
					metadata_name: "Sales Board",
					metadata_header: { description: "board" },
				},
			]);
		// FULL self-describing rows; columns come from the row keys.
		handlers.liveboardData = () =>
			jsonResponse({
				contents: [
					{
						visualization_id: "viz-1",
						visualization_name: "By Product",
						data_rows: [
							{ Product: "Widget", Units: 10 },
							{ Product: "Gadget", Units: 5 },
						],
						available_data_row_count: 2,
						returned_data_row_count: 2,
					},
				],
			});

		const server = await newServer();

		const result = await callTool(server, "fetch_data", {
			object_id: "liveboard-1",
			visualization_ids: ["viz-1"],
			max_rows: 50,
		});

		expect(result.isError).toBeUndefined();
		const structured = result.structuredContent as any;
		expect(structured.type).toBe("LIVEBOARD");
		expect(structured.data[0]).toMatchObject({
			viz_id: "viz-1",
			viz_name: "By Product",
			columns: ["Product", "Units"],
			data_rows: [
				["Widget", 10],
				["Gadget", 5],
			],
		});

		// Liveboard endpoint used; the viz filter and record_size ride the body.
		const [, init] = callTo("/metadata/liveboard/data") ?? [];
		const body = JSON.parse(init.body);
		expect(body.visualization_identifiers).toEqual(["viz-1"]);
		expect(body.record_size).toBe(50);
		expect(callTo("/metadata/answer/data")).toBeUndefined();
	});

	it("retries when record_size is below the viz row count, then caps to max_rows", async () => {
		handlers.metaSearch = () =>
			jsonResponse([
				{
					metadata_type: "LIVEBOARD",
					metadata_name: "Sales Board",
					metadata_header: { description: "board" },
				},
			]);
		const allRows = [
			{ Product: "A", Units: 1 },
			{ Product: "B", Units: 2 },
			{ Product: "C", Units: 3 },
		];
		// The Liveboard endpoint 500s unless record_size >= the viz's total rows.
		handlers.liveboardData = (b) => {
			if ((b.record_size ?? 0) < allRows.length) {
				return jsonResponse(
					{
						error: {
							message: `rowCount: ${allRows.length} cannot be greater than batchSize: ${b.record_size}`,
						},
					},
					500,
				);
			}
			return jsonResponse({
				contents: [
					{
						visualization_id: "viz-1",
						visualization_name: "By Product",
						data_rows: allRows,
						available_data_row_count: allRows.length,
						returned_data_row_count: allRows.length,
					},
				],
			});
		};

		const server = await newServer();

		const result = await callTool(server, "fetch_data", {
			object_id: "liveboard-1",
			visualization_ids: ["viz-1"],
			max_rows: 2,
		});

		expect(result.isError).toBeUndefined();
		const structured = result.structuredContent as any;
		// Refetched all rows, then capped to max_rows; total still reflects upstream.
		expect(structured.data[0].data_rows).toEqual([
			["A", 1],
			["B", 2],
		]);
		expect(structured.data[0].row_count).toBe(2);
		expect(structured.data[0].total_row_count).toBe(3);

		// Two calls: the rejected max_rows attempt, then the refetch at the count.
		const lbCalls = fetchMock.mock.calls.filter(([u]) =>
			String(u).includes("/metadata/liveboard/data"),
		);
		expect(lbCalls.length).toBe(2);
		expect(JSON.parse(lbCalls[0][1].body).record_size).toBe(2);
		expect(JSON.parse(lbCalls[1][1].body).record_size).toBe(3);
	});

	it("returns an error response for an unsupported object type", async () => {
		handlers.metaSearch = () =>
			jsonResponse([
				{
					metadata_type: "WORKSHEET",
					metadata_name: "Sales Data",
					metadata_header: { description: "a worksheet" },
				},
			]);

		const server = await newServer();

		const result = await callTool(server, "fetch_data", { object_id: "ws-1" });

		expect(result.isError).toBe(true);
		expect((result.content as any[])[0].text).toMatch(
			/Failed to fetch object data: .*does not support object type "WORKSHEET"/,
		);
	});

	it("returns an error response when the object id resolves to nothing", async () => {
		handlers.metaSearch = () => jsonResponse([]);

		const server = await newServer();

		const result = await callTool(server, "fetch_data", {
			object_id: "missing",
		});

		expect(result.isError).toBe(true);
		expect((result.content as any[])[0].text).toMatch(
			/Failed to fetch object data: .*found no object with id missing/,
		);
	});

	it("surfaces an upstream non-2xx as an error response", async () => {
		handlers.metaSearch = () => jsonResponse({ message: "boom" }, 500);

		const server = await newServer();

		const result = await callTool(server, "fetch_data", {
			object_id: "answer-1",
		});

		expect(result.isError).toBe(true);
		expect((result.content as any[])[0].text).toMatch(
			/Failed to fetch object data: .*status 500/,
		);
	});
});
