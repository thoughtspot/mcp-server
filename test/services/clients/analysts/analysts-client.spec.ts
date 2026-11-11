import { createBearerAuthenticationConfig } from "@thoughtspot/rest-api-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThoughtSpotClient } from "../../../../src/services/clients/thoughtspot-client";
import { ThoughtSpotApiError } from "../../../../src/services/types";

vi.mock("@thoughtspot/rest-api-sdk", () => ({
	createBearerAuthenticationConfig: vi.fn(),
	ThoughtSpotRestApi: vi.fn(),
}));

global.fetch = vi.fn();

describe("analysts-client", () => {
	const instanceUrl = "https://test.thoughtspot.com";
	let client: any;

	const okResponse = (body: unknown) => ({
		ok: true,
		json: vi.fn().mockResolvedValue(body),
	});
	const errorResponse = (status: number, body = "") => ({
		ok: false,
		status,
		text: vi.fn().mockResolvedValue(body),
	});
	const sentBody = () => JSON.parse((fetch as any).mock.calls[0][1].body);

	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
		(createBearerAuthenticationConfig as any).mockReturnValue({
			middleware: [],
		});
		client = new ThoughtSpotClient({
			instanceUrl,
			token: "test-token",
			tenantId: "",
			orgId: "",
			userId: "",
		}) as any;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("searchAnalysts", () => {
		it("posts list-mode paging and filters, and maps the response", async () => {
			(fetch as any).mockResolvedValue(
				okResponse({
					analysts: [
						{
							id: "a-1",
							name: "Revenue",
							description: "Revenue questions",
							instructions: "secret instructions",
							mcp_connectors: [
								{ id: "c-1", name: "Jira", icon_url: "x" },
								{ id: "", name: "broken" },
							],
						},
						{ id: "a-2", name: null, description: null },
					],
					total_size: 7,
				}),
			);

			const result = await client.searchAnalysts({
				recordSize: 2,
				recordOffset: 4,
				query: "rev",
				type: "SHARED_TO_ME",
			});

			expect((fetch as any).mock.calls[0][0]).toBe(
				`${instanceUrl}/convex/spots/public/search`,
			);
			expect((fetch as any).mock.calls[0][1].method).toBe("POST");
			expect(sentBody()).toEqual({
				record_size: 2,
				record_offset: 4,
				query: "rev",
				type: "SHARED_TO_ME",
			});
			expect(result).toEqual({
				analysts: [
					{
						id: "a-1",
						name: "Revenue",
						description: "Revenue questions",
						connectors: [{ id: "c-1", name: "Jira" }],
					},
					{ id: "a-2", name: "", description: "", connectors: [] },
				],
				totalSize: 7,
			});
		});

		it("omits optional filters when not given", async () => {
			(fetch as any).mockResolvedValue(okResponse({}));

			const result = await client.searchAnalysts({
				recordSize: 20,
				recordOffset: 0,
			});

			expect(sentBody()).toEqual({ record_size: 20, record_offset: 0 });
			expect(result).toEqual({ analysts: [], totalSize: 0 });
		});

		it("throws ThoughtSpotApiError with the upstream status", async () => {
			(fetch as any).mockResolvedValue(errorResponse(500, "boom"));

			await expect(
				client.searchAnalysts({ recordSize: 20, recordOffset: 0 }),
			).rejects.toMatchObject({ status: 500, body: "boom" });
		});
	});

	describe("getAnalyst", () => {
		it("uses fetch mode and returns the single Analyst", async () => {
			(fetch as any).mockResolvedValue(
				okResponse({
					analysts: [
						{
							id: "a-1",
							name: "Revenue",
							description: "d",
							mcp_connectors: ["c-legacy"],
						},
					],
					total_size: 1,
				}),
			);

			const analyst = await client.getAnalyst({ analystId: "a-1" });

			expect(sentBody()).toEqual({ analyst_identifier: "a-1" });
			expect(analyst).toEqual({
				id: "a-1",
				name: "Revenue",
				description: "d",
				connectors: [{ id: "c-legacy" }],
			});
		});

		it.each([403, 404])(
			"propagates a %i as ThoughtSpotApiError",
			async (status) => {
				(fetch as any).mockResolvedValue(errorResponse(status));

				const error = await client
					.getAnalyst({ analystId: "a-1" })
					.catch((e: unknown) => e);

				expect(error).toBeInstanceOf(ThoughtSpotApiError);
				expect(error.status).toBe(status);
			},
		);

		it("treats an empty fetch-mode result as not found", async () => {
			(fetch as any).mockResolvedValue(
				okResponse({ analysts: [], total_size: 0 }),
			);

			await expect(
				client.getAnalyst({ analystId: "a-1" }),
			).rejects.toMatchObject({ status: 404 });
		});
	});
});
