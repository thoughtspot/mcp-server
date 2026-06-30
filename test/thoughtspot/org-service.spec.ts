import { describe, expect, it, vi } from "vitest";
import { OrgService } from "../../src/thoughtspot/org-service";

// OrgService is a thin, instrumented wrapper over the client's org/token methods.
// These assert it delegates correctly and tolerates a nullish list response.

function makeClient(overrides: Record<string, unknown> = {}) {
	return {
		listOrgs: vi.fn(),
		fetchOrgBearerToken: vi.fn(),
		...overrides,
	} as any;
}

describe("OrgService", () => {
	describe("listOrgs", () => {
		it("delegates to client.listOrgs and returns the user's orgs", async () => {
			const client = makeClient({
				listOrgs: vi.fn().mockResolvedValue([
					{ id: 0, name: "Primary", description: "P" },
					{ id: 101, name: "DataPlatform" },
				]),
			});
			const orgs = await new OrgService(client).listOrgs();
			expect(client.listOrgs).toHaveBeenCalled();
			expect(orgs).toEqual([
				{ id: 0, name: "Primary", description: "P" },
				{ id: 101, name: "DataPlatform" },
			]);
		});

		it("tolerates a nullish upstream response", async () => {
			const client = makeClient({
				listOrgs: vi.fn().mockResolvedValue(undefined),
			});
			await expect(new OrgService(client).listOrgs()).resolves.toEqual([]);
		});
	});

	describe("fetchOrgBearerToken", () => {
		it("delegates to the client with the access token and org id", async () => {
			const client = makeClient({
				fetchOrgBearerToken: vi.fn().mockResolvedValue("org-token-xyz"),
			});
			const token = await new OrgService(client).fetchOrgBearerToken(
				"global-tok",
				"101",
			);
			expect(client.fetchOrgBearerToken).toHaveBeenCalledWith({
				accessToken: "global-tok",
				orgId: "101",
			});
			expect(token).toBe("org-token-xyz");
		});
	});
});
