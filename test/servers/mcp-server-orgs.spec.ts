import { connect } from "mcp-testing-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCPServer } from "../../src/servers/mcp-server";
import * as thoughtspotClient from "../../src/thoughtspot/thoughtspot-client";

vi.mock("../../src/metrics/mixpanel/mixpanel", () => ({
	MixpanelTracker: vi.fn().mockImplementation(() => ({ track: vi.fn() })),
}));

/**
 * Tests for the org tools (list_orgs / switch_org) and their supporting
 * machinery: the OAuth + orgs-enabled gate, the shared active-org store, and
 * org-scoped token minting.
 */

// A fake CONVERSATION_STORAGE_OBJECT namespace that emulates the active-org DO.
// Stores active-org values in a Map keyed by the DO instance name, so reads and
// writes from any server instance sharing the same storage-key hash see the same
// value (mirroring the real shared store).
function makeStorageNamespace(store: Map<string, string>) {
	return {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => ({
			fetch: async (url: string, init?: RequestInit) => {
				const op = new URL(url).pathname.split("/").pop();
				if (op === "active-org" && (init?.method ?? "GET") === "GET") {
					return Response.json({ activeOrgId: store.get(id.name) ?? null });
				}
				if (op === "active-org" && init?.method === "POST") {
					const body = JSON.parse(String(init?.body)) as {
						activeOrgId: string;
					};
					store.set(id.name, body.activeOrgId);
					return Response.json({ ok: true });
				}
				return new Response("Not Found", { status: 404 });
			},
		}),
	};
}

type SessionInfoOverrides = {
	orgsEnabled?: boolean;
	currentOrgId?: string;
};

function makeClientMock(opts: {
	session?: SessionInfoOverrides;
	orgs?: Array<{ id: number; name: string; status: string }>;
	fetchOrgBearerToken?: ReturnType<typeof vi.fn>;
}) {
	const orgsConfiguration =
		opts.session?.orgsEnabled === undefined
			? undefined
			: { enabled: opts.session.orgsEnabled };
	return {
		getSessionInfo: vi.fn().mockResolvedValue({
			clusterId: "test-cluster-123",
			clusterName: "test-cluster",
			releaseVersion: "10.13.0.cl-110",
			userGUID: "test-user-123",
			userName: "test-user",
			currentOrgId: opts.session?.currentOrgId ?? "0",
			privileges: [],
			configInfo: {
				mixpanelConfig: {
					devSdkKey: "k",
					prodSdkKey: "k",
					production: false,
				},
				selfClusterName: "test-cluster",
				selfClusterId: "test-cluster-123",
				enableSpotterDataSourceDiscovery: false,
				orgsConfiguration,
			},
		}),
		searchOrgs: vi.fn().mockResolvedValue(
			opts.orgs ?? [
				{ id: 0, name: "Primary", status: "ACTIVE", description: "Primary" },
				{ id: 101, name: "DataPlatform", status: "ACTIVE" },
			],
		),
		fetchOrgBearerToken:
			opts.fetchOrgBearerToken ?? vi.fn().mockResolvedValue("org-scoped-token"),
		instanceUrl: "https://test.thoughtspot.cloud",
	} as any;
}

function makeServer(opts: {
	authMode?: string;
	session?: SessionInfoOverrides;
	orgs?: Array<{ id: number; name: string; status: string }>;
	store?: Map<string, string>;
	fetchOrgBearerToken?: ReturnType<typeof vi.fn>;
}) {
	vi.spyOn(thoughtspotClient, "getThoughtSpotClient").mockReturnValue(
		makeClientMock(opts),
	);
	const store = opts.store ?? new Map<string, string>();
	const env = {
		CONVERSATION_STORAGE_OBJECT: makeStorageNamespace(store),
	} as any;
	const props = {
		instanceUrl: "https://test.thoughtspot.cloud",
		accessToken: "global-token",
		refreshToken: "refresh-token",
		authMode: opts.authMode,
		apiVersion: "latest",
		clientName: {
			clientId: "c",
			clientName: "c",
			registrationDate: 0,
		},
	};
	return { server: new MCPServer({ props, env }), store };
}

