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
			text: vi.fn().mockResolvedValue(JSON.stringify(body)),
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
			{ recordSize: 2, recordOffset: 4, query: "q", type: "SHARED_TO_ME" },
			{ record_size: 2, record_offset: 4, query: "q", type: "SHARED_TO_ME" },
		],
		[
			{ recordSize: 20, recordOffset: 0 },
			{ record_size: 20, record_offset: 0 },
		],
	])("searchAnalysts posts %o as %o", async (args, body) => {
		respond({ analysts: [{ id: "a-1" }] });

		await client.searchAnalysts(args);

		const [url, init] = (global.fetch as any).mock.calls[0];
		expect(url).toBe("https://ts.test/convex/spots/public/search");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body)).toEqual(body);
	});

	it("maps analysts to id, name and description only", async () => {
		respond({
			analysts: [
				{
					id: "a-1",
					name: "Revenue",
					description: "d",
					instructions: "not exposed",
					mcp_connectors: [{ id: "c-1", name: "Jira" }],
				},
				{ id: "a-2", name: null, description: null },
			],
			total_size: 7,
		});

		expect(
			await client.searchAnalysts({ recordSize: 2, recordOffset: 0 }),
		).toEqual({
			analysts: [
				{ id: "a-1", name: "Revenue", description: "d" },
				{ id: "a-2", name: "", description: "" },
			],
			totalSize: 7,
		});
	});

	it("defaults a missing analysts list and total_size", async () => {
		respond({});

		expect(
			await client.searchAnalysts({ recordSize: 2, recordOffset: 0 }),
		).toEqual({ analysts: [], totalSize: 0 });
	});

	it.each([500, 403])(
		"rejects with ThoughtSpotApiError(%d) on a failed response",
		async (status) => {
			respond({ message: "boom" }, status);

			const error = await client
				.searchAnalysts({ recordSize: 20, recordOffset: 0 })
				.catch((e: unknown) => e);

			expect(error).toBeInstanceOf(ThoughtSpotApiError);
			expect(error.status).toBe(status);
		},
	);
});
