import { createBearerAuthenticationConfig } from "@thoughtspot/rest-api-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThoughtSpotClient } from "../../../../src/services/clients/thoughtspot-client";
import { ThoughtSpotApiError } from "../../../../src/services/types";

vi.mock("@thoughtspot/rest-api-sdk", () => ({
	createBearerAuthenticationConfig: vi.fn(),
	ThoughtSpotRestApi: vi.fn(),
}));

describe("analysts-client", () => {
	let client: any;
	const respond = (body: unknown, status = 200) =>
		(global.fetch as any).mockResolvedValue({
			ok: status < 400,
			status,
			json: vi.fn().mockResolvedValue(body),
			text: vi.fn().mockResolvedValue(body),
		});

	beforeEach(() => {
		global.fetch = vi.fn();
		(createBearerAuthenticationConfig as any).mockReturnValue({
			middleware: [],
		});
		client = new ThoughtSpotClient({
			instanceUrl: "https://ts.test",
			token: "t",
			tenantId: "",
			orgId: "",
			userId: "",
		});
	});

	it.each([
		[
			"searchAnalysts",
			{ recordSize: 2, recordOffset: 4, query: "q", type: "SHARED_TO_ME" },
			{ record_size: 2, record_offset: 4, query: "q", type: "SHARED_TO_ME" },
		],
		[
			"searchAnalysts",
			{ recordSize: 20, recordOffset: 0 },
			{ record_size: 20, record_offset: 0 },
		],
		["getAnalyst", { analystId: "a-1" }, { analyst_identifier: "a-1" }],
	])("%s posts %o as %o", async (op, args, body) => {
		respond({ analysts: [{ id: "a-1" }] });

		await client[op](args);

		const [url, init] = (global.fetch as any).mock.calls[0];
		expect(url).toBe("https://ts.test/convex/spots/public/search");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body)).toEqual(body);
	});

	it("maps analysts and their connectors, dropping unusable connectors", async () => {
		respond({
			analysts: [
				{
					id: "a-1",
					name: "Revenue",
					description: "d",
					instructions: "not exposed",
					mcp_connectors: [
						{ id: "c-1", name: "Jira", icon_url: "x" },
						{ id: "" },
						"c-2",
						"",
					],
				},
				{ id: "a-2", name: null, description: null },
			],
			total_size: 7,
		});

		expect(
			await client.searchAnalysts({ recordSize: 2, recordOffset: 0 }),
		).toEqual({
			analysts: [
				{
					id: "a-1",
					name: "Revenue",
					description: "d",
					connectors: [{ id: "c-1", name: "Jira" }, { id: "c-2" }],
				},
				{ id: "a-2", name: "", description: "", connectors: [] },
			],
			totalSize: 7,
		});
	});

	it.each([
		{ op: "searchAnalysts", status: 500, body: "boom", http: 500 },
		{ op: "getAnalyst", status: 403, body: "", http: 403 },
		// An empty fetch-mode result means the id is unknown.
		{ op: "getAnalyst", status: 404, body: { analysts: [] }, http: 200 },
	])(
		"$op rejects with ThoughtSpotApiError($status) on HTTP $http",
		async ({ op, status, body, http }) => {
			respond(body, http);

			const error = await client[op]({
				recordSize: 20,
				recordOffset: 0,
				analystId: "a-1",
			}).catch((e: unknown) => e);

			expect(error).toBeInstanceOf(ThoughtSpotApiError);
			expect(error.status).toBe(status);
		},
	);
});