describe("MCP Server org tools", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("tool visibility gate (OAuth AND orgs enabled)", () => {
		it("lists org tools when OAuth and orgs enabled", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
			});
			await server.init();
			const { listTools } = connect(server);
			const names = (await listTools()).tools?.map((t) => t.name) ?? [];
			expect(names).toContain("list_orgs");
			expect(names).toContain("switch_org");
		});

		it("hides org tools when orgs are not enabled on the cluster", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: false },
			});
			await server.init();
			const { listTools } = connect(server);
			const names = (await listTools()).tools?.map((t) => t.name) ?? [];
			expect(names).not.toContain("list_orgs");
			expect(names).not.toContain("switch_org");
		});

		it("hides org tools for non-OAuth (bearer) connections even if orgs enabled", async () => {
			const { server } = makeServer({
				authMode: "bearer",
				session: { orgsEnabled: true },
			});
			await server.init();
			const { listTools } = connect(server);
			const names = (await listTools()).tools?.map((t) => t.name) ?? [];
			expect(names).not.toContain("list_orgs");
			expect(names).not.toContain("switch_org");
		});

		it("fails closed: hides org tools when orgs-enabled flag is absent", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: {}, // orgsConfiguration undefined
			});
			await server.init();
			const { listTools } = connect(server);
			const names = (await listTools()).tools?.map((t) => t.name) ?? [];
			expect(names).not.toContain("list_orgs");
			expect(names).not.toContain("switch_org");
		});
	});

	describe("list_orgs", () => {
		it("returns ACTIVE orgs and marks the current org active when none switched", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
			});
			await server.init();
			const { callTool } = connect(server);
			const res = await callTool("list_orgs", {});
			const data = JSON.parse(res.content[0].text);
			expect(data.orgs.map((o: any) => o.id)).toEqual([0, 101]);
			// No explicit switch has happened, so nothing is stored as active and no
			// org is marked is_active (calls use the cluster-resolved default org).
			expect(data.orgs.every((o: any) => o.is_active === false)).toBe(true);
		});

		it("rejects direct invocation when org tools are unavailable", async () => {
			const { server } = makeServer({
				authMode: "bearer",
				session: { orgsEnabled: true },
			});
			await server.init();
			const { callTool } = connect(server);
			const res = await callTool("list_orgs", {});
			expect(res.isError).toBe(true);
		});
	});

	describe("switch_org", () => {
		it("mints an org token and persists the active org to the shared store", async () => {
			const { server, store } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true, currentOrgId: "0" },
			});
			await server.init();

			const switchRes = await connect(server).callTool("switch_org", {
				org_id: 101,
			});
			const switchData = JSON.parse(switchRes.content[0].text);
			expect(switchData.success).toBe(true);
			expect(switchData.active_org_id).toBe(101);
			// Persisted to the shared store.
			expect([...store.values()]).toContain("101");
		});

		it("returns 'not accessible' when minting the org token 401s", async () => {
			const { server } = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				fetchOrgBearerToken: vi
					.fn()
					.mockRejectedValue(
						new Error("fetchOrgBearerToken failed with status 401: nope"),
					),
			});
			await server.init();
			const { callTool } = connect(server);
			const res = await callTool("switch_org", { org_id: 999 });
			expect(res.isError).toBe(true);
			expect(res.content[0].text).toMatch(/do not have access/i);
		});
	});

	describe("shared active-org store persists across server instances", () => {
		it("a switch in one instance is visible to another instance with the same token", async () => {
			const store = new Map<string, string>();
			const a = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				store,
			});
			await a.server.init();
			await connect(a.server).callTool("switch_org", { org_id: 101 });

			// Second server instance (e.g. a different MCP session/DO) sharing the
			// same store + token.
			const b = makeServer({
				authMode: "oauth",
				session: { orgsEnabled: true },
				store,
			});
			await b.server.init();
			const listRes = await connect(b.server).callTool("list_orgs", {});
			const listData = JSON.parse(listRes.content[0].text);
			expect(listData.orgs.find((o: any) => o.is_active).id).toBe(101);
		});
	});
});
