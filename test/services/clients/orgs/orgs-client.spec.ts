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

describe("orgs-client", () => {
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

	describe("fetchOrgBearerToken (org-scoped token mint)", () => {
		function makeClient() {
			return getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		}

		it("calls the v2 auth/token/fetch endpoint with org_identifier and a 24-hour validity", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ data: { token: "org-tok" } }), {
					status: 200,
				}),
			);
			const client = makeClient();
			const token = await client.fetchOrgBearerToken({
				accessToken: "global-tok",
				orgId: "101",
			});

			expect(token).toBe("org-tok");
			const [url, init] = (global.fetch as any).mock.calls[0];
			expect(url).toContain("/callosum/v1/v2/auth/token/fetch");
			expect(url).toContain("org_identifier=101");
			// Default validity is 24 hours in seconds.
			expect(url).toContain(`validity_time_in_sec=${24 * 60 * 60}`);
			expect(init.method).toBe("GET");
			// Authenticates with the (global) access token, no org header on the mint.
			expect(init.headers.Authorization).toBe("Bearer global-tok");
		});

		it("honors an explicit validityTimeInSec override", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ token: "org-tok" }), { status: 200 }),
			);
			const client = makeClient();
			await client.fetchOrgBearerToken({
				accessToken: "g",
				orgId: "5",
				validityTimeInSec: 300,
			});
			const [url] = (global.fetch as any).mock.calls[0];
			expect(url).toContain("validity_time_in_sec=300");
			expect(url).toContain("org_identifier=5");
		});

		it("reads the token from either data.token or top-level token", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ token: "flat-tok" }), { status: 200 }),
			);
			const client = makeClient();
			await expect(
				client.fetchOrgBearerToken({ accessToken: "g", orgId: "1" }),
			).resolves.toBe("flat-tok");
		});

		it("throws on a non-OK response, including the status", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response("forbidden", { status: 403 }),
			);
			const client = makeClient();
			await expect(
				client.fetchOrgBearerToken({ accessToken: "g", orgId: "999" }),
			).rejects.toThrow(/status 403/);
		});

		it("throws when the response has no token", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ data: {} }), { status: 200 }),
			);
			const client = makeClient();
			await expect(
				client.fetchOrgBearerToken({ accessToken: "g", orgId: "1" }),
			).rejects.toThrow(/no token/);
		});
	});

	describe("listOrgs (user-scoped org membership)", () => {
		function makeClient() {
			return getThoughtSpotClient(mockInstanceUrl, mockBearerToken) as any;
		}

		it("calls the v1 session/orgs endpoint and maps orgId/orgName/description", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(
					JSON.stringify({
						orgs: [
							{ orgId: 0, orgName: "Primary", description: "Primary org" },
							{ orgId: 101, orgName: "DataPlatform" },
						],
						currentOrgId: 0,
					}),
					{ status: 200 },
				),
			);
			const client = makeClient();
			const orgs = await client.listOrgs();

			const [url, init] = (global.fetch as any).mock.calls[0];
			// User-scoped v1 endpoint, NOT the admin orgs/search.
			expect(url).toContain("/callosum/v1/session/orgs");
			expect(url).not.toContain("orgs/search");
			expect(init.method).toBe("GET");
			expect(init.headers.Authorization).toBe(`Bearer ${mockBearerToken}`);
			expect(orgs).toEqual([
				{ id: 0, name: "Primary", description: "Primary org" },
				{ id: 101, name: "DataPlatform", description: undefined },
			]);
		});

		it("returns an empty list when the response has no orgs array", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ currentOrgId: 0 }), { status: 200 }),
			);
			const client = makeClient();
			await expect(client.listOrgs()).resolves.toEqual([]);
		});

		it("throws (with status) on a non-OK response — e.g. an unexpected 403", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response("Operation is not allowed", { status: 403 }),
			);
			const client = makeClient();
			await expect(client.listOrgs()).rejects.toThrow(/status 403/);
		});

		it("falls back to id/name fields when orgId/orgName are absent", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ orgs: [{ id: 7, name: "Alt" }] }), {
					status: 200,
				}),
			);
			const client = makeClient();
			await expect(client.listOrgs()).resolves.toEqual([
				{ id: 7, name: "Alt", description: undefined },
			]);
		});

		it("uses the id as the name when neither orgName nor name is present", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(JSON.stringify({ orgs: [{ orgId: 42 }] }), {
					status: 200,
				}),
			);
			const client = makeClient();
			await expect(client.listOrgs()).resolves.toEqual([
				{ id: 42, name: "42", description: undefined },
			]);
		});

		it("maps an empty-string description to undefined", async () => {
			(global.fetch as any).mockResolvedValue(
				new Response(
					JSON.stringify({
						orgs: [{ orgId: 1, orgName: "X", description: "" }],
					}),
					{ status: 200 },
				),
			);
			const client = makeClient();
			const [org] = await client.listOrgs();
			expect(org.description).toBeUndefined();
		});
	});
});
